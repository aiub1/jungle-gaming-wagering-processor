import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import type { Metrics, TransactionScope, UnitOfWork, UnitOfWorkOptions } from '../../application/ports';
import type { Logger } from '../observability/logger';
import { transientReason } from './pg-errors';
import { PgRepositories } from './pg-repositories';

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxAttempts: number;
}

/**
 * Implementação MikroORM da Unit of Work.
 *
 * - Cada tentativa usa `orm.em.fork()` (EntityManager/Identity Map isolado) e
 *   `transactional()` com isolamento EXPLÍCITO (READ COMMITTED). O lock da
 *   wallet é quem serializa; sob READ COMMITTED cada statement após o lock
 *   enxerga o commit da transação anterior — por isso duplicatas viram replay.
 * - `lock_timeout`/`statement_timeout` via `set_config(..., true)` (= SET LOCAL):
 *   valem só para esta transação e não vazam para a conexão do pool.
 * - Erros transitórios refazem a transação INTEIRA (o callback relê tudo, nada
 *   de estado mutado de uma tentativa abortada é reaproveitado), com backoff +
 *   jitter. Esgotou → TransientInfrastructureError (503 / retry no SQS).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(
          async (em: EntityManager) => {
            await em.execute(`select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`, [
              `${this.settings.lockTimeoutMs}ms`,
              `${this.settings.statementTimeoutMs}ms`,
            ]);
            return work(new PgRepositories(em));
          },
          {
            isolationLevel: options.readOnlySnapshot ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
            readOnly: options.readOnlySnapshot ?? false,
          },
        );
      } catch (error) {
        const reason = transientReason(error);
        if (!reason) throw error;
        if (reason === 'lock_timeout' || reason === 'deadlock' || reason === 'serialization') this.metrics.lockConflict(reason);
        if (attempt >= this.settings.maxAttempts) {
          this.logger.warn({ operation: options.operation, reason, attempts: attempt }, 'transaction retries exhausted');
          throw new TransientInfrastructureError(`${options.operation} failed transiently (${reason})`, reason, error);
        }
        this.metrics.retry(options.operation, reason);
        await Bun.sleep(backoffMs(attempt));
      }
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(400, 25 * 2 ** attempt);
  return base + Math.floor(Math.random() * base);
}
