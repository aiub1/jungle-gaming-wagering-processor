import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ConflictError, NotFoundError, TransientInfrastructureError } from '../../application/errors';
import { InvalidInputError } from '../../domain/errors';
import type { Logger } from '../../infrastructure/observability/logger';

/**
 * Mapeamento HTTP ÚNICO e consistente entre todos os endpoints. O provedor
 * decide se reenvia pelo STATUS, sem interpretar mensagem:
 *
 *   400 INVALID_INPUT          payload inválido            → corrigir, não reenviar igual
 *   404 *_NOT_FOUND            recurso inexistente         → corrigir
 *   409 IDEMPOTENCY_KEY_REUSED / EXTERNAL_ID_REUSED / WALLET_ALREADY_EXISTS → conflito, não é replay
 *   422 (body com status REJECTED + failureCode) rejeição de negócio (terminal)
 *   202 (body com status PENDING_REFERENCE)     aceito, processamento pendente
 *   503 TRANSIENT_FAILURE + Retry-After          falha transitória → reenviar a MESMA requisição
 *   500 INTERNAL_ERROR         defeito
 *
 * Corpo de erro: { error: { code, message, retryable, field?, transactionId? } }
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string, retryable: boolean, extra: Record<string, unknown> = {}) =>
      res.status(status).json({ error: { code, message, retryable, ...extra } });

    if (exception instanceof InvalidInputError) {
      return void send(400, exception.code, exception.message, false, exception.field ? { field: exception.field } : {});
    }
    if (exception instanceof NotFoundError) return void send(404, exception.code, exception.message, false);
    if (exception instanceof ConflictError) {
      return void send(409, exception.code, exception.message, false, exception.existingTransactionId ? { transactionId: exception.existingTransactionId } : {});
    }
    if (exception instanceof TransientInfrastructureError) {
      res.setHeader('Retry-After', '1');
      return void send(503, exception.code, 'temporarily unavailable, retry the same request', true);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // body JSON malformado chega aqui como 400 do body-parser
      return void send(status, status === 400 ? 'INVALID_INPUT' : 'HTTP_ERROR', exception.message, status >= 500);
    }
    if ((exception as { type?: string })?.type === 'entity.parse.failed') {
      return void send(400, 'INVALID_INPUT', 'malformed JSON body', false);
    }
    this.logger.error({ err: exception }, 'unhandled error');
    return void send(500, 'INTERNAL_ERROR', 'internal error', true);
  }
}
