import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/ports';

/**
 * Métricas Prometheus (GET /metrics). Cobrem o mínimo pedido: transações por
 * status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions decided, by kind/status/channel',
    labelNames: ['kind', 'status', 'channel'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates detected (idempotent replay or inbox redelivery)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by operation and reason',
    labelNames: ['operation', 'reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and serialization failures',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the DLQ',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager submission',
    labelNames: ['channel'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly reconciliation = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Wallets whose stored balance differs from the ledger',
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionFinished(kind: string, status: string, channel: string): void {
    this.transactions.inc({ kind, status, channel });
  }
  duplicateDetected(source: 'idempotency' | 'inbox'): void {
    this.duplicates.inc({ source });
  }
  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  dlq(reason: string): void {
    this.dlqMessages.inc({ reason });
  }
  processingLatency(channel: string, seconds: number): void {
    this.latency.observe({ channel }, seconds);
  }
  reconciliationMismatch(): void {
    this.reconciliation.inc();
  }
}
