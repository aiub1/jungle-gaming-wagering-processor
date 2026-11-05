import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Core } from '../../composition';
import { AllowAllProviderIdentity, PROVIDER_IDENTITY, ProviderAuthGuard } from './auth.guard';
import { CORE, OpsController, WageringController, WalletsController } from './controllers';

@Module({})
export class HttpModule {
  static register(core: Core): DynamicModule {
    return {
      module: HttpModule,
      controllers: [WalletsController, WageringController, OpsController],
      providers: [
        { provide: CORE, useValue: core },
        { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
      ],
    };
  }
}
