import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/composition';
import {
  type AppProcess,
  assertWalletConsistent,
  post,
  purgeQueues,
  sendCommand,
  spawnApp,
  sql,
  sqsEnvelope,
  startCore,
  uuid,
  wager,
  waitFor,
} from '../support/harness';

/**
 * Paralelismo REAL: 3 processos `bun src/main.ts` independentes (cada um com
 * seu pool, consumidor SQS, publisher e worker), todos sobre o mesmo
 * PostgreSQL e a mesma fila. Nenhum mock.
 */
let apps: AppProcess[] = [];
let core: Core; // só para asserts diretos no banco

beforeAll(async () => {
  core = await startCore();
  await purgeQueues(core);
  apps = await Promise.all([spawnApp(), spawnApp(), spawnApp()]);
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.kill()));
  await core.close();
});

const pick = (i: number) => apps[i % apps.length] as AppProcess;

async function newWallet(amount: string) {
  const res = await post(pick(Math.floor(Math.random() * 3)).url, '/wallets', { playerId: uuid(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

const submitVia = (i: number, body: ReturnType<typeof wager>) =>
  post(pick(i).url, '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

async function ledgerDebits(walletId: string) {
  const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]);
  return r?.n ?? 0;
}

describe('concorrência entre 3 instâncias', () => {
  test('1. a mesma aposta 50x em paralelo → um único débito, 49 replays idênticos', async () => {
    const w = await newWallet('100.00');
    const body = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitVia(i, body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 200).length).toBe(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true); // saldo observado original
    expect(await ledgerDebits(w.id)).toBe(1);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('90.00');
  });

  test('2. cenário obrigatório: saldo 100, duas apostas de 80 simultâneas (repetido 25x)', async () => {
    for (let round = 0; round < 25; round++) {
      const w = await newWallet('100.00');
      const bets = [0, 1].map(() => wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '80.00', currency: 'BRL' } }));
      const [r1, r2] = await Promise.all(bets.map((b, i) => submitVia(round + i, b)));
      const outcomes = [r1?.body, r2?.body].map((b) => `${b.status}:${b.failureCode ?? ''}`).sort();
      expect(outcomes).toEqual(['PROCESSED:', 'REJECTED:INSUFFICIENT_FUNDS']);
      expect(await ledgerDebits(w.id)).toBe(1);
      expect((await assertWalletConsistent(core, w.id)).balance).toBe('20.00');
      // nenhum retry duplica o débito
      await Promise.all(bets.map((b, i) => submitVia(i + 1, b)));
      expect(await ledgerDebits(w.id)).toBe(1);
    }
  });

  test('3. hot wallet: 40 apostas distintas de 10.00 sobre 100.00 → exatamente 10 aplicadas, saldo 0, nunca negativo', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        submitVia(i, wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } })),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBe(10);
    expect(results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS').length).toBe(30);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('0.00');
    const [neg] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND balance_after < 0`, [w.id]);
    expect(neg?.n).toBe(0);
  });

  test('4. wallets distintas em paralelo (HTTP + SQS misturados) — todas consistentes', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet('1000.00')));
    const ops: Promise<unknown>[] = [];
    wallets.forEach((w, wi) => {
      for (let i = 0; i < 10; i++) {
        const body = wager({ walletId: w.id, playerId: w.playerId, kind: i % 3 === 2 ? 'WIN' : 'BET', money: { amount: '7.35', currency: 'BRL' } });
        ops.push(i % 2 === 0 ? submitVia(wi + i, body) : sendCommand(core, sqsEnvelope(body)));
      }
    });
    await Promise.all(ops);
    await waitFor(async () => {
      const [r] = await sql<{ n: number }>(
        core,
        `SELECT count(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING' AND wallet_id = ANY(?::uuid[])`,
        [`{${wallets.map((w) => w.id).join(',')}}`],
      );
      return r?.n === 200;
    }, 60_000);
    for (const w of wallets) {
      // 10 ops: índices 2,5,8 são WIN (+7.35), 7 são BET (−7.35) → 1000 − 4×7.35 = 970.60
      expect((await assertWalletConsistent(core, w.id)).balance).toBe('970.60');
    }
  });

  test('5. SQS: duplicatas entregues a instâncias diferentes não duplicam efeito', async () => {
    const w = await newWallet('500.00');
    const envelopes = Array.from({ length: 15 }, () =>
      sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } })),
    );
    // cada mensagem é enviada 3 vezes (redelivery simulada), intercaladas
    for (let copy = 0; copy < 3; copy++) for (const env of envelopes) await sendCommand(core, env);
    await waitFor(async () => {
      const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ANY(?)`, [
        `{${envelopes.map((e) => e.messageId).join(',')}}`,
      ]);
      const depth = await core.sqs.receive(core.config.sqs.commandsQueue, 1, 0, 0);
      return r?.n === 15 && depth.length === 0;
    }, 60_000);
    await Bun.sleep(500);
    expect(await ledgerDebits(w.id)).toBe(15);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('350.00');
  });

  test('7. REFUND entregue antes do BET (via instâncias diferentes) é resolvido pelo worker', async () => {
    const w = await newWallet('100.00');
    const bet = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '60.00', currency: 'BRL' } });
    const refund = wager({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'REFUND',
      money: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const r = await submitVia(0, refund);
    expect(r.status).toBe(202);
    await sendCommand(core, sqsEnvelope(bet));
    await waitFor(async () => (await core.queries.transaction(r.body.transactionId)).status === 'PROCESSED', 30_000);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('100.00');
  });

  test('6. outbox drenada pelos 3 publishers sem duplicar: todo evento publicado exatamente uma vez na tabela', async () => {
    await waitFor(async () => {
      const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
      return r?.n === 0;
    }, 30_000);
    const [owners] = await sql<{ n: number }>(core, `SELECT count(DISTINCT locked_by)::int AS n FROM outbox_messages WHERE locked_by IS NOT NULL`);
    expect(owners?.n).toBe(0); // nenhuma lease pendurada
  });
});
