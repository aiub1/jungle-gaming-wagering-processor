import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * PONTO DE EXTENSÃO DE AUTENTICAÇÃO (decisão documentada no ARCHITECTURE.md).
 *
 * A autenticação não vale pontos no desafio; não implementamos IdP para não
 * competir com correção financeira. O desenho adotado seria:
 *   Keycloak (OIDC) com client_credentials por provedor → JWT com claim
 *   `provider_id` → este guard valida assinatura/audiência via JWKS (jose) e
 *   verifica que `body.providerId` (ou `:providerId`) == claim. Endpoints de
 *   health/metrics ficam públicos (@Public).
 *
 * Hoje a porta tem uma implementação "allow-all" explícita: trocar a
 * implementação NÃO exige mexer em controllers nem em casos de uso.
 */
export interface ProviderIdentity {
  providerId: string | '*';
}

export interface ProviderIdentityPort {
  /** Resolve a identidade do chamador a partir dos headers; undefined → 401. */
  identify(headers: Record<string, string | string[] | undefined>): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Implementação no-op: todo chamador é confiável (ambiente de desafio). */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity> {
    return { providerId: '*' };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; principal?: ProviderIdentity }>();
    const principal = await this.identity.identify(req.headers);
    if (!principal) return false;
    req.principal = principal;
    return true;
  }
}
