import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/composition';
import {
  assertWalletConsistent,
  openWallet,
  purgeQueues,
  sql,
  startCore,
  submit,
  wager,
  waitFor,
} from '../support/harness';

let a: Core;
let b: Core;

/** Marca como publicadas as pendências de outros testes, para isolar as contagens. */
async function drainBacklog(core: Core) {
  await sql(core, `UPDATE outbox_messages SET published_at = now(), locked_by = NULL, locked_until = NULL WHERE published_at IS NULL`);
  await purgeQueues(core);
}

async function readAllEvents(core: Core, expected: number): Promise<Array<{ eventId: string; eventType: string }>> {
  const seen: Array<{ eventId: string; eventType: string }> = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const batch = await core.sqs.receive(core.config.sqs.eventsQueue, 10, 1, 30);
    for (const m of batch) {
      seen.push(JSON.parse(m.Body ?? '{}'));
      await core.sqs.delete(core.config.sqs.eventsQueue, m);
    }
    if (batch.length === 0 && seen.length >= expected) break;
  }
  return seen;
}

beforeAll(async () => {
  // Duas "instâncias": dois pools de conexão independentes e dois owners de lease.
  // lote pequeno para forçar os dois publishers a disputarem a mesma outbox
  a = await startCore({ OUTBOX_LEASE_MS: '1500', OUTBOX_BATCH_SIZE: '5' });
  b = await startCore({ OUTBOX_LEASE_MS: '1500', OUTBOX_BATCH_SIZE: '5' });
});
beforeEach(async () => {
  await drainBacklog(a);
});
afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});

describe('transactional outbox', () => {
  test('dois publishers concorrentes sobre a mesma outbox: todos publicados, nenhum duplicado', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => openWallet(a, '10.00')));
    const expected = wallets.length * 2; // Processed(OPENING) + BalanceChanged

    const loop = async (core: Core) => {
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const n = await core.publisher.publishOnce();
        total += n;
        if (n === 0) {
          const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
          if (r?.n === 0) break;
        }
      }
      return total;
    };
    const [byA, byB] = await Promise.all([loop(a), loop(b)]);
    expect(byA + byB).toBe(expected);
    expect(byA).toBeGreaterThan(0);
    expect(byB).toBeGreaterThan(0);

    const events = await readAllEvents(a, expected);
    expect(events.length).toBe(expected);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(expected);
  });

  test('commit confirmado → processo morre antes de publicar → outra instância publica após a lease', async () => {
    const w = await openWallet(a, '10.00');
    // A reivindica (claim) e "morre": nunca publica nem devolve a lease.
    const claimed = await a.outboxStore.claim('dead-instance', 100, 1500);
    expect(claimed.length).toBe(2);
    expect(await b.publisher.publishOnce()).toBe(0); // lease ainda válida: B não rouba
    await Bun.sleep(1600);
    expect(await b.publisher.publishOnce()).toBe(2);
    const events = await readAllEvents(b, 2);
    expect(events.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.every((e) => (e as unknown as { aggregateId: string }).aggregateId)).toBe(true);
    await assertWalletConsistent(a, w.id);
  });

  test('publicou e morreu antes de marcar → republicação com o MESMO eventId (seguro para o consumidor)', async () => {
    await openWallet(a, '10.00');
    a.faults.arm('outbox.after-publish-before-mark', 'throw');
    try {
      // publica no SQS e "morre" antes do UPDATE published_at: a lease fica presa
      await expect(a.publisher.publishOnce()).rejects.toThrow(/fault injected/);
    } finally {
      a.faults.disarm('outbox.after-publish-before-mark');
    }
    expect(await b.publisher.publishOnce()).toBe(0); // lease ainda válida
    await Bun.sleep(1600); // lease expira
    expect(await b.publisher.publishOnce()).toBe(2); // republica
    const events = await readAllEvents(a, 2);
    // o broker FIFO deduplica pelo eventId (MessageDeduplicationId) na janela de 5 min;
    // fora dela chegaria duplicado e o consumidor deduplica pelo eventId do envelope.
    expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
  });

  test('SQS indisponível → retry com backoff, sem perder o evento', async () => {
    await openWallet(a, '1.00');
    const original = a.sqs.sendBatch.bind(a.sqs);
    a.sqs.sendBatch = async () => {
      throw new Error('sqs down');
    };
    try {
      expect(await a.publisher.publishOnce()).toBe(0);
    } finally {
      a.sqs.sendBatch = original;
    }
    const [row] = await sql<{ attempts: number; err: string }>(
      a,
      `SELECT max(attempts)::int AS attempts, max(last_error) AS err FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(row?.attempts).toBe(1);
    expect(row?.err).toContain('sqs down');
    await sql(a, `UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`);
    expect(await a.publisher.publishOnce()).toBe(2);
  });
});

describe('referências fora de ordem', () => {
  test('ROLLBACK antes do BET: PENDING_REFERENCE → BET chega → worker aplica → saldo correto', async () => {
    const w = await openWallet(a, '100.00');
    const bet = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '40.00', currency: 'BRL' } });
    const rollback = wager({
      walletId: w.id,
      playerId: w.playerId,
      kind: 'ROLLBACK',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await submit(a, rollback);
    expect(String(pending.status)).toBe('PENDING_REFERENCE');
    expect(pending.balance.amount).toBe('100.00');

    expect(String((await submit(a, bet)).status)).toBe('PROCESSED');
    await waitFor(async () => {
      await a.pendingReferences.runOnce();
      return (await a.queries.transaction(pending.transactionId)).status === 'PROCESSED';
    });
    const tx = await a.queries.transaction(pending.transactionId);
    expect(tx.referenceTransactionId).toBeDefined();
    expect((await assertWalletConsistent(a, w.id)).balance).toBe('100.00');
    // replay do ROLLBACK agora devolve o resultado decidido
    expect(await submit(a, rollback)).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('referência nunca chega → REJECTED REFERENCE_NOT_FOUND após o limite, com evento', async () => {
    const w = await openWallet(a, '100.00');
    const refund = await submit(
      a,
      wager({ walletId: w.id, playerId: w.playerId, kind: 'REFUND', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: 'never' }),
    );
    await waitFor(async () => {
      await a.pendingReferences.runOnce();
      return (await a.queries.transaction(refund.transactionId)).status === 'REJECTED';
    }, 15_000);
    const tx = await a.queries.transaction(refund.transactionId);
    expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(tx.referenceAttempts).toBe(a.config.pendingReferences.maxAttempts - 1);
    const [ev] = await sql<{ n: number }>(
      a,
      `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`,
      [refund.transactionId],
    );
    expect(ev?.n).toBe(1);
    expect((await assertWalletConsistent(a, w.id)).balance).toBe('100.00');
  });

  test('dois workers concorrentes no mesmo pendente aplicam uma única vez', async () => {
    const w = await openWallet(a, '100.00');
    const bet = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    await submit(a, wager({ ...bet, externalTransactionId: `r-${bet.externalTransactionId}`, kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }));
    await submit(a, bet);
    await Promise.all([a.pendingReferences.runOnce(), b.pendingReferences.runOnce(), a.pendingReferences.runOnce()]);
    const [r] = await sql<{ n: number }>(a, `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id]);
    expect(r?.n).toBe(3); // abertura + BET + REFUND
    expect((await assertWalletConsistent(a, w.id)).balance).toBe('100.00');
  });
});

describe('recuperação após reinicialização', () => {
  test('outbox pendente e PENDING_REFERENCE de uma instância morta são concluídos por uma instância nova', async () => {
    const dead = await startCore();
    const w = await openWallet(dead, '50.00');
    const bet = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '20.00', currency: 'BRL' } });
    await submit(dead, wager({ ...bet, externalTransactionId: `rb-${bet.externalTransactionId}`, kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId }));
    await submit(dead, bet);
    await dead.outboxStore.claim(dead.config.instanceId, 100, 60_000); // lease longa, "trava" e morre
    await dead.orm.close(true); // processo some sem liberar nada

    // a lease longa expira (simulado) e uma instância nova assume tudo
    await sql(a, `UPDATE outbox_messages SET locked_until = now() - interval '1 second' WHERE locked_by = ?`, [dead.config.instanceId]);
    const fresh = await startCore();
    try {
      fresh.startWorkers();
      await waitFor(async () => {
        const [r] = await sql<{ pending: number; outbox: number }>(
          fresh,
          `SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ? AND status = 'PENDING_REFERENCE') AS pending,
                  (SELECT count(*)::int FROM outbox_messages WHERE group_key = ? AND published_at IS NULL) AS outbox`,
          [w.id, w.id],
        );
        return r?.pending === 0 && r?.outbox === 0;
      });
    } finally {
      await fresh.close();
    }
    expect((await assertWalletConsistent(a, w.id)).balance).toBe('50.00');
  });
});
