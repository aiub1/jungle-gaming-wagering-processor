/**
 * Configuração 100% por variáveis de ambiente (12-factor), lida uma vez e
 * congelada. Valores default servem para desenvolvimento local.
 */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10); // configuração, não dinheiro
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid integer env ${name}=${raw}`);
  return value;
}

function str(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export type AppRole = 'api' | 'worker' | 'all';

export interface AppConfig {
  role: AppRole;
  instanceId: string;
  port: number;
  databaseUrl: string;
  db: {
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    maxAttempts: number;
  };
  aws: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
  sqs: {
    commandsQueue: string;
    commandsDlq: string;
    eventsQueue: string;
    consumerName: string;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    maxReceiveCount: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
    concurrency: number;
  };
  outbox: { pollMs: number; batchSize: number; leaseMs: number; parallelism: number; retryBaseMs: number; retryMaxMs: number };
  pendingReferences: { pollMs: number; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  shutdownGraceMs: number;
  logLevel: string;
  faults: string[];
}

export function loadConfig(): AppConfig {
  const role = str('APP_ROLE', 'all');
  if (role !== 'api' && role !== 'worker' && role !== 'all') throw new Error(`invalid APP_ROLE ${role}`);
  return Object.freeze({
    role,
    instanceId: str('INSTANCE_ID', `${process.env.HOSTNAME ?? 'local'}-${process.pid}`),
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL', 'postgresql://wagering:wagering@localhost:55432/wagering'),
    db: {
      poolMax: int('DB_POOL_MAX', 10),
      lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 2_000),
      statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 10_000),
      maxAttempts: int('DB_TX_MAX_ATTEMPTS', 4),
    },
    aws: {
      endpoint: str('AWS_ENDPOINT_URL', 'http://localhost:4566'),
      region: str('AWS_REGION', 'us-east-1'),
      accessKeyId: str('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      commandsQueue: str('SQS_COMMANDS_QUEUE', 'wager-transactions.fifo'),
      commandsDlq: str('SQS_COMMANDS_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueue: str('SQS_EVENTS_QUEUE', 'wagering-events.fifo'),
      consumerName: str('SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      retryBaseSeconds: int('SQS_RETRY_BASE_SECONDS', 2),
      retryMaxSeconds: int('SQS_RETRY_MAX_SECONDS', 60),
      concurrency: int('SQS_CONCURRENCY', 10),
    },
    outbox: {
      pollMs: int('OUTBOX_POLL_MS', 500),
      batchSize: int('OUTBOX_BATCH_SIZE', 200),
      leaseMs: int('OUTBOX_LEASE_MS', 30_000),
      parallelism: Math.max(1, int('OUTBOX_PARALLELISM', 8)),
      retryBaseMs: int('OUTBOX_RETRY_BASE_MS', 1_000),
      retryMaxMs: int('OUTBOX_RETRY_MAX_MS', 60_000),
    },
    pendingReferences: {
      pollMs: int('PENDING_REF_POLL_MS', 1_000),
      maxAttempts: int('PENDING_REF_MAX_ATTEMPTS', 10),
      baseDelayMs: int('PENDING_REF_BASE_DELAY_MS', 1_000),
      maxDelayMs: int('PENDING_REF_MAX_DELAY_MS', 60_000),
    },
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 20_000),
    logLevel: str('LOG_LEVEL', 'info'),
    faults: str('FAULTS', '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  });
}
