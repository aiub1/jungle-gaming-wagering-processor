import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

function open(amount = '100.00') {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), openingTransactionId: 't0', openingEntryId: 'e0', at });
}

const move = (amount: string, n = 1) => ({ entryId: `e${n}`, transactionId: `t${n}`, money: brl(amount), at });

describe('Wallet', () => {
  test('abre com version 1 e lançamento CREDIT de abertura quando saldo > 0', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('débito e crédito geram lançamento consistente e incrementam version', () => {
    const { wallet } = open('100.00');
    const debit = wallet.debit(move('30.00', 1));
    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('70.00');
    expect(debit.walletVersion).toBe(2);
    const credit = wallet.credit(move('5.50', 2));
    expect(wallet.balance.amount).toBe('75.50');
    expect(wallet.version).toBe(3);
    expect(credit.isBalanced()).toBe(true);
  });

  test('saldo nunca negativo: débito acima do saldo lança e NÃO altera estado', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.debit(move('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    // débito exato até zero é permitido
    wallet.debit(move('10.00'));
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('moeda da operação deve ser a da wallet', () => {
    const { wallet } = open('10.00');
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate não revalida nem altera estado', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('5.00'), version: 7, createdAt: at, updatedAt: at });
    expect(w.version).toBe(7);
    expect(w.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: at,
  };

  test('create valida a aritmética', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('1.00'), balanceBefore: brl('5.00'), balanceAfter: brl('3.00') }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('5.00'), balanceAfter: brl('5.00') }),
    ).toThrow(InvariantViolationError);
    const ok = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('2.00'), balanceBefore: brl('5.00'), balanceAfter: brl('3.00') });
    expect(ok.isBalanced()).toBe(true);
    expect(ok.signedAmount().amount).toBe('-2.00');
  });

  test('é estruturalmente imutável (sem setters / métodos de transição)', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
    expect(Object.getOwnPropertyDescriptors(WalletLedgerEntry.prototype)).not.toHaveProperty('money');
    expect(entry.money.amount).toBe('1.00');
  });
});
