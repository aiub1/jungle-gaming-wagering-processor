import { InvalidInputError } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money';
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from '../domain/wager-transaction';
import { payloadHash } from './payload-hash';

/**
 * Validação de contrato de entrada (HTTP e SQS usam a mesma função).
 * Retorna objetos tipados ou lança InvalidInputError (→ 400 / DLQ).
 */

export const INTERNAL_PROVIDER_ID = 'internal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identificadores externos: imprimíveis, sem espaços nas pontas, até 128 chars. */
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,127}$/;

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /** hash do subconjunto de negócio — calculado aqui, uma vez, para HTTP e SQS */
  payloadHash: string;
}

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, field: string, pattern: RegExp = EXTERNAL_ID): string {
  const value = obj[field];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new InvalidInputError(`${field} is required and must match ${pattern}`, field);
  }
  return value;
}

function uuid(obj: Record<string, unknown>, field: string): string {
  // UUIDs normalizados para minúsculas na borda: o PostgreSQL devolve em
  // minúsculas, e o hash/comparações tratam ids como texto.
  return str(obj, field, UUID).toLowerCase();
}

function idempotencyKeyOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new InvalidInputError('Idempotency-Key is required (1..256 chars, no surrounding whitespace)', 'Idempotency-Key');
  }
  return value;
}

export function parseSubmitWager(body: unknown, idempotencyKey: unknown): SubmitWagerCommand {
  const obj = asRecord(body, 'body');
  const kind = obj.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.includes(kind as WagerTransactionKind)) {
    // OPENING é interno: nunca aceito por API ou fila.
    throw new InvalidInputError(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`, 'kind');
  }
  const providerId = str(obj, 'providerId');
  if (providerId === INTERNAL_PROVIDER_ID) {
    throw new InvalidInputError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`, 'providerId');
  }
  const ref = obj.referenceExternalTransactionId;
  const referenceExternalTransactionId = ref === undefined || ref === null ? undefined : str(obj, 'referenceExternalTransactionId');
  const money = Money.from(asRecord(obj.money, 'money') as unknown as MoneyProps);

  const business = {
    providerId,
    externalTransactionId: str(obj, 'externalTransactionId'),
    playerId: uuid(obj, 'playerId'),
    walletId: uuid(obj, 'walletId'),
    roundId: str(obj, 'roundId'),
    gameId: str(obj, 'gameId'),
    kind: kind as WagerTransactionKind,
    referenceExternalTransactionId,
  };
  return {
    ...business,
    money,
    idempotencyKey: idempotencyKeyOf(idempotencyKey),
    // Hash SOMENTE do subconjunto de negócio: o header Idempotency-Key, o
    // messageId e metadados de transporte não entram.
    payloadHash: payloadHash({ ...business, money: money.toJSON() }),
  };
}

export function parseOpenWallet(body: unknown): OpenWalletCommand {
  const obj = asRecord(body, 'body');
  let initialBalance: Money;
  try {
    initialBalance = Money.from(asRecord(obj.initialBalance, 'initialBalance') as unknown as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidInputError && error.field?.startsWith('money')) {
      throw new InvalidInputError(error.message, error.field.replace(/^money/, 'initialBalance'));
    }
    throw error;
  }
  return { playerId: uuid(obj, 'playerId'), initialBalance };
}

export function parseUuid(value: unknown, field: string): string {
  return uuid({ [field]: value }, field);
}
