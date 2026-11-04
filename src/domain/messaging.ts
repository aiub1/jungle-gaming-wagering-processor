import type { IntegrationEvent } from './integration-events';

// ------------------------------------------------------------------ Inbox

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de deduplicação persistente por (consumerName, messageId). É gravado
 * na MESMA transação SQL do efeito financeiro: se a linha existe, o efeito existe.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) return; // idempotente
    this._processedAt = at;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}

// ------------------------------------------------------------------ Outbox

export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: OutboxRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  /** chave de ordenação/particionamento (walletId) → MessageGroupId do SQS FIFO */
  groupKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly groupKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** id da mensagem = eventId: é o que permite ao consumidor deduplicar. */
  static enqueue(event: IntegrationEvent<unknown>, groupKey: string): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      groupKey,
      event.eventType,
      envelope as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.groupKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt) return;
    this._publishedAt = at;
  }

  /**
   * Incrementa attempts e agenda a próxima tentativa com backoff exponencial
   * limitado + jitter. A outbox nunca desiste: perder evento confirmado é
   * proibido, então o limite é de atraso, não de tentativas (o lag vira métrica).
   */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY, random: () => number = Math.random): void {
    this._attempts += 1;
    const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (this._attempts - 1));
    const jitter = Math.floor(exp * 0.2 * random());
    this._nextAttemptAt = new Date(now.getTime() + exp + jitter);
  }
}
