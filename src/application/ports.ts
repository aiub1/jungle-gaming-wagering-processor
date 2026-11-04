import type { InboxMessage, OutboxMessage } from '../domain/messaging';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/**
 * Portas (hexagonal). A aplicação depende destas interfaces; as implementações
 * PostgreSQL/MikroORM e SQS ficam em `infrastructure`. Os tokens `Symbol` são
 * usados pelo container do Nest.
 */

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  /** `SELECT … FOR UPDATE`: serializa todas as operações da wallet entre instâncias. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  findById(walletId: string): Promise<Wallet | undefined>;
  /**
   * `UPDATE … WHERE id = ? AND version = expectedVersion`. Defesa em
   * profundidade: sob o lock nunca falha; se falhar, alguém escreveu sem lock.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  /** Atualiza estado mutável (status, failure, referência, agenda de retry). */
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Para o worker: trava a linha (depois do lock da wallet — ordem wallet → transação). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Uma consulta cobre as duas chaves únicas: (provider, idempotency_key) e (provider, external_id). */
  findByIdempotencyKeyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Antecipa o worker para pendentes que esperavam esta transação (mesma wallet, já travada). */
  wakeDependents(providerId: string, externalTransactionId: string, walletId: string, at: Date): Promise<number>;
  /** Candidatos para o worker de referências pendentes (sem lock; o lock é por item). */
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface InboxRepository {
  /** INSERT … ON CONFLICT DO NOTHING. `false` → a mensagem já foi processada (ou está sendo, e esperamos o commit). */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
}

/** Repositórios ligados à MESMA transação SQL. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  /** nome da operação, para métricas/logs de retry */
  operation: string;
  /** REPEATABLE READ READ ONLY — usado pela reconciliação */
  readOnlySnapshot?: boolean;
}

/**
 * Executa `work` numa transação SQL (READ COMMITTED + locks de linha).
 * Falhas transitórias (lock timeout, deadlock, serialization, corrida de
 * unicidade) refazem a transação INTEIRA, com nova leitura de tudo;
 * esgotadas as tentativas → TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUIDv7: ordenável no tempo, bom para índices B-tree. */
  next(): string;
}

/** Pontos de injeção de falha para testes de crash (no-op em produção). */
export interface FaultInjector {
  hit(point: FaultPoint): Promise<void>;
}

export type FaultPoint =
  | 'wager.before-commit'
  | 'sqs.after-commit-before-ack'
  | 'outbox.after-claim-before-publish'
  | 'outbox.after-publish-before-mark';

export interface Metrics {
  transactionFinished(kind: string, status: string, channel: string): void;
  duplicateDetected(source: 'idempotency' | 'inbox'): void;
  retry(operation: string, reason: string): void;
  lockConflict(reason: string): void;
  dlq(reason: string): void;
  processingLatency(channel: string, seconds: number): void;
  reconciliationMismatch(): void;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const FAULT_INJECTOR = Symbol('FaultInjector');
export const METRICS = Symbol('Metrics');
