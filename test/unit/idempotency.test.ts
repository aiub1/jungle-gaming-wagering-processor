import { describe, expect, test } from 'bun:test';
import { parseSubmitWager } from '../../src/application/commands';
import { ConflictError } from '../../src/application/errors';
import { canonicalJson, payloadHash } from '../../src/application/payload-hash';
import type {
  Clock,
  FaultInjector,
  IdGenerator,
  Metrics,
  TransactionScope,
  UnitOfWork,
} from '../../src/application/ports';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { WagerSettlementService } from '../../src/application/wager-settlement.service';
import { InvalidInputError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import type { WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const body = (over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

describe('payloadHash / JSON canônico', () => {
  test('ordem das chaves não importa', () => {
    expect(canonicalJson({ b: '1', a: { d: '2', c: '3' } })).toBe('{"a":{"c":"3","d":"2"},"b":"1"}');
    expect(payloadHash({ a: '1', b: '2' })).toBe(payloadHash({ b: '2', a: '1' }));
  });

  test('undefined é omitido; number é proibido', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
    expect(() => canonicalJson({ a: 1 })).toThrow(TypeError);
  });

  test('Idempotency-Key e metadados de transporte NÃO entram no hash', () => {
    expect(parseSubmitWager(body(), 'k1').payloadHash).toBe(parseSubmitWager(body(), 'outra-key').payloadHash);
    expect(parseSubmitWager(body(), 'k1').payloadHash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test('qualquer campo de negócio diferente muda o hash', () => {
    const base = parseSubmitWager(body(), 'k').payloadHash;
    for (const over of [
      { money: { amount: '25.01', currency: 'BRL' } },
      { roundId: 'round-988' },
      { kind: 'WIN' },
      { gameId: 'other' },
      { referenceExternalTransactionId: 'abc' },
    ]) {
      expect(parseSubmitWager(body(over), 'k').payloadHash).not.toBe(base);
    }
  });

  test('UUID em maiúsculas é a mesma requisição (normalizado na borda)', () => {
    expect(parseSubmitWager(body({ walletId: WALLET.toUpperCase() }), 'k').payloadHash).toBe(
      parseSubmitWager(body(), 'k').payloadHash,
    );
  });
});

describe('contrato de entrada', () => {
  test.each([
    [{ kind: 'OPENING' }, 'kind'],
    [{ providerId: 'internal' }, 'providerId'],
    [{ walletId: 'not-a-uuid' }, 'walletId'],
    [{ money: { amount: 25, currency: 'BRL' } }, 'money.amount'],
    [{ money: { amount: '-1.00', currency: 'BRL' } }, 'money.amount'],
    [{ externalTransactionId: '' }, 'externalTransactionId'],
  ])('rejeita %p', (over, field) => {
    try {
      parseSubmitWager(body(over), 'k');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError).field).toBe(field);
    }
  });

  test('Idempotency-Key é obrigatório', () => {
    expect(() => parseSubmitWager(body(), undefined)).toThrow(InvalidInputError);
    expect(() => parseSubmitWager(body(), '')).toThrow(InvalidInputError);
  });
});

/** UoW em memória: só para exercitar o caso de uso sem banco (a garantia real está nos testes de integração). */
function inMemory() {
  const at = new Date('2026-01-01T00:00:00Z');
  const wallet = Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'o',
    openingEntryId: 'oe',
    at,
  }).wallet;
  const txs: WagerTransaction[] = [];
  let n = 0;
  const scope = {
    wallets: { lockById: async () => wallet, saveBalance: async () => {} },
    transactions: {
      insert: async (t: WagerTransaction) => void txs.push(t),
      update: async () => {},
      findByExternalId: async (p: string, e: string) => txs.find((t) => t.providerId === p && t.externalTransactionId === e),
      findByIdempotencyKeyOrExternalId: async (p: string, k: string, e: string) =>
        txs.filter((t) => t.providerId === p && (t.idempotencyKey === k || t.externalTransactionId === e)),
      hasProcessedReversal: async () => false,
      wakeDependents: async () => 0,
    },
    ledger: { append: async () => {} },
    inbox: {},
    outbox: { add: async () => {} },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = { run: (work) => work(scope) };
  const ids: IdGenerator = { next: () => `id-${++n}` };
  const clock: Clock = { now: () => at };
  const noop = () => {};
  const metrics: Metrics = {
    transactionFinished: noop,
    duplicateDetected: noop,
    retry: noop,
    lockConflict: noop,
    dlq: noop,
    processingLatency: noop,
    reconciliationMismatch: noop,
  };
  const faults: FaultInjector = { hit: async () => {} };
  const settlement = new WagerSettlementService(ids, clock, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
  return { useCase: new SubmitWagerTransaction(uow, settlement, ids, clock, metrics, faults), wallet };
}

describe('SubmitWagerTransaction — idempotência', () => {
  const ctx = { channel: 'http' as const, correlationId: 'c' };

  test('mesma key + mesmo payload → replay com o RESULTADO ORIGINAL (inclusive saldo observado)', async () => {
    const { useCase } = inMemory();
    const first = await useCase.execute(parseSubmitWager(body(), 'provider-a:transaction-123'), ctx);
    await useCase.execute(parseSubmitWager(body({ externalTransactionId: 'other', money: { amount: '10.00', currency: 'BRL' } }), 'k2'), ctx);
    const replay = await useCase.execute(parseSubmitWager(body(), 'provider-a:transaction-123'), ctx);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' }); // não o saldo atual (65.00)
  });

  test('mesma key + payload divergente → ConflictError IDEMPOTENCY_KEY_REUSED (não replay)', async () => {
    const { useCase, wallet } = inMemory();
    await useCase.execute(parseSubmitWager(body(), 'provider-a:transaction-123'), ctx);
    const promise = useCase.execute(parseSubmitWager(body({ money: { amount: '26.00', currency: 'BRL' } }), 'provider-a:transaction-123'), ctx);
    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(wallet.balance.amount).toBe('75.00'); // nenhum segundo débito
  });

  test('mesmo externalId com outra key → EXTERNAL_ID_REUSED', async () => {
    const { useCase } = inMemory();
    await useCase.execute(parseSubmitWager(body(), 'k1'), ctx);
    await expect(useCase.execute(parseSubmitWager(body(), 'k2'), ctx)).rejects.toMatchObject({ code: 'EXTERNAL_ID_REUSED' });
  });
});
