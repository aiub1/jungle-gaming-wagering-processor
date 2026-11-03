import { CurrencyMismatchError, InvariantViolationError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Versão da wallet produzida por este lançamento (encadeia ledger ↔ wallet). */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento imutável. Não há setters nem métodos de transição: todos os campos
 * são `readonly` e a classe não expõe nada que altere estado. No banco, triggers
 * impedem UPDATE/DELETE/TRUNCATE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética: balanceBefore ± money === balanceAfter, valor > 0, saldo ≥ 0. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter } = entry;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new CurrencyMismatchError(balanceBefore.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError('ledger entry amount must be positive');
    }
    if (balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry would leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `unbalanced ledger entry: ${balanceBefore} ${entry.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir do banco: não revalida (o schema já garante a aritmética). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito assinado no saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
