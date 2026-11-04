/**
 * Erros de aplicação. Cada classe corresponde a uma categoria que as bordas
 * traduzem de forma consistente:
 *
 * | Classe                         | HTTP | SQS                    |
 * |--------------------------------|------|------------------------|
 * | InvalidInputError (domínio)    | 400  | DLQ (permanente)       |
 * | NotFoundError                  | 404  | DLQ (permanente)       |
 * | ConflictError                  | 409  | DLQ (permanente)       |
 * | (rejeição de negócio)          | 422  | ack (terminal)         |
 * | (PENDING_REFERENCE)            | 202  | ack                    |
 * | TransientInfrastructureError   | 503  | retry com backoff      |
 * | qualquer outro                 | 500  | retry → DLQ no limite  |
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(
    readonly code:
      | 'IDEMPOTENCY_KEY_REUSED' // mesma key, payload diferente
      | 'EXTERNAL_ID_REUSED' // mesmo (provider, externalId) com outra key
      | 'WALLET_ALREADY_EXISTS'
      | 'INBOX_MESSAGE_CONFLICT', // mesmo messageId com corpo diferente
    message: string,
    readonly existingTransactionId?: string,
  ) {
    super(message);
  }
}

/** Banco/SQS indisponível, lock timeout, deadlock após retries. Pode reenviar. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
