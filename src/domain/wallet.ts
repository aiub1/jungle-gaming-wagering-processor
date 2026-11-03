import { CurrencyMismatchError, InsufficientFundsError, InvalidInputError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  /** id do lançamento de ledger a ser criado */
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Saldo e version são privados; a única forma de mudá-los é
 * via `debit`/`credit`, que SEMPRE devolvem o lançamento de ledger
 * correspondente — não existe caminho que altere o saldo sem gerar ledger.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com version 1. Se houver saldo inicial, devolve também o
   * lançamento CREDIT de abertura (balanceBefore = 0), gravado na mesma
   * transação SQL junto da transação interna OPENING.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInputError('initial balance cannot be negative', 'initialBalance');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);
    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Débito. Lança InsufficientFundsError se o saldo ficaria negativo. */
  debit(props: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    // `create` valida aritmética e não-negatividade antes de qualquer mutação:
    // se lançar, a wallet continua exatamente como estava.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      walletVersion: this._version + 1,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
