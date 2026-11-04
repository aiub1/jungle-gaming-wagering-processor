import { FailureCode } from './failure-code';
import {
  ALLOWED_REFERENCE_KINDS,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

/**
 * O que a aplicação descobriu no banco sobre a referência, já sob o lock da wallet.
 * `alreadyReversed`: existe REFUND/ROLLBACK PROCESSED apontando para ela.
 */
export interface ReferenceLookup {
  reference?: WagerTransaction;
  alreadyReversed: boolean;
}

export type SettlementOutcome =
  | { type: 'processed'; entry?: WalletLedgerEntry }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

/**
 * Serviço de domínio puro: aplica as regras de negócio da seção 7 a uma
 * transação em PENDING / PENDING_REFERENCE, mutando wallet e transação de forma
 * consistente. Não faz I/O — quem chama já travou a wallet e buscou a referência.
 *
 * Retorna o desfecho; a transação já sai com o estado correto (exceto
 * PENDING_REFERENCE, cujo agendamento depende da política de retry da aplicação).
 */
export class WagerSettlement {
  static settle(params: {
    tx: WagerTransaction;
    wallet: Wallet;
    lookup: ReferenceLookup;
    entryId: string;
    now: Date;
  }): SettlementOutcome {
    const { tx, wallet, lookup, entryId, now } = params;

    const rejection = WagerSettlement.validate(tx, wallet, lookup);
    if (rejection === 'pending') return { type: 'pending_reference' };
    if (rejection) {
      tx.reject(rejection, wallet.balance);
      return { type: 'rejected', code: rejection };
    }

    const reference = lookup.reference;
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { type: 'processed' };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // Aposta sem saldo e reversão que deixaria saldo negativo são situações
      // operacionais diferentes → códigos distintos.
      const code =
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      tx.reject(code, wallet.balance);
      return { type: 'rejected', code };
    }

    const movement = { entryId, transactionId: tx.id, money: tx.money, at: now };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { type: 'processed', entry };
  }

  /** Devolve o código de rejeição, 'pending' se a referência ainda não chegou, ou undefined se ok. */
  private static validate(tx: WagerTransaction, wallet: Wallet, lookup: ReferenceLookup): FailureCode | 'pending' | undefined {
    if (tx.playerId !== wallet.playerId) return FailureCode.WalletPlayerMismatch;
    if (tx.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
    if (!tx.referenceExternalTransactionId) return undefined;

    const ref = lookup.reference;
    // Referência ausente, ou ela mesma ainda esperando a sua referência
    // (ex.: ROLLBACK de um REFUND que espera o BET): aguardar.
    if (!ref || ref.status === WagerTransactionStatus.PendingReference) return 'pending';
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(ref.kind)) return FailureCode.ReferenceKindNotAllowed;
    if (
      ref.providerId !== tx.providerId ||
      ref.walletId !== tx.walletId ||
      ref.playerId !== tx.playerId ||
      ref.roundId !== tx.roundId ||
      ref.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;
      if (lookup.alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }
}
