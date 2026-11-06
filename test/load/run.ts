/**
 * Teste de carga: `bun run test:load` (precisa de `bun run infra:up`).
 *
 * Metodologia:
 *  - sobe 3 instâncias reais (`bun src/main.ts`, APP_ROLE=all) no banco de teste;
 *  - para cada cenário, N clientes concorrentes em loop fechado (closed-loop:
 *    cada cliente só envia a próxima requisição depois da resposta) por D segundos;
 *  - cenários: (A) wallets distribuídas — 200 wallets, BET/WIN aleatórios;
 *              (B) hot wallet — 1 wallet recebendo tudo;
 *              (C) replays — 30% das requisições repetem uma key já enviada;
 *  - mede vazão, p50/p95/p99, taxa de erro (5xx / falha de rede), conflitos
 *    de lock (métrica Prometheus), outbox lag máximo amostrado e, ao final,
 *    verifica a invariante saldo == ledger em todas as wallets tocadas.
 *
 * Variáveis: LOAD_DURATION_S (default 15), LOAD_CLIENTS (default 32).
 */
import '../support/preload'; // banco e filas de TESTE, nunca os do compose
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { type AppProcess, post, purgeQueues, spawnApp, sql, startCore, uuid } from '../support/harness';

const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 15);
const CLIENTS = Number(process.env.LOAD_CLIENTS ?? 32);

interface Wallet {
  id: string;
  playerId: string;
}

interface ScenarioResult {
  scenario: string;
  requests: number;
  throughputRps: number;
  p50ms: number;
  p95ms: number;
  p99ms: number;
  maxMs: number;
  errorRate: number;
  byStatus: Record<string, number>;
  lockConflicts: number;
  retries: number;
  maxOutboxLagS: number;
  consistentWallets: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

async function scrape(apps: AppProcess[], name: string): Promise<number> {
  let total = 0;
  for (const app of apps) {
    const text = await (await fetch(`${app.url}/metrics`)).text();
    for (const line of text.split('\n')) if (line.startsWith(name)) total += Number(line.split(' ').pop());
  }
  return total;
}

async function run() {
  const core = await startCore();
  await purgeQueues(core);
  // backlog de outras execuções não pode contaminar a medição de lag
  await sql(core, `UPDATE outbox_messages SET published_at = now(), locked_by = NULL WHERE published_at IS NULL`);
  const apps = await Promise.all([spawnApp({ LOG_LEVEL: 'warn' }), spawnApp({ LOG_LEVEL: 'warn' }), spawnApp({ LOG_LEVEL: 'warn' })]);
  const results: ScenarioResult[] = [];

  const newWallet = async (amount: string): Promise<Wallet> =>
    (await post((apps[0] as AppProcess).url, '/wallets', { playerId: uuid(), initialBalance: { amount, currency: 'BRL' } })).body;

  async function scenario(name: string, wallets: Wallet[], replayRatio: number) {
    const latencies: number[] = [];
    const byStatus: Record<string, number> = {};
    const sent: Array<{ body: unknown; key: string }> = [];
    const lockBefore = await scrape(apps, 'wagering_lock_conflicts_total');
    const retriesBefore = await scrape(apps, 'wagering_retries_total');
    let maxLag = 0;
    const deadline = Date.now() + DURATION_S * 1000;
    const sampler = setInterval(async () => {
      const lag = (await core.outboxStore.lag()).oldestAgeSeconds;
      maxLag = Math.max(maxLag, lag);
    }, 250);

    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, c) => {
        let i = 0;
        while (Date.now() < deadline) {
          const app = apps[(c + i++) % apps.length] as AppProcess;
          let req: { body: unknown; key: string };
          if (sent.length > 0 && Math.random() < replayRatio) {
            req = sent[Math.floor(Math.random() * sent.length)] as { body: unknown; key: string };
          } else {
            const w = wallets[Math.floor(Math.random() * wallets.length)] as Wallet;
            const ext = `load-${uuid()}`;
            req = {
              key: `load:${ext}`,
              body: {
                providerId: 'load',
                externalTransactionId: ext,
                playerId: w.playerId,
                walletId: w.id,
                roundId: `r-${c}`,
                gameId: 'load-game',
                kind: Math.random() < 0.6 ? 'BET' : 'WIN',
                money: { amount: '1.00', currency: 'BRL' },
              },
            };
            sent.push(req);
          }
          const started = performance.now();
          try {
            const res = await post(app.url, '/wagering/transactions', req.body, { 'Idempotency-Key': req.key });
            byStatus[res.status] = (byStatus[res.status] ?? 0) + 1;
          } catch {
            byStatus.network = (byStatus.network ?? 0) + 1;
          }
          latencies.push(performance.now() - started);
        }
      }),
    );
    clearInterval(sampler);

    // espera a outbox drenar para medir o lag até o fim
    const drainStart = Date.now();
    while ((await core.outboxStore.lag()).pending > 0 && Date.now() - drainStart < 30_000) {
      maxLag = Math.max(maxLag, (await core.outboxStore.lag()).oldestAgeSeconds);
      await Bun.sleep(200);
    }

    let consistent = 0;
    for (const w of wallets) if ((await core.reconcile.execute(w.id)).consistent) consistent++;

    latencies.sort((a, b) => a - b);
    const errors = Object.entries(byStatus)
      .filter(([s]) => s === 'network' || Number(s) >= 500)
      .reduce((n, [, v]) => n + v, 0);
    const result: ScenarioResult = {
      scenario: name,
      requests: latencies.length,
      throughputRps: Math.round(latencies.length / DURATION_S),
      p50ms: +percentile(latencies, 50).toFixed(1),
      p95ms: +percentile(latencies, 95).toFixed(1),
      p99ms: +percentile(latencies, 99).toFixed(1),
      maxMs: +(latencies.at(-1) ?? 0).toFixed(1),
      errorRate: +(errors / Math.max(1, latencies.length)).toFixed(4),
      byStatus,
      lockConflicts: (await scrape(apps, 'wagering_lock_conflicts_total')) - lockBefore,
      retries: (await scrape(apps, 'wagering_retries_total')) - retriesBefore,
      maxOutboxLagS: +maxLag.toFixed(2),
      consistentWallets: `${consistent}/${wallets.length}`,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }

  // Teto do emulador SQS: o lag da outbox não pode ser menor que backlog / teto.
  const ceilingStart = performance.now();
  let ceilingSent = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (ceilingSent < 1000) {
        ceilingSent += 10;
        await core.sqs.sendBatch(
          core.config.sqs.eventsQueue,
          Array.from({ length: 10 }, (_, i) => ({ id: uuid(), body: '{}', groupId: `ceiling-${i}`, dedupId: uuid() })),
        );
      }
    }),
  );
  const sqsCeilingMsgsPerS = Math.round(ceilingSent / ((performance.now() - ceilingStart) / 1000));
  await purgeQueues(core);
  console.log(JSON.stringify({ sqsCeilingMsgsPerS }));

  try {
    const distributed = await Promise.all(Array.from({ length: 200 }, () => newWallet('100000.00')));
    await scenario('A-distributed-200-wallets', distributed, 0);
    const hot = [await newWallet('1000000.00')];
    await scenario('B-hot-wallet', hot, 0);
    await scenario('C-distributed-30pct-replays', distributed, 0.3);
  } finally {
    await Promise.all(apps.map((a) => a.kill()));
    await core.close();
  }

  const env = {
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1e9),
    bun: Bun.version,
    instances: 3,
    clients: CLIENTS,
    durationS: DURATION_S,
    note: 'PostgreSQL 18 e MiniStack em Docker na mesma máquina dos 3 processos e do gerador de carga',
  };
  mkdirSync(new URL('./results', import.meta.url), { recursive: true });
  writeFileSync(new URL('./results/latest.json', import.meta.url), JSON.stringify({ env, sqsCeilingMsgsPerS, results }, null, 2));
  console.log(JSON.stringify({ env }, null, 2));
}

await run();
