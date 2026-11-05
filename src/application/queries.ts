import { InvalidInputError } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import { NotFoundError } from './errors';
import { toWalletView, type WalletView } from './open-wallet';
import type { Metrics } from './ports';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationRaw {
  walletId: string;
  currency: string;
  storedBalance: string;
  /** soma assinada de todos os lançamentos (créditos − débitos), calculada pelo banco em NUMERIC */
  ledgerSum: string;
  checkedEntries: number;
  /** maior wallet_version do ledger (deve bater com wallet.version quando há lançamentos) */
  lastEntryVersion: number | null;
  walletVersion: number;
  /** versões faltando na sequência 1..N do ledger */
  versionGaps: number;
}

/** Porta de leitura: consultas não precisam de lock nem de domínio rico. */
export interface ReadModel {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]>;
  findTransaction(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  /** snapshot consistente (REPEATABLE READ READ ONLY) de wallet + ledger */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationRaw | undefined>;
}

export const READ_MODEL = Symbol('ReadModel');

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    balance: tx.resultBalance?.toJSON(),
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt?.toISOString(),
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString(),
  };
}

/**
 * Cursor opaco e estável: base64url de `{"v": <wallet_version>}`. A versão é
 * única por wallet e imutável (o ledger é append-only), então inserções novas
 * nunca deslocam páginas já lidas — diferente de OFFSET.
 */
export function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidInputError('invalid cursor', 'cursor');
}

export class WalletQueries {
  constructor(private readonly read: ReadModel) {}

  async wallet(walletId: string): Promise<WalletView> {
    const wallet = await this.read.findWallet(walletId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
    return toWalletView(wallet);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new InvalidInputError('limit must be an integer between 1 and 200', 'limit');
    }
    const after = decodeCursor(cursor);
    await this.wallet(walletId); // 404 consistente
    const rows = await this.read.ledgerPage(walletId, after, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.walletVersion) : null };
  }

  async transaction(id: string): Promise<TransactionView> {
    const tx = await this.read.findTransaction(id);
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${id} not found`);
    return toTransactionView(tx);
  }

  async transactionByExternalId(providerId: string, externalId: string): Promise<TransactionView> {
    const tx = await this.read.findTransactionByExternalId(providerId, externalId);
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${providerId}/${externalId} not found`);
    return toTransactionView(tx);
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** detalhes extras para diagnóstico */
  checks: { balanceMatches: boolean; versionChainIntact: boolean };
}

/**
 * Reconciliação: compara o saldo materializado com o saldo reconstruído pelo
 * ledger, num snapshot consistente. NÃO corrige nada: divergência é logada,
 * contabilizada em métrica e sinalizada na resposta.
 */
export class ReconcileWallet {
  constructor(
    private readonly read: ReadModel,
    private readonly metrics: Metrics,
    private readonly onMismatch: (report: ReconciliationReport) => void,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const raw = await this.read.reconciliationSnapshot(walletId);
    if (!raw) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);

    const stored = Money.from({ amount: raw.storedBalance, currency: raw.currency });
    // ledgerSum pode ser negativo numa corrupção hipotética → parse manual
    const negative = raw.ledgerSum.startsWith('-');
    const absSum = Money.from({ amount: negative ? raw.ledgerSum.slice(1) : raw.ledgerSum, currency: raw.currency });
    const calculated = negative ? absSum.negate() : absSum;
    const difference = stored.subtract(calculated);

    const balanceMatches = difference.isZero();
    const versionChainIntact =
      raw.versionGaps === 0 && (raw.checkedEntries === 0 ? raw.walletVersion === 1 : raw.lastEntryVersion === raw.walletVersion);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: balanceMatches && versionChainIntact,
      checkedEntries: raw.checkedEntries,
      checks: { balanceMatches, versionChainIntact },
    };
    if (!report.consistent) {
      this.metrics.reconciliationMismatch();
      this.onMismatch(report);
    }
    return report;
  }
}
