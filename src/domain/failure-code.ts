/**
 * Taxonomia estável de `failureCode` para transações REJECTED / FAILED.
 *
 * Cada código diz ao provedor o que fazer:
 *  - `retryable: false` → a decisão é definitiva para essa idempotency key;
 *    reenviar a mesma requisição devolve o mesmo resultado (replay). Para tentar
 *    de novo é preciso uma NOVA operação (novo externalTransactionId).
 *  - FAILED é falha permanente de infraestrutura, auditável.
 */
export enum FailureCode {
  // ---- saldo
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão (ROLLBACK de WIN/REFUND) que deixaria o saldo negativo. Situação operacional diferente de uma aposta sem saldo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // ---- coerência com a wallet
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',

  // ---- referência
  /** Referência não apareceu dentro do limite de tentativas / TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas não está PROCESSED (foi REJECTED/FAILED). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência pertence a outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Valor do REFUND/ROLLBACK diferente do valor da referência. */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  /** A referência já foi revertida. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  // ---- infraestrutura (status FAILED)
  ProcessingFailed = 'PROCESSING_FAILED',
}

export const ALL_FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);
