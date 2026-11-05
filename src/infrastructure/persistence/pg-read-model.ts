import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { LedgerEntryView, ReadModel, ReconciliationRaw } from '../../application/queries';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { mapLedgerEntry, mapTransaction, mapWallet, TX_SELECT, ts, WALLET_COLUMNS } from './pg-repositories';

type Row = Record<string, unknown>;

/** Leituras sem lock (READ COMMITTED autocommit), exceto a reconciliação. */
export class PgReadModel implements ReadModel {
  constructor(private readonly orm: MikroORM) {}

  private get em() {
    return this.orm.em.fork();
  }

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<Row[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    return rows[0] ? mapWallet(rows[0]) : undefined;
  }

  async ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]> {
    const rows = await this.em.execute<Row[]>(
      `SELECT id, wallet_id, transaction_id, wallet_version, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after, ${ts('created_at')}
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND wallet_version > ?
        ORDER BY wallet_version
        LIMIT ?`,
      [walletId, afterVersion, limit],
    );
    return rows.map(mapLedgerEntry).map((e) => ({
      id: e.id,
      transactionId: e.transactionId,
      walletVersion: e.walletVersion,
      direction: e.direction,
      money: e.money.toJSON(),
      balanceBefore: e.balanceBefore.toJSON(),
      balanceAfter: e.balanceAfter.toJSON(),
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async findTransaction(id: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<Row[]>(`${TX_SELECT} WHERE t.id = ?`, [id]);
    return rows[0] ? mapTransaction(rows[0]) : undefined;
  }

  async findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<Row[]>(`${TX_SELECT} WHERE t.provider_id = ? AND t.external_transaction_id = ?`, [
      providerId,
      externalId,
    ]);
    return rows[0] ? mapTransaction(rows[0]) : undefined;
  }

  /**
   * Snapshot REPEATABLE READ READ ONLY: wallet e ledger lidos no MESMO instante
   * lógico, sem travar a wallet (não compete com o tráfego de uma hot wallet).
   * A soma é feita pelo PostgreSQL em NUMERIC (exato) e volta como texto.
   */
  async reconciliationSnapshot(walletId: string): Promise<ReconciliationRaw | undefined> {
    return this.orm.em.fork().transactional(
      async (em) => {
        const rows = await em.execute<Row[]>(
          `SELECT w.id, w.currency, w.balance_amount::text AS stored, w.version,
                  COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(30,2)::text AS ledger_sum,
                  COUNT(l.id)::int AS entries,
                  MAX(l.wallet_version) AS last_version,
                  -- versões devem ser contíguas (1..N com abertura, 2..N sem): buracos = faixa − distintas
                  COALESCE(MAX(l.wallet_version) - MIN(l.wallet_version) + 1 - COUNT(DISTINCT l.wallet_version), 0) AS gaps
             FROM wallets w
             LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
            WHERE w.id = ?
            GROUP BY w.id`,
          [walletId],
        );
        const r = rows[0];
        if (!r) return undefined;
        return {
          walletId: String(r.id),
          currency: String(r.currency),
          storedBalance: String(r.stored),
          ledgerSum: String(r.ledger_sum),
          checkedEntries: Number(r.entries),
          lastEntryVersion: r.last_version === null ? null : Number(r.last_version),
          walletVersion: Number(r.version),
          versionGaps: Number(r.gaps),
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
