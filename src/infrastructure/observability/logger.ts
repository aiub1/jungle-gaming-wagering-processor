import pino from 'pino';
import { currentContext } from './context';

export type Logger = pino.Logger;

/**
 * Logs estruturados em JSON (pino). `mixin` injeta o contexto corrente em cada
 * linha. `redact` é a rede de segurança para nunca vazar payload financeiro
 * completo ou credenciais — por padrão nenhum log inclui body/money.
 */
export function createLogger(level: string, instanceId: string): Logger {
  return pino({
    level,
    base: { service: 'wagering-processor', instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentContext() }),
    redact: {
      paths: ['body', 'payload', 'money', 'data.money', '*.authorization', 'headers.authorization', 'balance', '*.balance'],
      censor: '[redacted]',
    },
  });
}
