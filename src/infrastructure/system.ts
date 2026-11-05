import type { Clock, FaultInjector, FaultPoint, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7 nativo do Bun: ordenado no tempo (índices B-tree sem fragmentação). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/**
 * Injeção de falhas para os testes de crash/recuperação. Ativada por env
 * `FAULTS=sqs.after-commit-before-ack:kill,...` em processos de teste, ou
 * programaticamente em testes in-process. Em produção a lista é vazia (no-op).
 *
 *  - `:kill`  → SIGKILL no próprio processo (morte abrupta, sem cleanup)
 *  - `:throw` → lança erro (rollback da transação corrente)
 */
export class ConfigurableFaultInjector implements FaultInjector {
  private readonly faults = new Map<string, 'kill' | 'throw'>();

  constructor(specs: string[] = []) {
    for (const spec of specs) {
      const [point, action = 'kill'] = spec.split(':');
      if (point) this.faults.set(point, action === 'throw' ? 'throw' : 'kill');
    }
  }

  arm(point: FaultPoint, action: 'kill' | 'throw'): void {
    this.faults.set(point, action);
  }

  disarm(point: FaultPoint): void {
    this.faults.delete(point);
  }

  async hit(point: FaultPoint): Promise<void> {
    const action = this.faults.get(point);
    if (!action) return;
    if (action === 'throw') throw new Error(`fault injected at ${point}`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {}); // nunca retorna
  }
}
