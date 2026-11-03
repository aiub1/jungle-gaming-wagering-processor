import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidInputError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('aceita string decimal com escala fixa de 2 e serializa igual', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.01').amount).toBe('0.01');
    expect(brl('999999999999999999.99').amount).toBe('999999999999999999.99');
    expect(brl('0.00').isZero()).toBe(true);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e2'],
    ['1E-2'],
    [''],
    [' 1.00'],
    ['1.00 '],
    ['10.005'], // mais de 2 casas: rejeita, NUNCA arredonda
    ['10.5'], // escala diferente de 2
    ['10'],
    ['1.'],
    ['.50'],
    ['-1.00'], // negativo em contrato de entrada
    ['+1.00'],
    ['01.00'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'], // além de 18 dígitos inteiros
  ])('rejeita amount inválido %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidInputError);
  });

  test('rejeita amount que não é string (number nunca entra no domínio)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidInputError);
    expect(() => Money.from({ amount: 0.1 as unknown as string, currency: 'BRL' })).toThrow(InvalidInputError);
  });

  test.each([['brl'], ['BR'], ['BRLL'], [''], ['12A']])('rejeita moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidInputError);
  });

  test('aritmética exata, sem erro de ponto flutuante', () => {
    // 0.1 + 0.2 em float = 0.30000000000000004
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('999999999999999999.99').subtract(brl('0.01')).amount).toBe('999999999999999999.98');
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('negate / sinais / comparação', () => {
    const neg = brl('3.10').negate();
    expect(neg.amount).toBe('-3.10');
    expect(neg.isNegative()).toBe(true);
    expect(brl('0.00').negate().amount).toBe('0.00'); // sem "-0.00"
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    expect(brl('5.00').subtract(brl('7.50')).amount).toBe('-2.50');
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('toString legível', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});
