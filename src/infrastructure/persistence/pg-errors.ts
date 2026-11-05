/**
 * Classificação de erros do PostgreSQL (SQLSTATE) para a política de retry.
 * Só são transitórios os erros em que refazer a transação inteira pode dar
 * certo; violações de constraint de negócio NÃO são retentadas.
 */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

export function pgError(error: unknown): PgErrorInfo {
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
  const code = typeof e?.code === 'string' ? e.code : undefined;
  return {
    code,
    constraint: typeof e?.constraint === 'string' ? e.constraint : undefined,
    message: typeof e?.message === 'string' ? e.message : String(error),
  };
}

/** Corridas de unicidade que se resolvem relendo: a outra transação ganhou, a próxima tentativa vê o replay/conflito. */
const RACE_CONSTRAINTS = new Set([
  'wager_tx_provider_idempotency_uq',
  'wager_tx_provider_external_uq',
  'inbox_messages_pk',
]);

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export type TransientReason =
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization'
  | 'unique_race'
  | 'connection'
  | 'statement_timeout'
  | 'optimistic_conflict';

export function transientReason(error: unknown): TransientReason | undefined {
  const { code, constraint, message } = pgError(error);
  if (code === '55P03') return 'lock_timeout';
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  if (code === '57014') return 'statement_timeout';
  if (code === '23505' && constraint && RACE_CONSTRAINTS.has(constraint)) return 'unique_race';
  if (code && (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03' || code === '53300')) {
    return 'connection';
  }
  if (code && CONNECTION_CODES.has(code)) return 'connection';
  if (/Connection terminated|connection.*(refused|closed|reset)|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(message)) {
    return 'connection';
  }
  if ((error as { name?: string })?.name === 'OptimisticLockConflict') return 'optimistic_conflict';
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const info = pgError(error);
  return info.code === '23505' && info.constraint === constraint;
}
