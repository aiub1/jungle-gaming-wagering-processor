import type { Logger } from '../observability/logger';

/**
 * Loop de polling com parada graciosa: `stop()` interrompe novas iterações,
 * acorda o sleep e espera a iteração corrente terminar.
 */
export abstract class PollingWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  protected constructor(
    protected readonly name: string,
    protected readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  /** Uma iteração. Retorna true se trabalhou (então roda de novo sem dormir). */
  protected abstract tick(): Promise<boolean>;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    this.logger.info({ worker: this.name }, 'worker started');
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (error) {
        this.logger.error({ worker: this.name, err: error }, 'worker iteration failed');
      }
      if (!busy && this.running) await this.sleep(this.intervalMs);
    }
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
