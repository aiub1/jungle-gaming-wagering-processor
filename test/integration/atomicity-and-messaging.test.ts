import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import type { Core } from '../../src/composition';
import {
  assertWalletConsistent,
  openWallet,
  purgeQueues,
  queueDepth,
  sendCommand,
  sql,
  sqsEnvelope,
  startCore,
  submit,
  uuid,
  wager,
  waitFor,
} from '../support/harness';

let core: Core;

beforeAll(async () => {
  core = await startCore();
});
beforeEach(async () => {
  core.faults.disarm('wager.before-commit');
  await purgeQueues(core);
});
afterAll(async () => {
  await core.close();
});

async function counts(walletId: string) {
  const [r] = await sql<{ txs: number; entries: number; outbox: number; inbox: number; version: number; balance: string }>(
    core,
    `SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = w.id) AS txs,
            (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = w.id) AS entries,
            (SELECT count(*)::int FROM outbox_messages WHERE group_key = w.id::text) AS outbox,
            (SELECT count(*)::int FROM inbox_messages i WHERE i.message_id LIKE ?) AS inbox,
            w.version, w.balance_amount::text AS balance
       FROM wallets w WHERE w.id = ?`,
    [`%${walletId}%`, walletId],
  );
  return r as NonNullable<typeof r>;
}

async function receiveOne(): Promise<Message> {
  return waitFor(async () => {
    const [m] = await core.sqs.receive(core.config.sqs.commandsQueue, 1, 1, core.config.sqs.visibilityTimeoutSeconds);
    return m;
  });
}

describe('atomicidade wallet + transação + ledger + inbox + outbox', () => {
  test('falha antes do COMMIT (HTTP) → nada persiste', async () => {
    const w = await openWallet(core, '100.00');
    const before = await counts(w.id);
    core.faults.arm('wager.before-commit', 'throw');
    const body = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '30.00', currency: 'BRL' } });
    await expect(submit(core, body)).rejects.toThrow(/fault injected/);
    expect(await counts(w.id)).toEqual(before);

    core.faults.disarm('wager.before-commit');
    const ok = await submit(core, body);
    expect(String(ok.status)).toBe('PROCESSED');
    const after = await counts(w.id);
    expect(after.txs).toBe(before.txs + 1);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.outbox).toBe(before.outbox + 2); // Processed + BalanceChanged
    expect(after.balance).toBe('70.00');
    await assertWalletConsistent(core, w.id);
  });

  test('falha antes do COMMIT (SQS) → nem o inbox persiste; a redelivery processa uma vez', async () => {
    const w = await openWallet(core, '100.00');
    const body = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    const env = sqsEnvelope(body, `msg-${w.id}`);
    await sendCommand(core, env);

    core.faults.arm('wager.before-commit', 'throw');
    const first = await core.consumer.handle(await receiveOne());
    expect(first.type).toBe('retry');
    expect((await counts(w.id)).inbox).toBe(0);
    expect((await counts(w.id)).txs).toBe(1); // só OPENING

    core.faults.disarm('wager.before-commit');
    const second = await core.consumer.handle(await receiveOne()); // volta após o backoff de visibilidade
    expect(second).toEqual({ type: 'ack', outcome: 'PROCESSED' });
    const c = await counts(w.id);
    expect(c.inbox).toBe(1);
    expect(c.entries).toBe(2);
    expect(c.balance).toBe('90.00');
  });
});

describe('inbox e redelivery', () => {
  test('a mesma mensagem entregue de novo (mesmo messageId) não duplica efeito', async () => {
    const w = await openWallet(core, '100.00');
    const env = sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '25.00', currency: 'BRL' } }), `msg-${w.id}`);
    await sendCommand(core, env);
    await sendCommand(core, env); // dedup id diferente: o broker NÃO deduplica
    await sendCommand(core, env);
    for (let i = 0; i < 3; i++) expect((await core.consumer.handle(await receiveOne())).type).toBe('ack');

    const c = await counts(w.id);
    expect(c.inbox).toBe(1);
    expect(c.entries).toBe(2); // abertura + 1 débito
    expect(c.balance).toBe('75.00');
    await assertWalletConsistent(core, w.id);
  });

  test('mesmo messageId com corpo diferente → DLQ (conflito), sem efeito', async () => {
    const w = await openWallet(core, '100.00');
    const messageId = `msg-${w.id}`;
    await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }), messageId));
    await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '2.00', currency: 'BRL' } }), messageId));
    expect((await core.consumer.handle(await receiveOne())).type).toBe('ack');
    expect(await core.consumer.handle(await receiveOne())).toMatchObject({ type: 'dlq', reason: 'INBOX_MESSAGE_CONFLICT' });
    expect((await counts(w.id)).balance).toBe('99.00');
  });

  test('rejeição de negócio é terminal: ack, sem retry', async () => {
    const w = await openWallet(core, '5.00');
    await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '50.00', currency: 'BRL' } })));
    expect(await core.consumer.handle(await receiveOne())).toEqual({ type: 'ack', outcome: 'REJECTED' });
    expect(await queueDepth(core, core.config.sqs.commandsQueue)).toEqual({ visible: 0, inFlight: 0 });
  });
});

describe('retry e DLQ', () => {
  test.each([
    ['JSON inválido', '{not json', 'INVALID_JSON'],
    ['tipo desconhecido', JSON.stringify({ messageId: 'm', type: 'Other', data: {} }), 'UNSUPPORTED_TYPE'],
    ['payload inválido', JSON.stringify({ messageId: 'm2', type: 'WagerTransactionRequested', data: { kind: 'OPENING' } }), 'INVALID_INPUT'],
  ])('%s → DLQ imediata (permanente)', async (_name, body, reason) => {
    await core.sqs.send(core.config.sqs.commandsQueue, body, 'g', uuid());
    expect(await core.consumer.handle(await receiveOne())).toMatchObject({ type: 'dlq', reason });
    const dlq = await waitFor(async () => (await core.sqs.receive(core.config.sqs.commandsDlq, 1, 1, 5))[0]);
    expect(dlq.Body).toBe(body);
    expect(dlq.MessageAttributes?.failureReason?.StringValue).toBe(reason);
  });

  test('wallet inexistente → DLQ (permanente)', async () => {
    const body = wager({ walletId: uuid(), playerId: uuid(), kind: 'BET', money: { amount: '1.00', currency: 'BRL' } });
    await sendCommand(core, sqsEnvelope(body));
    expect(await core.consumer.handle(await receiveOne())).toMatchObject({ type: 'dlq', reason: 'WALLET_NOT_FOUND' });
  });

  test('falha transitória: retry com backoff até o limite, depois DLQ — sem efeito parcial', async () => {
    const w = await openWallet(core, '100.00');
    await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } })));
    core.faults.arm('wager.before-commit', 'throw');
    const dispositions = [];
    for (let i = 0; i < core.config.sqs.maxReceiveCount; i++) dispositions.push((await core.consumer.handle(await receiveOne())).type);
    expect(dispositions).toEqual(['retry', 'retry', 'dlq']);
    expect((await counts(w.id)).balance).toBe('100.00');
    const dlq = await waitFor(async () => (await core.sqs.receive(core.config.sqs.commandsDlq, 1, 1, 5))[0]);
    expect(dlq.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
  });
});

describe('consumidor em execução', () => {
  test('start/stop: processa mensagens de várias wallets e para graciosamente', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(core, '100.00')));
    for (const w of wallets) {
      for (let i = 0; i < 3; i++) {
        await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } })));
      }
    }
    core.consumer.start();
    try {
      await waitFor(async () => {
        const [r] = await sql<{ n: number }>(
          core,
          `SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND wallet_id = ANY(?::uuid[])`,
          [`{${wallets.map((w) => w.id).join(',')}}`],
        );
        return r?.n === 15;
      });
    } finally {
      await core.consumer.stop();
    }
    for (const w of wallets) expect((await assertWalletConsistent(core, w.id)).balance).toBe('70.00');
  });
});
