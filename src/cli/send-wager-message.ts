import { loadConfig } from '../infrastructure/config';
import { SqsGateway } from '../infrastructure/messaging/sqs';

/**
 * Demo: publica um WagerTransactionRequested na fila de comandos.
 *   bun src/cli/send-wager-message.ts <walletId> <playerId> <kind> <amount> [refExternalId] [messageId]
 * Reenviar com o MESMO messageId simula redelivery (o inbox deduplica).
 */
const [walletId, playerId, kind = 'BET', amount = '10.00', ref, messageIdArg] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('usage: send-wager-message.ts <walletId> <playerId> <kind> <amount> [refExternalId] [messageId]');
  process.exit(1);
}
const config = loadConfig();
const messageId = messageIdArg ?? `msg-${crypto.randomUUID()}`;
// determinístico por messageId: reenviar o mesmo messageId gera o MESMO corpo (redelivery legítima)
const externalTransactionId = `cli-${messageId}`;
const envelope = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: process.env.ROUND_ID ?? 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(ref ? { referenceExternalTransactionId: ref } : {}),
  },
};
await new SqsGateway(config.aws).send(config.sqs.commandsQueue, JSON.stringify(envelope), walletId, crypto.randomUUID());
console.log(JSON.stringify({ sent: envelope }, null, 2));
