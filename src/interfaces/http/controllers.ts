import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseOpenWallet, parseSubmitWager, parseUuid } from '../../application/commands';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Core } from '../../composition';
import { currentContext, enrichContext } from '../../infrastructure/observability/context';
import { Public } from './auth.guard';

export const CORE = Symbol('Core');

function correlation() {
  const ctx = currentContext();
  return { correlationId: ctx.correlationId ?? Bun.randomUUIDv7(), causationId: ctx.correlationId };
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const wallet = await this.core.openWallet.execute(parseOpenWallet(body), correlation());
    enrichContext({ walletId: wallet.id });
    this.core.logger.info('wallet opened');
    return wallet;
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.core.queries.wallet(parseUuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? 50 : /^\d{1,3}$/.test(limit) ? Number(limit) : Number.NaN;
    return this.core.queries.ledger(parseUuid(walletId, 'walletId'), cursor, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.core.reconcile.execute(parseUuid(walletId, 'walletId'));
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cmd = parseSubmitWager(body, idempotencyKey);
    enrichContext({ walletId: cmd.walletId, providerId: cmd.providerId });
    const { duplicateMessage: _ignored, ...result } = await this.core.submitWager.execute(cmd, { channel: 'http', ...correlation() });
    enrichContext({ transactionId: result.transactionId });
    this.core.logger.info({ status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay }, 'wager submitted');

    if (result.idempotentReplay) res.setHeader('Idempotent-Replayed', 'true');
    switch (result.status) {
      case WagerTransactionStatus.Processed:
        res.status(result.idempotentReplay ? 200 : 201);
        break;
      case WagerTransactionStatus.PendingReference:
        res.status(202);
        break;
      default: // REJECTED (ou FAILED num replay)
        res.status(422);
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') id: string) {
    return this.core.queries.transaction(parseUuid(id, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return this.core.queries.transactionByExternalId(providerId, externalId);
  }
}

@Controller()
@Public()
export class OpsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('health/live')
  live() {
    return { status: 'ok', instanceId: this.core.config.instanceId };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.core.readiness();
    res.status(result.ready ? 200 : 503);
    return { status: result.ready ? 'ready' : 'not_ready', checks: result.checks };
  }

  @Get('metrics')
  async metrics(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', this.core.metrics.registry.contentType);
    return this.core.metrics.registry.metrics();
  }
}
