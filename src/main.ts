import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { buildCore } from './composition';
import { loadConfig } from './infrastructure/config';
import { runWithContext } from './infrastructure/observability/context';
import { HttpModule } from './interfaces/http/app.module';
import { HttpErrorFilter } from './interfaces/http/error.filter';

/**
 * Um único binário, papel escolhido por APP_ROLE:
 *   api    → só HTTP
 *   worker → consumidor SQS + publisher da outbox + worker de referências
 *   all    → ambos (default; é o que o docker-compose sobe 3x)
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const core = await buildCore(config);
  const { logger } = core;
  let app: NestExpressApplication | undefined;

  if (config.role === 'api' || config.role === 'all') {
    app = await NestFactory.create<NestExpressApplication>(HttpModule.register(core), { logger: false, bodyParser: true });
    app.use((req: Request, res: Response, next: NextFunction) => {
      const header = req.header('x-correlation-id');
      const correlationId = header && header.length <= 128 ? header : Bun.randomUUIDv7();
      res.setHeader('X-Correlation-Id', correlationId);
      runWithContext({ correlationId }, next);
    });
    app.useGlobalFilters(new HttpErrorFilter(logger));
    await app.listen(config.port, '0.0.0.0');
    logger.info({ port: config.port, role: config.role }, 'http server listening');
  }
  if (config.role === 'worker' || config.role === 'all') core.startWorkers();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown started');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();
    try {
      // 1) para de aceitar HTTP; 2) workers terminam o que está em andamento,
      // devolvem visibilidade das mensagens não iniciadas e leases da outbox;
      // 3) fecha pool.
      await app?.close();
      await core.close();
      logger.info('graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'failed to start', err: String(error?.stack ?? error) }));
  process.exit(1);
});
