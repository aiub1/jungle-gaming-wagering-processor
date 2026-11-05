import { loadConfig } from '../infrastructure/config';
import { SqsGateway } from '../infrastructure/messaging/sqs';

/** Cria (idempotente) as filas FIFO: comandos, DLQ e eventos. */
const config = loadConfig();
await new SqsGateway(config.aws).ensureQueues(config.sqs);
console.log(JSON.stringify({ msg: 'queues ready', queues: [config.sqs.commandsQueue, config.sqs.commandsDlq, config.sqs.eventsQueue] }));
