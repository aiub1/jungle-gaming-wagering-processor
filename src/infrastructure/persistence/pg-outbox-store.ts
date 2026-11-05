import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/messaging';
import { toDate, ts } from './pg-repositories';

type Row = Record<string, unknown>;

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  seq: bigint;
}

/**
 * Operações do publisher sobre a outbox, cada uma numa transação CURTA e
 * separada — a chamada de rede ao SQS nunca acontece com transação aberta.
 *
 * Claim com lease: `FOR UPDATE SKIP LOCKED` faz publishers concorrentes
 * pegarem lotes disjuntos sem esperar uns pelos outros; `locked_until` é a
 * lease. Se o processo morrer entre o claim e o mark, a lease expira e outra
 * instância reivindica a mensagem → at-least-once, nunca perda.
 */
export class PgOutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(owner: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]> {
    const rows = await this.orm.em.fork().execute<Row[]>(
      `WITH due AS (
         SELECT id FROM outbox_messages
          WHERE published_at IS NULL
            AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY seq
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_messages o
          SET locked_by = ?, locked_until = now() + (? || ' milliseconds')::interval
         FROM due WHERE o.id = due.id
       RETURNING o.id, o.seq::text AS seq, o.aggregate_id, o.group_key, o.event_type, o.payload, o.attempts,
                 ${ts('o.occurred_at', 'occurred_at')}, ${ts('o.next_attempt_at', 'next_attempt_at')}`,
      [limit, owner, String(leaseMs)],
    );
    return rows
      .map((r) => ({
        seq: BigInt(String(r.seq)),
        message: OutboxMessage.rehydrate({
          id: String(r.id),
          aggregateId: String(r.aggregate_id),
          groupKey: String(r.group_key),
          eventType: String(r.event_type),
          payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
          occurredAt: toDate(r.occurred_at) as Date,
          attempts: Number(r.attempts),
          nextAttemptAt: toDate(r.next_attempt_at),
        }),
      }))
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }

  /**
   * Marca um lote numa única ida ao banco. Só quem detém a lease marca (evita
   * que um publisher "atrasado" sobrescreva o retry agendado por outro).
   */
  async markManyPublished(owner: string, ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.orm.em.fork().execute<Row[]>(
      `UPDATE outbox_messages SET published_at = ?, locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = ANY(?::uuid[]) AND published_at IS NULL AND locked_by = ? RETURNING id`,
      [at, `{${ids.join(',')}}`, owner],
    );
    return rows.length;
  }

  async scheduleRetry(owner: string, message: OutboxMessage, error: string): Promise<void> {
    await this.orm.em.fork().execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
        WHERE id = ? AND published_at IS NULL AND locked_by = ?`,
      [message.attempts, message.nextAttemptAt, error.slice(0, 500), message.id, owner],
    );
  }

  /** Shutdown: devolve as leases para outra instância assumir na hora. */
  async releaseLeases(owner: string): Promise<void> {
    await this.orm.em.fork().execute(
      `UPDATE outbox_messages SET locked_by = NULL, locked_until = NULL WHERE locked_by = ? AND published_at IS NULL`,
      [owner],
    );
  }

  /** Lag = idade da mensagem pendente mais antiga (segundos) + quantidade pendente. */
  async lag(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.orm.em.fork().execute<Row[]>(
      `SELECT count(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS age
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return { pending: Number(rows[0]?.pending ?? 0), oldestAgeSeconds: Number(rows[0]?.age ?? 0) };
  }
}
