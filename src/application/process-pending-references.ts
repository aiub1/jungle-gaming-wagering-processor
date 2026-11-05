import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { DomainError } from '../domain/errors';
import { TransientInfrastructureError } from './errors';
import type { Clock, Metrics, UnitOfWork } from './ports';
import type { WagerSettlementService } from './wager-settlement.service';

export interface PendingBatchResult {
  scanned: number;
  processed: number;
  rejected: number;
  stillPending: number;
  failed: number;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (backoff exponencial).
 *
 * Seguro com N instâncias: a lista de candidatos é lida sem lock; cada item
 * roda numa transação própria que trava a WALLET e depois a TRANSAÇÃO (mesma
 * ordem do caminho online → sem deadlock) e reconfere status/vencimento.
 * Dois workers no mesmo item: o segundo vê o estado já alterado e pula.
 */
export class ProcessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlementService,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<PendingBatchResult> {
    const result: PendingBatchResult = { scanned: 0, processed: 0, rejected: 0, stillPending: 0, failed: 0 };
    const candidates = await this.uow.run((s) => s.transactions.findDuePendingReferences(this.clock.now(), this.batchSize), {
      operation: 'pending-scan',
    });
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        const status = await this.processOne(candidate.id, candidate.walletId);
        if (status === WagerTransactionStatus.Processed) result.processed += 1;
        else if (status === WagerTransactionStatus.Rejected) result.rejected += 1;
        else if (status === WagerTransactionStatus.PendingReference) result.stillPending += 1;
      } catch (error) {
        if (error instanceof TransientInfrastructureError) continue; // fica para o próximo ciclo
        // Erro inesperado e não-transitório num item: marca FAILED (terminal e
        // auditável) para não travar a fila nem tentar para sempre.
        await this.markFailed(candidate.id, candidate.walletId, error);
        result.failed += 1;
      }
    }
    return result;
  }

  private async processOne(id: string, walletId: string): Promise<WagerTransactionStatus | undefined> {
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.lockById(walletId);
        const tx = await scope.transactions.lockById(id);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
        if (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt > this.clock.now()) return undefined;

        const ctx = { correlationId: tx.id, causationId: tx.id };
        await this.settlement.settle(scope, tx, wallet, ctx, false);
        this.metrics.transactionFinished(tx.kind, tx.status, 'pending-worker');
        if (tx.status === WagerTransactionStatus.PendingReference) this.metrics.retry('pending-reference', 'reference-missing');
        return tx.status;
      },
      { operation: 'pending-reference' },
    );
  }

  private async markFailed(id: string, walletId: string, error: unknown): Promise<void> {
    if (error instanceof DomainError && error.code === 'INVALID_TRANSACTION_STATE') return;
    await this.uow.run(
      async (scope) => {
        await scope.wallets.lockById(walletId);
        const tx = await scope.transactions.lockById(id);
        if (!tx || tx.isTerminal()) return;
        await this.settlement.fail(scope, tx, FailureCode.ProcessingFailed, { correlationId: tx.id, causationId: tx.id });
      },
      { operation: 'pending-reference-fail' },
    );
  }
}
