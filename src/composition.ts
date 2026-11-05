import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from './application/open-wallet';
import { ProcessPendingReferences } from './application/process-pending-references';
import { ReconcileWallet, WalletQueries } from './application/queries';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerSettlementService } from './application/wager-settlement.service';
import type { AppConfig } from './infrastructure/config';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { SqsGateway } from './infrastructure/messaging/sqs';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { createLogger, type Logger } from './infrastructure/observability/logger';
import { PromMetrics } from './infrastructure/observability/metrics';
import { createOrm } from './infrastructure/persistence/mikro-orm';
import { PgOutboxStore } from './infrastructure/persistence/pg-outbox-store';
import { PgReadModel } from './infrastructure/persistence/pg-read-model';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { ConfigurableFaultInjector, SystemClock, UuidV7Generator } from './infrastructure/system';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';

/**
 * Composition root: monta o grafo de objetos uma vez, sem framework. O Nest só
 * recebe o resultado pronto (controllers), e os testes de integração usam o
 * mesmo `buildCore` sem subir HTTP. Uma única fonte de wiring para tudo.
 */
export interface Core {
  config: AppConfig;
  logger: Logger;
  metrics: PromMetrics;
  orm: MikroORM;
  sqs: SqsGateway;
  faults: ConfigurableFaultInjector;
  outboxStore: PgOutboxStore;
  submitWager: SubmitWagerTransaction;
  openWallet: OpenWallet;
  queries: WalletQueries;
  reconcile: ReconcileWallet;
  pendingReferences: ProcessPendingReferences;
  consumer: SqsWagerConsumer;
  publisher: OutboxPublisher;
  pendingWorker: PendingReferenceWorker;
  readiness(): Promise<{ ready: boolean; checks: Record<string, { ok: boolean; error?: string }> }>;
  startWorkers(): void;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

export async function buildCore(config: AppConfig): Promise<Core> {
  const logger = createLogger(config.logLevel, config.instanceId);
  const metrics = new PromMetrics();
  const orm = await createOrm(config.databaseUrl, config.db.poolMax);
  const sqs = new SqsGateway(config.aws);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const faults = new ConfigurableFaultInjector(config.faults);
  const uow = new MikroOrmUnitOfWork(orm, config.db, metrics, logger);
  const readModel = new PgReadModel(orm);
  const outboxStore = new PgOutboxStore(orm);

  const settlement = new WagerSettlementService(ids, clock, config.pendingReferences);
  const submitWager = new SubmitWagerTransaction(uow, settlement, ids, clock, metrics, faults);
  const openWallet = new OpenWallet(uow, ids, clock);
  const queries = new WalletQueries(readModel);
  const reconcile = new ReconcileWallet(readModel, metrics, (report) =>
    logger.error({ walletId: report.walletId, checks: report.checks, checkedEntries: report.checkedEntries }, 'wallet reconciliation mismatch'),
  );
  const pendingReferences = new ProcessPendingReferences(uow, settlement, clock, metrics);

  const consumer = new SqsWagerConsumer(sqs, submitWager, config.sqs, metrics, faults, logger);
  const publisher = new OutboxPublisher(
    outboxStore,
    sqs,
    {
      owner: config.instanceId,
      queue: config.sqs.eventsQueue,
      batchSize: config.outbox.batchSize,
      leaseMs: config.outbox.leaseMs,
      pollMs: config.outbox.pollMs,
      parallelism: config.outbox.parallelism,
      retry: { baseDelayMs: config.outbox.retryBaseMs, maxDelayMs: config.outbox.retryMaxMs },
    },
    clock,
    faults,
    metrics,
    logger,
  );
  const pendingWorker = new PendingReferenceWorker(pendingReferences, config.pendingReferences.pollMs, logger);

  const withTimeout = async (p: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    config,
    logger,
    metrics,
    orm,
    sqs,
    faults,
    outboxStore,
    submitWager,
    openWallet,
    queries,
    reconcile,
    pendingReferences,
    consumer,
    publisher,
    pendingWorker,
    async readiness() {
      const checks: Record<string, { ok: boolean; error?: string }> = {};
      await Promise.all([
        withTimeout(orm.em.fork().execute('select 1'), 2_000).then(
          () => (checks.postgres = { ok: true }),
          (e: Error) => (checks.postgres = { ok: false, error: e.message }),
        ),
        withTimeout(sqs.ping(config.sqs.commandsQueue), 2_000).then(
          () => (checks.sqs = { ok: true }),
          (e: Error) => (checks.sqs = { ok: false, error: e.message }),
        ),
      ]);
      return { ready: Object.values(checks).every((c) => c.ok), checks };
    },
    startWorkers() {
      consumer.start();
      publisher.start();
      pendingWorker.start();
    },
    async stopWorkers() {
      await Promise.all([consumer.stop(), publisher.stop(), pendingWorker.stop()]);
    },
    async close() {
      await Promise.all([consumer.stop(), publisher.stop(), pendingWorker.stop()]);
      sqs.client.destroy();
      await orm.close(true);
    },
  };
}
