import { describe, expect, test } from 'bun:test';
import { InvalidInputError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerSettlement } from '../../src/domain/wager-settlement';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const at = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
let seq = 0;

function wallet(amount = '100.00') {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), openingTransactionId: 'o', openingEntryId: 'oe', at }).wallet;
}

function tx(kind: K, amount: string, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  seq += 1;
  return WagerTransaction.create({
    id: `t${seq}`,
    providerId: 'prov',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `prov:ext-${seq}`,
    payloadHash: `h${seq}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    createdAt: at,
    ...extra,
  });
}

function settle(t: WagerTransaction, w: Wallet, reference?: WagerTransaction, alreadyReversed = false) {
  return WagerSettlement.settle({ tx: t, wallet: w, lookup: { reference, alreadyReversed }, entryId: `e-${t.id}`, now: at });
}

/** Cria e processa uma transação, devolvendo-a PROCESSED (para servir de referência). */
function processed(kind: K, amount: string, w: Wallet, reference?: WagerTransaction) {
  const t = tx(kind, amount, reference ? { referenceExternalTransactionId: reference.externalTransactionId } : {});
  const outcome = settle(t, w, reference);
  expect(outcome.type).toBe('processed');
  return t;
}

describe('BET', () => {
  test('debita e gera 1 lançamento DEBIT', () => {
    const w = wallet('100.00');
    const t = tx(K.Bet, '25.00');
    const outcome = settle(t, w);
    expect(outcome.type).toBe('processed');
    if (outcome.type !== 'processed') return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(t.status).toBe(S.Processed);
    expect(t.resultBalance?.amount).toBe('75.00');
    expect(w.balance.amount).toBe('75.00');
  });

  test('saldo insuficiente → REJECTED INSUFFICIENT_FUNDS, sem lançamento nem mudança de saldo', () => {
    const w = wallet('10.00');
    const t = tx(K.Bet, '10.01');
    expect(settle(t, w)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(t.status).toBe(S.Rejected);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('cenário da seção 8 (sequencial no domínio): 100 − 80 OK, segunda 80 rejeitada', () => {
    const w = wallet('100.00');
    expect(settle(tx(K.Bet, '80.00'), w).type).toBe('processed');
    expect(settle(tx(K.Bet, '80.00'), w)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe('20.00');
  });
});

describe('WIN', () => {
  test('credita, com ou sem referência à BET da rodada', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '10.00', w);
    const win = processed(K.Win, '30.00', w, bet);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('120.00');
    processed(K.Win, '1.00', w);
    expect(w.balance.amount).toBe('121.00');
  });

  test('WIN referenciando BET de outra rodada → REFERENCE_MISMATCH', () => {
    const w = wallet();
    const bet = processed(K.Bet, '10.00', w);
    const win = tx(K.Win, '5.00', { referenceExternalTransactionId: bet.externalTransactionId, roundId: 'other' });
    expect(settle(win, w, bet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('não move saldo nem gera lançamento, mas é PROCESSED', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '10.00', w);
    const loss = tx(K.Loss, '0.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = settle(loss, w, bet);
    expect(outcome).toEqual({ type: 'processed' });
    expect(loss.affectsBalance()).toBe(false);
    expect(w.balance.amount).toBe('90.00');
    expect(w.version).toBe(2);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('REFUND', () => {
  test('exige referência', () => {
    expect(() => tx(K.Refund, '10.00')).toThrow(InvalidInputError);
  });

  test('credita o valor da BET, uma única vez', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '40.00', w);
    const refund = processed(K.Refund, '40.00', w, bet);
    expect(w.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
    const again = tx(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(again, w, bet, true)).toEqual({ type: 'rejected', code: FailureCode.ReferenceAlreadyReversed });
    expect(w.balance.amount).toBe('100.00');
  });

  test('só referencia BET', () => {
    const w = wallet();
    const win = processed(K.Win, '10.00', w);
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(refund, w, win)).toEqual({ type: 'rejected', code: FailureCode.ReferenceKindNotAllowed });
  });

  test('valor diferente da referência → REVERSAL_AMOUNT_MISMATCH', () => {
    const w = wallet();
    const bet = processed(K.Bet, '10.00', w);
    const refund = tx(K.Refund, '9.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, bet)).toEqual({ type: 'rejected', code: FailureCode.ReversalAmountMismatch });
  });

  test('referência ausente → pending_reference (e não muda saldo)', () => {
    const w = wallet();
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'not-yet' });
    expect(settle(refund, w, undefined)).toEqual({ type: 'pending_reference' });
    expect(refund.status).toBe(S.Pending); // o agendamento é da aplicação
    expect(w.balance.amount).toBe('100.00');
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const w = wallet('1.00');
    const bet = tx(K.Bet, '50.00');
    settle(bet, w); // rejeitada por saldo
    const refund = tx(K.Refund, '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, bet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('de BET → CREDIT (inverso)', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '30.00', w);
    const rb = tx(K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(settle(rb, w, bet).type).toBe('processed');
    expect(w.balance.amount).toBe('100.00');
  });

  test('de WIN → DEBIT; de REFUND → DEBIT', () => {
    const w = wallet('100.00');
    const win = processed(K.Win, '50.00', w);
    processed(K.Rollback, '50.00', w, win);
    expect(w.balance.amount).toBe('100.00');
    const bet = processed(K.Bet, '20.00', w);
    const refund = processed(K.Refund, '20.00', w, bet);
    processed(K.Rollback, '20.00', w, refund);
    expect(w.balance.amount).toBe('80.00');
  });

  test('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (código distinto de aposta sem saldo)', () => {
    const w = wallet('0.00');
    const win = processed(K.Win, '50.00', w);
    processed(K.Bet, '45.00', w); // saldo 5.00
    const rb = tx(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(rb, w, win)).toEqual({ type: 'rejected', code: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('5.00');
    expect(rb.status).toBe(S.Rejected); // auditável
  });

  test('não pode referenciar LOSS nem ROLLBACK', () => {
    const w = wallet();
    const loss = processed(K.Loss, '0.00', w);
    const rb = tx(K.Rollback, '0.01', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(settle(rb, w, loss)).toEqual({ type: 'rejected', code: FailureCode.ReferenceKindNotAllowed });
  });

  test('referência ainda PENDING_REFERENCE → continua aguardando', () => {
    const w = wallet();
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-not-yet' });
    refund.markPendingReference(at);
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(settle(rb, w, refund)).toEqual({ type: 'pending_reference' });
  });
});

describe('conflito de moeda e identidade', () => {
  test('moeda diferente da wallet → REJECTED CURRENCY_MISMATCH', () => {
    const w = wallet();
    const t = tx(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(settle(t, w)).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(w.balance.amount).toBe('100.00');
  });

  test('player diferente do dono da wallet → WALLET_PLAYER_MISMATCH', () => {
    const w = wallet();
    expect(settle(tx(K.Bet, '1.00', { playerId: 'intruder' }), w)).toEqual({
      type: 'rejected',
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test('referência de outro provider/wallet → REFERENCE_MISMATCH', () => {
    const w = wallet();
    const bet = processed(K.Bet, '10.00', w);
    const otherWalletBet = WagerTransaction.rehydrate({ ...snapshot(bet), walletId: 'w2' });
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, otherWalletBet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('WagerTransaction: máquina de estados', () => {
  test('nasce PENDING; PROCESSED/REJECTED/FAILED são terminais', () => {
    const t = tx(K.Bet, '1.00');
    expect(t.status).toBe(S.Pending);
    expect(t.isTerminal()).toBe(false);
    t.markProcessed(undefined, at, brl('1.00'));
    expect(t.isTerminal()).toBe(true);
    expect(() => t.reject(FailureCode.InsufficientFunds, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(at)).toThrow(InvalidTransactionStateError);
    const r = tx(K.Bet, '1.00');
    r.reject(FailureCode.InsufficientFunds, brl('0.00'));
    expect(() => r.markProcessed(undefined, at, brl('0.00'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE pode reagendar (conta tentativas) e depois decidir', () => {
    const t = tx(K.Refund, '1.00', { referenceExternalTransactionId: 'x' });
    t.markPendingReference(at);
    expect(t.referenceAttempts).toBe(0);
    t.markPendingReference(at);
    expect(t.referenceAttempts).toBe(1);
    t.reject(FailureCode.ReferenceNotFound, brl('0.00'));
    expect(t.status).toBe(S.Rejected);
    expect(t.nextReferenceAttemptAt).toBeUndefined();
  });

  test('validações de criação', () => {
    expect(() => tx(K.Rollback, '1.00')).toThrow(InvalidInputError);
    expect(() => tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidInputError);
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidInputError);
    expect(() => tx(K.Win, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' })).toThrow(InvalidInputError);
    expect(tx(K.Loss, '0.00').status).toBe(S.Pending);
  });

  test('matchesPayload / requiresReference / affectsBalance', () => {
    const t = tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'x', payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('abd')).toBe(false);
    expect(t.requiresReference()).toBe(true);
    expect(tx(K.Win, '1.00').requiresReference()).toBe(false);
    expect(tx(K.Loss, '0.00').affectsBalance()).toBe(false);
  });
});

function snapshot(t: WagerTransaction) {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    processedAt: t.processedAt,
    resultBalance: t.resultBalance,
    referenceAttempts: t.referenceAttempts,
    nextReferenceAttemptAt: t.nextReferenceAttemptAt,
  };
}
