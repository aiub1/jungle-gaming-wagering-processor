/**
 * Preload do `bun test`: aponta TUDO para recursos de teste isolados (banco
 * `wagering_test`, filas `test-*`) e acelera timers. Testes de integração
 * usam PostgreSQL e SQS (MiniStack) reais — `bun run infra:up` antes.
 */
const defaults: Record<string, string> = {
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:55432/wagering_test',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  SQS_COMMANDS_QUEUE: 'test-wager-transactions.fifo',
  SQS_COMMANDS_DLQ: 'test-wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'test-wagering-events.fifo',
  LOG_LEVEL: 'silent',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
  SQS_RETRY_BASE_SECONDS: '1',
  SQS_RETRY_MAX_SECONDS: '2',
  SQS_MAX_RECEIVE_COUNT: '3',
  OUTBOX_POLL_MS: '100',
  OUTBOX_LEASE_MS: '2000',
  PENDING_REF_POLL_MS: '100',
  PENDING_REF_BASE_DELAY_MS: '100',
  PENDING_REF_MAX_DELAY_MS: '400',
  PENDING_REF_MAX_ATTEMPTS: '4',
  DB_POOL_MAX: '20',
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
