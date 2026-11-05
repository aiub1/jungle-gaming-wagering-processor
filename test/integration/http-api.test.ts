import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, post, spawnApp, uuid } from '../support/harness';

/** Contrato HTTP contra uma instância REAL (processo `bun src/main.ts`). */
let app: AppProcess;

beforeAll(async () => {
  app = await spawnApp({ APP_ROLE: 'api' });
});
afterAll(async () => {
  await app.kill();
});

const get = async (path: string) => {
  const res = await fetch(`${app.url}${path}`);
  // biome-ignore lint: corpo dinâmico nos testes
  const body: any = await res.json();
  return { status: res.status, body };
};

async function newWallet(amount = '100.00') {
  const res = await post(app.url, '/wallets', { playerId: uuid(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string }; version: number };
}

function bet(w: { id: string; playerId: string }, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}
const key = (b: { providerId: string; externalTransactionId: string }) => ({ 'Idempotency-Key': `${b.providerId}:${b.externalTransactionId}` });

describe('wallets', () => {
  test('cria com version 1; duplicada (player + moeda) → 409', async () => {
    const w = await newWallet('1000.00');
    expect(w).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const dup = await post(app.url, '/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('payload inválido → 400 com campo', async () => {
    const res = await post(app.url, '/wallets', { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT', field: 'initialBalance.amount', retryable: false });
    const malformed = await fetch(`${app.url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
  });

  test('GET wallet / 404', async () => {
    const w = await newWallet();
    expect((await get(`/wallets/${w.id}`)).body).toMatchObject({ id: w.id, version: 1 });
    expect((await get(`/wallets/${uuid()}`)).status).toBe(404);
    expect((await get('/wallets/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /wagering/transactions — mapeamento de status', () => {
  test('201 processado, 200 replay idêntico, 409 conflito, 422 rejeição, 202 pendente', async () => {
    const w = await newWallet('100.00');
    const b = bet(w, '25.00');
    const first = await post(app.url, '/wagering/transactions', b, key(b));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });

    const replay = await post(app.url, '/wagering/transactions', b, key(b));
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await post(app.url, '/wagering/transactions', { ...b, money: { amount: '26.00', currency: 'BRL' } }, key(b));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', transactionId: first.body.transactionId });

    const tooBig = bet(w, '500.00');
    const rejected = await post(app.url, '/wagering/transactions', tooBig, key(tooBig));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '75.00' } });
    // replay de rejeição devolve a MESMA rejeição
    expect((await post(app.url, '/wagering/transactions', tooBig, key(tooBig))).status).toBe(422);

    const rb = bet(w, '10.00', { kind: 'ROLLBACK', referenceExternalTransactionId: 'not-arrived' });
    const pending = await post(app.url, '/wagering/transactions', rb, key(rb));
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
  });

  test('400 sem Idempotency-Key, OPENING proibido, moeda com 3 casas', async () => {
    const w = await newWallet();
    const b = bet(w, '1.00');
    expect((await post(app.url, '/wagering/transactions', b)).status).toBe(400);
    expect((await post(app.url, '/wagering/transactions', { ...b, kind: 'OPENING' }, key(b))).status).toBe(400);
    expect((await post(app.url, '/wagering/transactions', { ...b, money: { amount: '1.005', currency: 'BRL' } }, key(b))).status).toBe(400);
  });

  test('404 wallet inexistente; 422 CURRENCY_MISMATCH', async () => {
    const w = await newWallet();
    const ghost = bet({ id: uuid(), playerId: w.playerId }, '1.00');
    expect((await post(app.url, '/wagering/transactions', ghost, key(ghost))).status).toBe(404);
    const usd = bet(w, '1.00', { money: { amount: '1.00', currency: 'USD' } });
    const res = await post(app.url, '/wagering/transactions', usd, key(usd));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });
});

describe('consultas', () => {
  test('transação por id e por (provider, externalId)', async () => {
    const w = await newWallet();
    const b = bet(w, '5.00');
    const { body } = await post(app.url, '/wagering/transactions', b, key(b));
    const byId = await get(`/wagering/transactions/${body.transactionId}`);
    expect(byId.body).toMatchObject({ id: body.transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '5.00' } });
    const byExt = await get(`/providers/provider-a/wagering/transactions/${b.externalTransactionId}`);
    expect(byExt.body.id).toBe(body.transactionId);
    expect((await get(`/providers/provider-b/wagering/transactions/${b.externalTransactionId}`)).status).toBe(404);
  });

  test('ledger paginado com cursor opaco e estável', async () => {
    const w = await newWallet('100.00');
    for (let i = 0; i < 5; i++) {
      const b = bet(w, '1.00');
      await post(app.url, '/wagering/transactions', b, key(b));
    }
    const page1 = await get(`/wallets/${w.id}/ledger?limit=4`);
    expect(page1.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    // novos lançamentos não deslocam a próxima página
    const extra = bet(w, '1.00');
    await post(app.url, '/wagering/transactions', extra, key(extra));
    const page2 = await get(`/wallets/${w.id}/ledger?limit=4&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([5, 6, 7]);
    expect(page2.body.nextCursor).toBeNull();
    expect((await get(`/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await get(`/wallets/${w.id}/ledger?limit=1000`)).status).toBe(400);
  });

  test('reconciliação', async () => {
    const w = await newWallet('100.00');
    const b = bet(w, '25.00');
    await post(app.url, '/wagering/transactions', b, key(b));
    const res = await post(app.url, `/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId: w.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('operação', () => {
  test('health live/ready sem autenticação; métricas Prometheus', async () => {
    expect((await get('/health/live')).body.status).toBe('ok');
    const ready = await get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { ok: true }, sqs: { ok: true } });
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_processing_duration_seconds',
    ]) {
      expect(metrics).toContain(name);
    }
  });

  test('logs estruturados com correlationId propagado e sem payload financeiro', async () => {
    const w = await newWallet();
    const b = bet(w, '3.00');
    const correlationId = `corr-${uuid()}`;
    await post(app.url, '/wagering/transactions', b, { ...key(b), 'X-Correlation-Id': correlationId });
    await Bun.sleep(100);
    const line = app.logs
      .join('')
      .split('\n')
      .find((l) => l.includes(correlationId) && l.includes('wager submitted'));
    expect(line).toBeDefined();
    const log = JSON.parse(line as string);
    expect(log).toMatchObject({ correlationId, walletId: w.id, providerId: 'provider-a', level: 'info' });
    expect(log.transactionId).toBeDefined();
    expect(line).not.toContain('"amount"');
  });
});
