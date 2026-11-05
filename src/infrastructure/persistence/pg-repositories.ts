import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { ConflictError } from '../../application/errors';
import type { FailureCode } from '../../domain/failure-code';
import { isUniqueViolation } from './pg-errors';
import { InboxMessage, type OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/**
 * Repositórios SQL explícitos executados via `em.execute()` do EntityManager
 * da transação corrente. Regras:
 *  - todo `numeric` é lido com `::text` → string exata → `Money.from` (nunca `number`);
 *  - todo timestamp é lido como ISO (`to_json(...)`), para não depender do parser do driver.
 */

type Row = Record<string, unknown>;

export function ts(column: string, alias = column): string {
  return `to_json(${column})#>>'{}' AS ${alias}`;
}

export function toDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function reqDate(value: unknown): Date {
  const d = toDate(value);
  if (!d || Number.isNaN(d.getTime())) throw new Error(`invalid timestamp from database: ${String(value)}`);
  return d;
}

function opt(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export const WALLET_COLUMNS = `id, player_id, currency, balance_amount::text AS balance_amount, version,
  ${ts('created_at')}, ${ts('updated_at')}`;

export function mapWallet(r: Row): Wallet {
  return Wallet.rehydrate({
    id: String(r.id),
    playerId: String(r.player_id),
    currency: String(r.currency),
    balance: Money.from({ amount: String(r.balance_amount), currency: String(r.currency) }),
    version: Number(r.version),
    createdAt: reqDate(r.created_at),
    updatedAt: reqDate(r.updated_at),
  });
}

/** Colunas de `wager_transactions` com prefixo de alias (numeric → text, timestamps → ISO). */
export function txColumns(a = 't'): string {
  return `${a}.id, ${a}.provider_id, ${a}.external_transaction_id, ${a}.idempotency_key, ${a}.payload_hash,
  ${a}.wallet_id, ${a}.player_id, ${a}.round_id, ${a}.game_id, ${a}.kind, ${a}.amount::text AS amount, ${a}.currency,
  ${a}.reference_external_transaction_id, ${a}.reference_transaction_id, ${a}.status, ${a}.failure_code,
  ${a}.result_balance_amount::text AS result_balance_amount, ${a}.reference_attempts,
  ${ts(`${a}.next_reference_attempt_at`, 'next_reference_attempt_at')}, ${ts(`${a}.created_at`, 'created_at')},
  ${ts(`${a}.processed_at`, 'processed_at')}`;
}

/** O saldo observado está sempre na moeda da WALLET (pode diferir da transação rejeitada por CURRENCY_MISMATCH). */
export const TX_SELECT = `SELECT ${txColumns('t')}, w.currency AS wallet_currency
  FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id`;

export function mapTransaction(r: Row): WagerTransaction {
  const currency = String(r.currency);
  const walletCurrency = r.wallet_currency ? String(r.wallet_currency) : currency;
  return WagerTransaction.rehydrate({
    id: String(r.id),
    providerId: String(r.provider_id),
    externalTransactionId: String(r.external_transaction_id),
    idempotencyKey: String(r.idempotency_key),
    payloadHash: String(r.payload_hash),
    walletId: String(r.wallet_id),
    playerId: String(r.player_id),
    roundId: String(r.round_id),
    gameId: String(r.game_id),
    kind: String(r.kind) as WagerTransactionKind,
    money: Money.from({ amount: String(r.amount), currency }),
    referenceExternalTransactionId: opt(r.reference_external_transaction_id),
    referenceTransactionId: opt(r.reference_transaction_id),
    status: String(r.status) as WagerTransactionStatus,
    failureCode: opt(r.failure_code) as FailureCode | undefined,
    resultBalance:
      r.result_balance_amount === null || r.result_balance_amount === undefined
        ? undefined
        : Money.from({ amount: String(r.result_balance_amount), currency: walletCurrency }),
    referenceAttempts: Number(r.reference_attempts),
    nextReferenceAttemptAt: toDate(r.next_reference_attempt_at),
    createdAt: reqDate(r.created_at),
    processedAt: toDate(r.processed_at),
  });
}

export function mapLedgerEntry(r: Row): WalletLedgerEntry {
  const currency = String(r.currency);
  return WalletLedgerEntry.rehydrate({
    id: String(r.id),
    walletId: String(r.wallet_id),
    transactionId: String(r.transaction_id),
    walletVersion: Number(r.wallet_version),
    direction: String(r.direction) as LedgerDirection,
    money: Money.from({ amount: String(r.amount), currency }),
    balanceBefore: Money.from({ amount: String(r.balance_before), currency }),
    balanceAfter: Money.from({ amount: String(r.balance_after), currency }),
    createdAt: reqDate(r.created_at),
  });
}

class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance.amount, wallet.version, wallet.createdAt, wallet.updatedAt],
      );
    } catch (error) {
      // A UNIQUE do banco é a garantia (vale entre instâncias); aqui só traduzimos.
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) {
        throw new ConflictError('WALLET_ALREADY_EXISTS', `player ${wallet.playerId} already has a ${wallet.currency} wallet`);
      }
      throw error;
    }
  }

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<Row[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
    return rows[0] ? mapWallet(rows[0]) : undefined;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<Row[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    return rows[0] ? mapWallet(rows[0]) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wallets SET balance_amount = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ? RETURNING id`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      // Sob o lock isto nunca acontece; se acontecer, alguém escreveu sem lock.
      const error = new Error(`optimistic lock conflict on wallet ${wallet.id} (expected version ${expectedVersion})`);
      error.name = 'OptimisticLockConflict';
      throw error;
    }
  }
}

class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, result_balance_amount, reference_attempts,
         next_reference_attempt_at, created_at, updated_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.resultBalance?.amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.createdAt,
        tx.processedAt ?? tx.createdAt,
        tx.processedAt ?? null,
      ],
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, reference_transaction_id = ?, result_balance_amount = ?,
              reference_attempts = ?, next_reference_attempt_at = ?, processed_at = ?, updated_at = now()
        WHERE id = ?`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        tx.resultBalance?.amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<Row[]>(`${TX_SELECT} WHERE t.id = ?`, [id]);
    return rows[0] ? mapTransaction(rows[0]) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<Row[]>(`${TX_SELECT} WHERE t.id = ? FOR UPDATE OF t`, [id]);
    return rows[0] ? mapTransaction(rows[0]) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<Row[]>(`${TX_SELECT} WHERE t.provider_id = ? AND t.external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
    return rows[0] ? mapTransaction(rows[0]) : undefined;
  }

  async findByIdempotencyKeyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.em.execute<Row[]>(
      `${TX_SELECT} WHERE t.provider_id = ? AND (t.idempotency_key = ? OR t.external_transaction_id = ?)`,
      [providerId, idempotencyKey, externalTransactionId],
    );
    return rows.map(mapTransaction);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute<Row[]>(
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async wakeDependents(providerId: string, externalTransactionId: string, walletId: string, at: Date): Promise<number> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wager_transactions SET next_reference_attempt_at = ?, updated_at = now()
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND wallet_id = ? AND next_reference_attempt_at > ?
        RETURNING id`,
      [at, providerId, externalTransactionId, walletId, at],
    );
    return rows.length;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.em.execute<Row[]>(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: String(r.id), walletId: String(r.wallet_id) }));
  }
}

class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
         balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.walletVersion,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
    );
  }
}

class PgInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // Se outra transação inseriu a mesma chave e ainda não commitou, o INSERT
    // ESPERA o desfecho dela: commit → conflito (duplicata); rollback → insere.
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows = await this.em.execute<Row[]>(
      `SELECT consumer_name, message_id, payload_hash, ${ts('received_at')}, ${ts('processed_at')}
         FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return InboxMessage.rehydrate({
      consumerName: String(r.consumer_name),
      messageId: String(r.message_id),
      payloadHash: String(r.payload_hash),
      receivedAt: reqDate(r.received_at),
      processedAt: toDate(r.processed_at),
    });
  }
}

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]): Promise<void> {
    // Inserção em ordem: `seq` (identity) reflete a ordem dos eventos da wallet.
    for (const m of messages) {
      await this.em.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, group_key, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [m.id, m.aggregateId, m.groupKey, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt],
      );
    }
  }
}

export class PgRepositories implements TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new PgWalletRepository(em);
    this.transactions = new PgWagerTransactionRepository(em);
    this.ledger = new PgLedgerRepository(em);
    this.inbox = new PgInboxRepository(em);
    this.outbox = new PgOutboxRepository(em);
  }
}
