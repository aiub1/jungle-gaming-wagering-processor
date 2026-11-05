import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/composition';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm';
import { assertWalletConsistent, openWallet, sql, startCore, submit, uuid, wager } from '../support/harness';

/**
 * As garantias da seção 6 estão no SCHEMA: estes testes escrevem direto no
 * banco (sem passar pela aplicação) e conferem que o PostgreSQL recusa.
 */
let core: Core;

beforeAll(async () => {
  core = await startCore();
});
afterAll(async () => {
  await core.close();
});

async function expectSqlError(query: string, params: unknown[], match: RegExp | string) {
  let error: unknown;
  try {
    await core.orm.em.fork().transactional(async (em) => {
      await em.execute(query, params);
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  const { code, constraint, message } = error as { code?: string; constraint?: string; message: string };
  expect(`${code} ${constraint ?? ''} ${message}`).toMatch(match);
}

describe('migrations', () => {
  test('são reversíveis: down → up recria o schema', async () => {
    const orm = await createOrm(core.config.databaseUrl, 2);
    try {
      const executed = await orm.migrator.getExecuted();
      expect(executed.map((m) => m.name)).toContain('Migration20261106000001InitialSchema');
      // não derruba o banco compartilhado pelos outros testes: valida o down
      // num schema temporário com o MESMO SQL da migration
      await orm.em.fork().execute('DROP SCHEMA IF EXISTS migration_check CASCADE; CREATE SCHEMA migration_check');
      const { Migration20261106000001InitialSchema } = await import(
        '../../src/infrastructure/persistence/migrations/Migration20261106000001InitialSchema'
      );
      const run = async (direction: 'up' | 'down') => {
        const m = new Migration20261106000001InitialSchema(orm.em.getDriver() as never, orm.config as never);
        await m[direction]();
        await orm.em.fork().transactional(async (em) => {
          await em.execute('SET LOCAL search_path TO migration_check');
          for (const q of m.getQueries()) await em.execute(q as string);
        });
      };
      await run('up');
      const tables = async () =>
        (
          await orm.em.fork().execute<{ table_name: string }[]>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'migration_check' ORDER BY 1`,
          )
        ).map((r) => r.table_name);
      expect(await tables()).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
      await run('down');
      expect(await tables()).toEqual([]);
      await run('up');
      expect((await tables()).length).toBe(5);
    } finally {
      await orm.em.fork().execute('DROP SCHEMA IF EXISTS migration_check CASCADE');
      await orm.close(true);
    }
  });
});

describe('constraints de dinheiro', () => {
  const insertWallet = `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
                        VALUES (?, ?, 'BRL', ?, 1, now(), now())`;

  test('saldo negativo é recusado pelo banco', async () => {
    await expectSqlError(insertWallet, [uuid(), uuid(), '-0.01'], /23514.*money_amount_valid/);
  });

  test('3 casas decimais são RECUSADAS (não arredondadas)', async () => {
    await expectSqlError(insertWallet, [uuid(), uuid(), '10.005'], /23514/);
    await expectSqlError(insertWallet, [uuid(), uuid(), '10.5'], /23514/); // escala fixa 2
  });

  test('NaN e Infinity são recusados', async () => {
    await expectSqlError(insertWallet, [uuid(), uuid(), 'NaN'], /23514/);
    await expectSqlError(insertWallet, [uuid(), uuid(), 'Infinity'], /23514/);
  });

  test('moeda fora do padrão ISO é recusada', async () => {
    await expectSqlError(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, 'brl', '1.00', 1, now(), now())`,
      [uuid(), uuid()],
      /23514.*currency_code/,
    );
  });
});

describe('unicidade', () => {
  test('uma wallet por player + moeda', async () => {
    const w = await openWallet(core, '0.00');
    await expectSqlError(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, 'BRL', '0.00', 1, now(), now())`,
      [uuid(), w.playerId],
      /23505.*wallets_player_currency_uq/,
    );
    // outra moeda para o mesmo player é permitido (modelo multi-moeda)
    const usd = await openWallet(core, '0.00', 'USD', w.playerId);
    expect(usd.balance.currency).toBe('USD');
  });

  test('idempotency key e external id únicos por provider', async () => {
    const w = await openWallet(core);
    const body = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } });
    const res = await submit(core, body);
    const dup = (col: string, value: string) =>
      expectSqlError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at, updated_at, result_balance_amount, processed_at)
         SELECT ?, provider_id, ${col === 'key' ? `'other-ext'` : 'external_transaction_id'}, ${col === 'key' ? 'idempotency_key' : `'other-key'`},
                payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, now(), now(), result_balance_amount, now()
           FROM wager_transactions WHERE id = ?`,
        [uuid(), value],
        col === 'key' ? /wager_tx_provider_idempotency_uq/ : /wager_tx_provider_external_uq/,
      );
    await dup('key', res.transactionId);
    await dup('ext', res.transactionId);
  });

  test('um lançamento por (wallet, transação) e por (wallet, versão)', async () => {
    const w = await openWallet(core, '10.00');
    const [entry] = await sql(core, `SELECT * FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id]);
    await expectSqlError(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 2, 'CREDIT', '1.00', 'BRL', '10.00', '11.00', now())`,
      [uuid(), w.id, entry?.transaction_id],
      /ledger_one_entry_per_tx_wallet_uq/,
    );
  });

  test('uma referência só pode ser revertida uma vez (índice único parcial)', async () => {
    const w = await openWallet(core, '50.00');
    const bet = wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    await submit(core, bet);
    const refund = await submit(
      core,
      wager({ walletId: w.id, playerId: w.playerId, kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(String(refund.status)).toBe('PROCESSED');
    await expectSqlError(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
         result_balance_amount, created_at, updated_at, processed_at)
       SELECT ?, provider_id, 'rb-x', 'rb-x', payload_hash, wallet_id, player_id, round_id, game_id, 'ROLLBACK', amount, currency,
              reference_external_transaction_id, reference_transaction_id, 'PROCESSED', result_balance_amount, now(), now(), now()
         FROM wager_transactions WHERE id = ?`,
      [uuid(), refund.transactionId],
      /wager_tx_single_reversal_uq/,
    );
  });
});

describe('imutabilidade', () => {
  test('ledger é append-only: UPDATE, DELETE e TRUNCATE recusados', async () => {
    const w = await openWallet(core, '10.00');
    await expectSqlError(`UPDATE wallet_ledger_entries SET amount = '99.00' WHERE wallet_id = ?`, [w.id], /append-only/);
    await expectSqlError(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id], /append-only/);
    await expectSqlError(`TRUNCATE wallet_ledger_entries CASCADE`, [], /append-only/);
  });

  test('transação terminal não muda; colunas de identidade nunca mudam; nada é apagado', async () => {
    const w = await openWallet(core, '10.00');
    const res = await submit(core, wager({ walletId: w.id, playerId: w.playerId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }));
    await expectSqlError(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [res.transactionId], /terminal/);
    await expectSqlError(`DELETE FROM wager_transactions WHERE id = ?`, [res.transactionId], /cannot be deleted/);
  });

  test('ledger desbalanceado é recusado', async () => {
    const w = await openWallet(core, '0.00');
    await expectSqlError(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 2, 'CREDIT', '1.00', 'BRL', '0.00', '2.00', now())`,
      [uuid(), w.id, uuid()],
      /ledger_entry_balanced|23503/,
    );
  });
});

describe('consistência saldo ↔ ledger no banco', () => {
  test('alterar saldo SEM lançamento falha no COMMIT (constraint trigger deferred)', async () => {
    const w = await openWallet(core, '10.00');
    await expectSqlError(`UPDATE wallets SET balance_amount = '1000.00', version = version + 1 WHERE id = ?`, [w.id], /has no ledger entry/);
    expect((await assertWalletConsistent(core, w.id)).balance).toBe('10.00');
  });

  test('version só muda junto com o saldo, e sempre +1', async () => {
    const w = await openWallet(core, '10.00');
    await expectSqlError(`UPDATE wallets SET version = version + 1 WHERE id = ?`, [w.id], /version can only change/);
    await expectSqlError(`UPDATE wallets SET balance_amount = '5.00', version = version + 2 WHERE id = ?`, [w.id], /increment version by 1/);
  });
});
