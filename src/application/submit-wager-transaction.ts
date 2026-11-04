import { InboxMessage } from '../domain/messaging';
import { WagerTransaction } from '../domain/wager-transaction';
import type { SubmitWagerCommand } from './commands';
import { ConflictError, NotFoundError } from './errors';
import type { Clock, FaultInjector, IdGenerator, Metrics, TransactionScope, UnitOfWork } from './ports';
import { type CausalContext, toResult, type WagerResult, type WagerSettlementService } from './wager-settlement.service';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** hash do corpo bruto da mensagem SQS */
  payloadHash: string;
}

export interface SubmitContext extends CausalContext {
  channel: 'http' | 'sqs';
  /** presente quando a entrada é SQS: dedup persistente na mesma transação */
  inbox?: InboxContext;
}

export interface SubmitWagerOutput extends WagerResult {
  /** a mensagem SQS já tinha sido processada (inbox) */
  duplicateMessage: boolean;
}

/**
 * Caso de uso ÚNICO para HTTP e SQS.
 *
 * Fluxo (uma transação SQL, READ COMMITTED):
 *  1. [SQS] INSERT inbox ON CONFLICT DO NOTHING — duplicata concorrente espera o commit da primeira;
 *  2. SELECT wallet FOR UPDATE — ponto de serialização por wallet, entre todas as instâncias;
 *  3. busca idempotente por (provider, key) OU (provider, externalId) — já sob o lock, então
 *     duplicatas concorrentes enxergam o commit anterior e viram replay;
 *  4. regras de domínio → saldo + ledger + transação + outbox (+ inbox) → COMMIT.
 *
 * Nada é publicado aqui: o evento só sai pela outbox, depois do commit.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlementService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
  ) {}

  async execute(cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitWagerOutput> {
    const started = performance.now();
    const output = await this.uow.run((scope) => this.process(scope, cmd, ctx), { operation: 'submit-wager' });
    this.metrics.processingLatency(ctx.channel, (performance.now() - started) / 1000);
    if (output.idempotentReplay) this.metrics.duplicateDetected(output.duplicateMessage ? 'inbox' : 'idempotency');
    else this.metrics.transactionFinished(cmd.kind, output.status, ctx.channel);
    return output;
  }

  private async process(scope: TransactionScope, cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitWagerOutput> {
    let duplicateMessage = false;
    if (ctx.inbox) {
      const inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: this.clock.now() });
      inbox.markProcessed(this.clock.now()); // efeito e inbox commitam juntos
      if (!(await scope.inbox.tryInsert(inbox))) {
        const existing = await scope.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (existing && !existing.matchesPayload(ctx.inbox.payloadHash)) {
          throw new ConflictError('INBOX_MESSAGE_CONFLICT', `messageId ${ctx.inbox.messageId} reused with a different body`);
        }
        duplicateMessage = true;
      }
    }

    const wallet = await scope.wallets.lockById(cmd.walletId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${cmd.walletId} not found`);

    const existing = await scope.transactions.findByIdempotencyKeyOrExternalId(
      cmd.providerId,
      cmd.idempotencyKey,
      cmd.externalTransactionId,
    );
    if (existing.length > 0) {
      const byKey = existing.find((t) => t.idempotencyKey === cmd.idempotencyKey);
      if (!byKey) {
        throw new ConflictError(
          'EXTERNAL_ID_REUSED',
          `externalTransactionId ${cmd.externalTransactionId} already submitted with another Idempotency-Key`,
          existing[0]?.id,
        );
      }
      if (!byKey.matchesPayload(cmd.payloadHash)) {
        // mesma key, payload diferente: conflito, NUNCA replay
        throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key reused with a different payload', byKey.id);
      }
      return { ...toResult(byKey, wallet.balance.toJSON(), true), duplicateMessage };
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });

    await this.settlement.settle(scope, tx, wallet, ctx, true);
    await this.faults.hit('wager.before-commit');
    return { ...toResult(tx, wallet.balance.toJSON(), false), duplicateMessage };
  }
}
