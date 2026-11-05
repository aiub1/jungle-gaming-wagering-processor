import { createHash } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import { parseSubmitWager } from '../../application/commands';
import { ApplicationError, ConflictError, NotFoundError, TransientInfrastructureError } from '../../application/errors';
import type { FaultInjector, Metrics } from '../../application/ports';
import type { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { InvalidInputError } from '../../domain/errors';
import type { AppConfig } from '../config';
import { enrichContext, runWithContext } from '../observability/context';
import type { Logger } from '../observability/logger';
import { receiveCount, type SqsGateway } from './sqs';

export const WAGER_REQUESTED = 'WagerTransactionRequested';

/** Erro permanente de mensagem: nunca vai dar certo reenviando → DLQ imediata. */
class PoisonMessageError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

type Disposition =
  | { type: 'ack'; outcome: string }
  | { type: 'retry'; reason: string; delaySeconds: number }
  | { type: 'dlq'; reason: string; detail: string };

/**
 * Consumidor da fila `wager-transactions.fifo`.
 *
 * - Reutiliza o MESMO use case da entrada HTTP (`SubmitWagerTransaction`).
 * - Dedup persistente pelo inbox `(consumerName, messageId)` dentro da transação.
 * - `DeleteMessage` (ack) SOMENTE depois do commit.
 * - Classificação de erro:
 *     negócio (PROCESSED / REJECTED / PENDING_REFERENCE / duplicata) → ack;
 *     transitório → ChangeMessageVisibility com backoff exponencial;
 *     permanente (contrato inválido, conflito, wallet inexistente) → DLQ + ack;
 *     transitório/inesperado na última tentativa (maxReceiveCount) → DLQ.
 * - Mesmo MessageGroupId (wallet) é processado em sequência; grupos diferentes
 *   em paralelo. O FIFO é otimização: a correção vem do lock + inbox no banco.
 * - SIGTERM: para de receber, termina o que está em andamento e devolve a
 *   visibilidade (0) do que ainda não começou.
 */
export class SqsWagerConsumer {
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private abort = new AbortController();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SqsGateway,
    private readonly submit: SubmitWagerTransaction,
    private readonly config: AppConfig['sqs'],
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    this.abort.abort();
    await this.loop;
    await Promise.allSettled([...this.inflight]);
  }

  private async run(): Promise<void> {
    this.logger.info({ worker: 'sqs-consumer', queue: this.config.commandsQueue }, 'worker started');
    while (this.running) {
      try {
        const messages = await this.sqs.receive(
          this.config.commandsQueue,
          Math.min(10, this.config.concurrency),
          this.config.waitTimeSeconds,
          this.config.visibilityTimeoutSeconds,
          this.abort.signal,
        );
        if (messages.length === 0) continue;
        const batch = this.processBatch(messages);
        this.inflight.add(batch);
        await batch.finally(() => this.inflight.delete(batch));
      } catch (error) {
        if (this.stopping) break;
        // SQS indisponível: espera e tenta de novo (readiness reporta o problema)
        this.logger.warn({ err: error }, 'sqs receive failed');
        await Bun.sleep(1_000);
      }
    }
    this.logger.info({ worker: 'sqs-consumer' }, 'worker stopped');
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            // não iniciada: devolve para outra instância pegar já
            await this.sqs.changeVisibility(this.config.commandsQueue, message, 0).catch(() => undefined);
            continue;
          }
          await this.handle(message);
        }
      }),
    );
  }

  /** Processa uma mensagem e aplica a disposição (ack / retry / DLQ). Exposto para testes. */
  async handle(message: Message): Promise<Disposition> {
    const body = message.Body ?? '';
    const attempts = receiveCount(message);
    const disposition = await this.decide(body, attempts);
    try {
      switch (disposition.type) {
        case 'ack':
          await this.faults.hit('sqs.after-commit-before-ack');
          await this.sqs.delete(this.config.commandsQueue, message);
          break;
        case 'retry':
          this.metrics.retry('sqs-message', disposition.reason);
          await this.sqs.changeVisibility(this.config.commandsQueue, message, disposition.delaySeconds);
          break;
        case 'dlq':
          await this.sendToDlq(message, disposition.reason, disposition.detail, attempts);
          await this.sqs.delete(this.config.commandsQueue, message);
          break;
      }
    } catch (error) {
      // Falha ao ack/mudar visibilidade: a mensagem volta sozinha após o
      // visibility timeout e o inbox garante que o efeito não se repete.
      this.logger.warn({ err: error, disposition: disposition.type }, 'failed to settle sqs message');
    }
    return disposition;
  }

  private async decide(body: string, attempts: number): Promise<Disposition> {
    let envelope: { messageId: string; correlationId?: string; data: unknown };
    try {
      envelope = parseEnvelope(body);
    } catch (error) {
      return this.permanent(error);
    }
    return runWithContext({ messageId: envelope.messageId, correlationId: envelope.correlationId ?? envelope.messageId }, async () => {
      try {
        const data = envelope.data as Record<string, unknown>;
        const cmd = parseSubmitWager(data, data?.idempotencyKey);
        enrichContext({ walletId: cmd.walletId, providerId: cmd.providerId });
        const result = await this.submit.execute(cmd, {
          channel: 'sqs',
          correlationId: envelope.correlationId ?? envelope.messageId,
          causationId: envelope.messageId,
          inbox: {
            consumerName: this.config.consumerName,
            messageId: envelope.messageId,
            payloadHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          },
        });
        enrichContext({ transactionId: result.transactionId });
        this.logger.info(
          { status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay, duplicate: result.duplicateMessage },
          'sqs message processed',
        );
        return { type: 'ack', outcome: result.status };
      } catch (error) {
        if (error instanceof InvalidInputError || error instanceof NotFoundError || error instanceof ConflictError) {
          return this.permanent(error);
        }
        const reason = error instanceof TransientInfrastructureError ? error.reason : 'unexpected';
        if (attempts >= this.config.maxReceiveCount) {
          this.logger.error({ err: error, attempts }, 'sqs message retries exhausted');
          return { type: 'dlq', reason: 'RETRIES_EXHAUSTED', detail: `${reason}: ${(error as Error).message}` };
        }
        const delaySeconds = Math.min(this.config.retryMaxSeconds, this.config.retryBaseSeconds * 2 ** (attempts - 1));
        this.logger.warn({ err: error, attempts, delaySeconds, reason }, 'sqs message will be retried');
        return { type: 'retry', reason, delaySeconds };
      }
    });
  }

  private permanent(error: unknown): Disposition {
    const reason =
      error instanceof PoisonMessageError
        ? error.reason
        : error instanceof ApplicationError || error instanceof InvalidInputError
          ? error.code
          : 'INVALID_MESSAGE';
    this.logger.warn({ reason, detail: (error as Error).message }, 'sqs message is permanently invalid');
    return { type: 'dlq', reason, detail: (error as Error).message };
  }

  private async sendToDlq(message: Message, reason: string, detail: string, attempts: number): Promise<void> {
    this.metrics.dlq(reason);
    await this.sqs.send(
      this.config.commandsDlq,
      message.Body ?? '',
      message.Attributes?.MessageGroupId ?? 'dlq',
      message.MessageId ?? createHash('sha256').update(message.Body ?? '').digest('hex'),
      { failureReason: reason, failureDetail: detail.slice(0, 250), receiveCount: String(attempts) },
    );
  }
}

function parseEnvelope(body: string): { messageId: string; correlationId?: string; data: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PoisonMessageError('INVALID_JSON', 'message body is not valid JSON');
  }
  const env = parsed as Record<string, unknown>;
  if (!env || typeof env !== 'object') throw new PoisonMessageError('INVALID_ENVELOPE', 'envelope must be an object');
  if (typeof env.messageId !== 'string' || env.messageId.length === 0 || env.messageId.length > 256) {
    throw new PoisonMessageError('INVALID_ENVELOPE', 'messageId is required');
  }
  if (env.type !== WAGER_REQUESTED) throw new PoisonMessageError('UNSUPPORTED_TYPE', `unsupported type ${String(env.type)}`);
  if (!env.data || typeof env.data !== 'object') throw new PoisonMessageError('INVALID_ENVELOPE', 'data is required');
  return {
    messageId: env.messageId,
    correlationId: typeof env.correlationId === 'string' ? env.correlationId : undefined,
    data: env.data,
  };
}
