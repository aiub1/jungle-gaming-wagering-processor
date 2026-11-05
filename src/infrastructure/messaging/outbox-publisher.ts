import type { Clock, FaultInjector } from '../../application/ports';
import type { OutboxMessage, OutboxRetryPolicy } from '../../domain/messaging';
import type { Logger } from '../observability/logger';
import type { PromMetrics } from '../observability/metrics';
import type { PgOutboxStore } from '../persistence/pg-outbox-store';
import { PollingWorker } from '../workers/polling-worker';
import type { SqsGateway } from './sqs';

export interface OutboxPublisherSettings {
  owner: string;
  queue: string;
  batchSize: number;
  leaseMs: number;
  pollMs: number;
  /** partições publicando em paralelo (cada wallet sempre na mesma) */
  parallelism: number;
  retry: OutboxRetryPolicy;
}

/**
 * Publica eventos da outbox no SQS (`wagering-events.fifo`).
 *
 * - Claim com lease + SKIP LOCKED → N publishers concorrentes, lotes disjuntos.
 * - Publicação FORA de transação; depois marca publicado (ou agenda retry).
 * - Morreu entre publicar e marcar? A lease expira, outra instância republica:
 *   at-least-once. O `eventId` vai como MessageDeduplicationId (dedup do broker
 *   em 5 min — otimização) e no envelope, para o consumidor deduplicar (garantia).
 * - Ordem: MessageGroupId = walletId; eventos da mesma wallet saem em ordem de
 *   `seq` (mesma partição, sequencial), e uma falha adia o resto daquela wallet
 *   (não marca publicado um evento "por cima" de um buraco).
 */
export class OutboxPublisher extends PollingWorker {
  constructor(
    private readonly store: PgOutboxStore,
    private readonly sqs: SqsGateway,
    private readonly settings: OutboxPublisherSettings,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly metrics: PromMetrics,
    logger: Logger,
  ) {
    super('outbox-publisher', logger, settings.pollMs);
  }

  protected override async tick(): Promise<boolean> {
    const published = await this.publishOnce();
    const lag = await this.store.lag();
    this.metrics.outboxPending.set(lag.pending);
    this.metrics.outboxLag.set(lag.oldestAgeSeconds);
    return published > 0;
  }

  override async stop(): Promise<void> {
    await super.stop();
    await this.store.releaseLeases(this.settings.owner).catch(() => undefined);
  }

  /** Uma rodada de claim → publish → mark. Retorna quantas foram publicadas. */
  async publishOnce(): Promise<number> {
    const claimed = await this.store.claim(this.settings.owner, this.settings.batchSize, this.settings.leaseMs);
    if (claimed.length === 0) return 0;
    await this.faults.hit('outbox.after-claim-before-publish');

    // Partições por hash(groupKey): cada wallet cai sempre na mesma partição,
    // que publica em sequência (ordem de seq) em lotes de até 10 MISTURANDO
    // wallets; partições diferentes publicam em paralelo.
    const partitions: OutboxMessage[][] = Array.from({ length: this.settings.parallelism }, () => []);
    for (const { message } of claimed) partitions[hashKey(message.groupKey) % this.settings.parallelism]?.push(message);

    let published = 0;
    await Promise.all(
      partitions.map(async (partition) => {
        const broken = new Set<string>(); // wallets com falha neste ciclo: o resto delas espera
        for (let start = 0; start < partition.length; start += 10) {
          const chunk = partition.slice(start, start + 10).filter((m) => {
            if (!broken.has(m.groupKey)) return true;
            void this.retryLater(m, 'previous event of this wallet failed');
            return false;
          });
          if (chunk.length === 0) continue;
          let failed: Set<string>;
          let reason = 'partial batch failure';
          try {
            failed = await this.sqs.sendBatch(
              this.settings.queue,
              chunk.map((m) => ({
                id: m.id,
                body: JSON.stringify(m.payload),
                groupId: m.groupKey,
                dedupId: m.id, // eventId
                attributes: { eventType: m.eventType },
              })),
            );
          } catch (error) {
            failed = new Set(chunk.map((m) => m.id));
            reason = (error as Error).message ?? String(error);
          }

          // Dentro do lote, uma wallet com falha não pode ter eventos POSTERIORES
          // marcados como publicados (o SQS pode ter aceito um evento seguinte):
          // eles são reenviados no retry e a dedup por eventId absorve a repetição.
          const sent: OutboxMessage[] = [];
          for (const m of chunk) {
            if (failed.has(m.id) || broken.has(m.groupKey)) {
              broken.add(m.groupKey);
              await this.retryLater(m, reason);
            } else {
              sent.push(m);
            }
          }
          if (sent.length > 0) {
            await this.faults.hit('outbox.after-publish-before-mark');
            const now = this.clock.now();
            for (const m of sent) m.markPublished(now);
            const marked = await this.store.markManyPublished(this.settings.owner, sent.map((m) => m.id), now);
            published += marked;
            this.metrics.outboxPublished.inc(marked);
          }
        }
      }),
    );
    return published;
  }

  private async retryLater(message: OutboxMessage, reason: string): Promise<void> {
    this.metrics.retry('outbox-publish', 'publish-failed');
    this.logger.warn({ eventId: message.id, reason }, 'outbox publish failed; scheduling retry');
    message.scheduleRetry(this.clock.now(), this.settings.retry);
    await this.store.scheduleRetry(this.settings.owner, message, reason).catch(() => undefined);
  }
}

/** FNV-1a 32 bits: estável entre processos (diferente de um Map/random). */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
