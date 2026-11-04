import { FailureCode } from '../domain/failure-code';
import {
  type IntegrationEvent,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-events';
import { OutboxMessage } from '../domain/messaging';
import type { MoneyProps } from '../domain/money';
import { WagerSettlement, type SettlementOutcome } from '../domain/wager-settlement';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { Clock, IdGenerator, TransactionScope } from './ports';

export interface PendingReferencePolicy {
  /** tentativas do worker antes de rejeitar com REFERENCE_NOT_FOUND */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface CausalContext {
  correlationId: string;
  causationId?: string;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * Núcleo compartilhado por todos os caminhos que decidem uma transação
 * (HTTP, SQS e worker de referências): busca a referência, aplica o serviço de
 * domínio e grava transação + saldo + ledger + outbox no MESMO escopo SQL.
 * Pré-condição: a wallet já está travada (`FOR UPDATE`) pelo chamador.
 */
export class WagerSettlementService {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  async settle(
    scope: TransactionScope,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: CausalContext,
    isNew: boolean,
  ): Promise<SettlementOutcome> {
    const now = this.clock.now();
    const versionBefore = wallet.version;

    const reference = tx.referenceExternalTransactionId
      ? await scope.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const alreadyReversed =
      reference && tx.isReversal() ? await scope.transactions.hasProcessedReversal(reference.id) : false;

    let outcome = WagerSettlement.settle({
      tx,
      wallet,
      lookup: { reference, alreadyReversed },
      entryId: this.ids.next(),
      now,
    });

    if (outcome.type === 'pending_reference') {
      // Tentativa atual = attempts já feitas; esgotado o limite → REJECTED.
      const attemptsSoFar = isNew ? 0 : tx.referenceAttempts + 1;
      if (attemptsSoFar >= this.pendingPolicy.maxAttempts) {
        const code = FailureCode.ReferenceNotFound;
        tx.reject(code, wallet.balance);
        outcome = { type: 'rejected', code };
      } else {
        tx.markPendingReference(this.nextReferenceAttempt(now, attemptsSoFar));
      }
    }

    if (isNew) await scope.transactions.insert(tx);
    else await scope.transactions.update(tx);

    let entry: WalletLedgerEntry | undefined;
    if (outcome.type === 'processed' && outcome.entry) {
      entry = outcome.entry;
      await scope.wallets.saveBalance(wallet, versionBefore);
      await scope.ledger.append(entry);
    }
    if (outcome.type === 'processed') {
      // Pendentes que esperavam por esta transação são antecipados para o worker.
      await scope.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, tx.walletId, now);
    }

    await scope.outbox.add(this.eventsFor(tx, wallet, entry, ctx, now, isNew));
    return outcome;
  }

  /** Marca FAILED (erro permanente de infraestrutura) com evento auditável. */
  async fail(scope: TransactionScope, tx: WagerTransaction, code: FailureCode, ctx: CausalContext): Promise<void> {
    tx.fail(code);
    await scope.transactions.update(tx);
    const now = this.clock.now();
    await scope.outbox.add([
      OutboxMessage.enqueue(WagerTransactionFailed.from(tx, this.eventCtx(ctx, now)), tx.walletId),
    ]);
  }

  nextReferenceAttempt(now: Date, attempt: number): Date {
    const delay = Math.min(this.pendingPolicy.maxDelayMs, this.pendingPolicy.baseDelayMs * 2 ** attempt);
    return new Date(now.getTime() + delay);
  }

  private eventsFor(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    ctx: CausalContext,
    now: Date,
    isNew: boolean,
  ): OutboxMessage[] {
    const events: IntegrationEvent<unknown>[] = [];
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(tx, wallet, this.eventCtx(ctx, now)));
        // somente quando o saldo muda (LOSS não gera)
        if (entry) events.push(WalletBalanceChanged.from(wallet, entry, this.eventCtx(ctx, now)));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(tx, this.eventCtx(ctx, now)));
        break;
      case WagerTransactionStatus.PendingReference:
        // só na entrada em pendência; novas tentativas do worker não geram evento
        if (isNew) events.push(WagerTransactionPendingReference.from(tx, this.eventCtx(ctx, now)));
        break;
      default:
        break;
    }
    // groupKey = walletId → MessageGroupId: ordem por wallet no FIFO de eventos.
    return events.map((event) => OutboxMessage.enqueue(event, tx.walletId));
  }

  private eventCtx(ctx: CausalContext, now: Date) {
    return { eventId: this.ids.next(), correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: now };
  }
}

export function toResult(tx: WagerTransaction, fallbackBalance: MoneyProps, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    // Decisões terminais devolvem o saldo OBSERVADO naquele momento (replay fiel);
    // PENDING_REFERENCE ainda não tem decisão → saldo atual.
    balance: tx.resultBalance?.toJSON() ?? fallbackBalance,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    idempotentReplay,
  };
}
