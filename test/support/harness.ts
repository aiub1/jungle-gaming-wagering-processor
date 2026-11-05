import { createHash } from 'node:crypto';
import type { Subprocess } from 'bun';
import { PurgeQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { buildCore, type Core } from '../../src/composition';
import { type AppConfig, loadConfig } from '../../src/infrastructure/config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm';
import { parseOpenWallet, parseSubmitWager } from '../../src/application/commands';

export const ROOT = new URL('../..', import.meta.url).pathname;

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const saved = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    return loadConfig();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

let prepared: Promise<void> | undefined;

/** Uma vez por processo de teste: migrations no banco de teste + filas de teste. */
export function prepareInfra(): Promise<void> {
  prepared ??= (async () => {
    const config = loadConfig();
    const orm = await createOrm(config.databaseUrl, 2);
    try {
      await orm.migrator.up();
    } finally {
      await orm.close(true);
    }
    await new SqsGateway(config.aws).ensureQueues(config.sqs);
  })();
  return prepared;
}

/** Core in-process (mesmo wiring da aplicação), sem HTTP e com workers parados. */
export async function startCore(overrides: Record<string, string> = {}): Promise<Core> {
  await prepareInfra();
  return buildCore(testConfig({ INSTANCE_ID: `test-${crypto.randomUUID().slice(0, 8)}`, ...overrides }));
}

export async function purgeQueues(core: Core): Promise<void> {
  const { sqs, config } = core;
  for (const q of [config.sqs.commandsQueue, config.sqs.commandsDlq, config.sqs.eventsQueue]) {
    await sqs.client.send(new PurgeQueueCommand({ QueueUrl: await sqs.queueUrl(q) })).catch(() => undefined);
  }
}

export async function queueDepth(core: Core, queue: string): Promise<{ visible: number; inFlight: number }> {
  const r = await core.sqs.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await core.sqs.queueUrl(queue),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export const uuid = () => crypto.randomUUID();

export async function openWallet(core: Core, amount = '100.00', currency = 'BRL', playerId: string = uuid()) {
  return core.openWallet.execute(parseOpenWallet({ playerId, initialBalance: { amount, currency } }), { correlationId: uuid() });
}

export interface WagerInput {
  providerId?: string;
  externalTransactionId?: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(input: WagerInput) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    ...input,
  };
}

export function keyOf(body: { providerId: string; externalTransactionId: string }) {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export async function submit(core: Core, body: ReturnType<typeof wager>, key = keyOf(body)) {
  return core.submitWager.execute(parseSubmitWager(body, key), { channel: 'http', correlationId: uuid() });
}

/** Mensagem no formato do contrato da seção 10. */
export function sqsEnvelope(body: ReturnType<typeof wager>, messageId = `msg-${uuid()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: keyOf(body) },
  };
}

export async function sendCommand(core: Core, envelope: ReturnType<typeof sqsEnvelope>, dedupId = envelope.messageId) {
  await core.sqs.send(
    core.config.sqs.commandsQueue,
    JSON.stringify(envelope),
    envelope.data.walletId,
    createHash('sha256').update(dedupId + Math.random()).digest('hex'),
  );
}

type Row = Record<string, unknown>;

export async function sql<T = Row>(core: Core, query: string, params: unknown[] = []): Promise<T[]> {
  return core.orm.em.fork().execute(query, params) as Promise<T[]>;
}

/**
 * INVARIANTE FINAL de todos os testes: wallet.balance == saldo reconstruído
 * pelo ledger, versões contíguas e última versão == wallet.version.
 */
export async function assertWalletConsistent(core: Core, walletId: string): Promise<{ balance: string; entries: number }> {
  const report = await core.reconcile.execute(walletId);
  if (!report.consistent) throw new Error(`wallet ${walletId} inconsistent: ${JSON.stringify(report)}`);
  return { balance: report.storedBalance.amount, entries: report.checkedEntries };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}

// ------------------------------------------------------------------ processos reais

export interface AppProcess {
  proc: Subprocess;
  port: number;
  url: string;
  logs: string[];
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

let nextPort = 3400 + Math.floor(Math.random() * 400);

/** Sobe uma instância REAL (`bun src/main.ts`) — processo separado, pool próprio. */
export async function spawnApp(env: Record<string, string> = {}, waitReady = true): Promise<AppProcess> {
  await prepareInfra();
  const port = nextPort++;
  const logs: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), INSTANCE_ID: `proc-${port}`, LOG_LEVEL: 'info', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) logs.push(decoder.decode(chunk));
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);
  const app: AppProcess = {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    logs,
    async kill(signal: NodeJS.Signals = 'SIGTERM') {
      proc.kill(signal);
      return proc.exited;
    },
  };
  if (waitReady && env.APP_ROLE !== 'worker') {
    await waitFor(async () => (await fetch(`${app.url}/health/ready`)).ok, 20_000, 150);
  } else if (waitReady) {
    await waitFor(async () => logs.join('').includes('worker started'), 20_000, 100);
  }
  return app;
}

export async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // biome-ignore lint: corpo dinâmico nos testes
  const json: any = text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json, headers: res.headers };
}
