/**
 * Erros de domínio. Nenhum deles conhece HTTP ou SQS: a tradução para status
 * code / ack / DLQ é feita nas bordas (interfaces e consumidor).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que viola o contrato (formato, escala, sinal...). Nunca é persistida. */
export class InvalidInputError extends DomainError {
  readonly code = 'INVALID_INPUT';

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('insufficient funds');
  }
}

/**
 * Tentativa de transicionar uma transação a partir de um estado terminal (ou
 * uma transição não prevista). É erro de programação, não caminho de negócio.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** Violação de invariante interna (ex.: lançamento de ledger desbalanceado). */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}
