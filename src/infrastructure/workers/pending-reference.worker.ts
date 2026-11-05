import type { ProcessPendingReferences } from '../../application/process-pending-references';
import type { Logger } from '../observability/logger';
import { PollingWorker } from './polling-worker';

/** Agenda o reprocessamento de PENDING_REFERENCE (backoff exponencial por item). */
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly useCase: ProcessPendingReferences,
    pollMs: number,
    logger: Logger,
  ) {
    super('pending-reference-worker', logger, pollMs);
  }

  protected override async tick(): Promise<boolean> {
    const result = await this.useCase.runOnce();
    if (result.scanned > 0) this.logger.info({ ...result }, 'pending references reprocessed');
    // lote cheio (50) → provavelmente há mais vencidos; roda de novo sem dormir
    return result.scanned >= 50;
  }
}
