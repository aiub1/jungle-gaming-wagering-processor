import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de log propagado por AsyncLocalStorage: todo log emitido dentro de
 * uma requisição/mensagem carrega correlationId, messageId, transactionId,
 * walletId e providerId sem precisar passar o logger de mão em mão.
 */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Enriquecer o contexto corrente (ex.: depois que o transactionId é conhecido). */
export function enrichContext(ctx: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, ctx);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}
