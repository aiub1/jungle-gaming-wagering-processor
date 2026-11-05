import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/composition';
import {
  type AppProcess,
  assertWalletConsistent,
  openWallet,
  post,
  purgeQueues,
  queueDepth,
  sendCommand,
  spawnApp,
  sql,
  sqsEnvelope,
  startCore,
  uuid,
  wager,
  waitFor,
} from '../support/harness';

/** Morte REAL de processo (SIGKILL) em pontos críticos, e recuperação por outra instância. */
let core: Core;
const running: AppProcess[] = [];

async function spawn(env: Record<string, string> = {}, waitReady = true) {
  const app = await spawnApp(env, waitReady);
  running.push(app);
  return app;
}

beforeAll(async () => {
  core = await startCore();
});
beforeEach(async () => {
  await purgeQueues(core);
  await sql(core, `UPDATE outbox_messages SET published_at = now(), locked_by = NULL, locked_until = NULL WHERE published_at IS NULL`);
});
afterAll(async () => {
  await Promise.all(running.map((a) => a.kill('SIGKILL')));
  await core.close();
});

describe('crash e recuperação', () => {
  test('5. worker morto DEPOIS do commit e ANTES do ack → redelivery não duplica o efeito', async () => {
    const w = await openWallet(core, '100.00');
    const env = sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '30.00', currency: 'BRL' } }));

    const doomed = await spawn({ APP_ROLE: 'worker', FAULTS: 'sqs.after-commit-before-ack:kill' });
    await sendCommand(core, env);
    const exitCode = await doomed.proc.exited; // morre sozinho no ponto injetado
    expect(exitCode).not.toBe(0);

    // o commit aconteceu…
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('70.00');
    // …mas o ack não: a mensagem continua na fila
    const depth = await queueDepth(core, core.config.sqs.commandsQueue);
    expect(depth.visible + depth.inFlight).toBe(1);

    // outra instância recebe a mesma mensagem após o visibility timeout
    const survivor = await spawn({ APP_ROLE: 'worker' });
    await waitFor(async () => {
      const d = await queueDepth(core, core.config.sqs.commandsQueue);
      return d.visible + d.inFlight === 0;
    }, 30_000);
    expect(survivor.logs.join('')).toContain('"duplicate":true');
    const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id]);
    expect(r?.n).toBe(2); // abertura + um único débito
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('70.00');
    await survivor.kill();
  });

  test('publisher morto com a lease → outra instância publica após a lease expirar', async () => {
    const doomed = await spawn({ APP_ROLE: 'all', FAULTS: 'outbox.after-claim-before-publish:kill', OUTBOX_LEASE_MS: '2000' });
    const res = await post(doomed.url, '/wallets', { playerId: uuid(), initialBalance: { amount: '10.00', currency: 'BRL' } });
    expect(res.status).toBe(201); // commit confirmado
    await doomed.proc.exited; // publisher reivindicou e morreu

    const [held] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [res.body.id]);
    expect(held?.n).toBe(1); // WalletBalanceChanged travado pela lease morta (aggregate = wallet)

    const survivor = await spawn({ APP_ROLE: 'worker' });
    await waitFor(async () => {
      const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM outbox_messages WHERE group_key = ? AND published_at IS NULL`, [res.body.id]);
      return r?.n === 0;
    }, 20_000);
    await survivor.kill();
  });

  test('SIGTERM: termina o que está em andamento e sai com código 0; nada se perde', async () => {
    const w = await openWallet(core, '1000.00');
    const worker = await spawn({ APP_ROLE: 'worker' });
    for (let i = 0; i < 20; i++) {
      await sendCommand(core, sqsEnvelope(wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } })));
    }
    await Bun.sleep(300);
    expect(await worker.kill('SIGTERM')).toBe(0);
    expect(worker.logs.join('')).toContain('graceful shutdown complete');

    const finisher = await spawn({ APP_ROLE: 'worker' });
    await waitFor(async () => {
      const [r] = await sql<{ n: number }>(core, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [w.id]);
      return r?.n === 20;
    }, 30_000);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('980.00');
    await finisher.kill();
  });

  test('8. reinício do serviço sob carga (SIGKILL de 1 de 3 instâncias) → consistência final comprovada', async () => {
    const apps = await Promise.all([spawn(), spawn(), spawn()]);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(core, '500.00')));
    const bodies = wallets.flatMap((w) =>
      Array.from({ length: 12 }, (_, i) =>
        wager({ walletId: w.id, playerId: w.playerId, kind: i % 4 === 3 ? 'WIN' : 'BET', money: { amount: '5.50', currency: 'BRL' } }),
      ),
    );

    // carga mista: metade HTTP (round-robin), metade SQS; no meio, SIGKILL na instância 0
    const load = bodies.map(async (body, i) => {
      if (i % 2 === 0) {
        const app = apps[i % 3] as AppProcess;
        const res = await post(app.url, '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` }).catch(
          () => undefined,
        );
        // cliente reenvia o que falhou (conexão caiu / 503) em outra instância: idempotência garante efeito único
        if (!res || res.status >= 500) {
          await post((apps[1] as AppProcess).url, '/wagering/transactions', body, {
            'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
          });
        }
      } else {
        await sendCommand(core, sqsEnvelope(body));
      }
    });
    await Bun.sleep(150);
    await (apps[0] as AppProcess).kill('SIGKILL');
    await Promise.all(load);
    const restarted = await spawn(); // "reinício" da instância morta

    await waitFor(async () => {
      const [r] = await sql<{ txs: number; outbox: number; pending: number }>(
        core,
        `SELECT (SELECT count(*)::int FROM wager_transactions WHERE kind <> 'OPENING' AND wallet_id = ANY(?::uuid[])) AS txs,
                (SELECT count(*)::int FROM outbox_messages WHERE published_at IS NULL) AS outbox,
                (SELECT count(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND wallet_id = ANY(?::uuid[])) AS pending`,
        [`{${wallets.map((w) => w.id).join(',')}}`, `{${wallets.map((w) => w.id).join(',')}}`],
      );
      return r?.txs === bodies.length && r.outbox === 0 && r.pending === 0;
    }, 60_000);

    for (const w of wallets) {
      // 12 ops: 3 WIN (+5.50), 9 BET (−5.50) → 500 − 6×5.50 = 467.00
      expect((await assertWalletConsistent(core, w.id)).balance).toBe('467.00');
    }
    const [dups] = await sql<{ n: number }>(
      core,
      `SELECT count(*)::int AS n FROM (SELECT transaction_id FROM wallet_ledger_entries GROUP BY transaction_id HAVING count(*) > 1) d`,
    );
    expect(dups?.n).toBe(0);
    await Promise.all([apps[1], apps[2], restarted].map((a) => (a as AppProcess).kill()));
  });
});
