import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/integration-events';
import { OutboxMessage } from '../domain/messaging';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { payloadHash } from './payload-hash';
import { INTERNAL_PROVIDER_ID, type OpenWalletCommand } from './commands';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import type { CausalContext } from './wager-settlement.service';

export interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/**
 * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a transação
 * interna OPENING (PROCESSED) e o lançamento CREDIT correspondente — assim a
 * invariante "saldo == soma do ledger" vale desde o primeiro instante.
 * Duplicidade (playerId + currency) é barrada pela UNIQUE do banco → 409.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: OpenWalletCommand, ctx: CausalContext): Promise<WalletView> {
    return this.uow.run(
      async (scope) => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance: cmd.initialBalance,
          openingTransactionId,
          openingEntryId: this.ids.next(),
          at: now,
        });
        await scope.wallets.insert(wallet);

        if (openingEntry) {
          const business = {
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${walletId}`,
            playerId: cmd.playerId,
            walletId,
            roundId: 'opening',
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
          };
          const opening = WagerTransaction.create({
            ...business,
            id: openingTransactionId,
            idempotencyKey: business.externalTransactionId,
            payloadHash: payloadHash({ ...business, money: cmd.initialBalance.toJSON() }),
            money: cmd.initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);
          await scope.transactions.insert(opening);
          await scope.ledger.append(openingEntry);
          const eventCtx = () => ({ eventId: this.ids.next(), ...ctx, occurredAt: now });
          await scope.outbox.add([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, eventCtx()), walletId),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventCtx()), walletId),
          ]);
        }
        return toWalletView(wallet);
      },
      { operation: 'open-wallet' },
    );
  }
}
