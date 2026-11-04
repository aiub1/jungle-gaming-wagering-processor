import { createHash } from 'node:crypto';

/**
 * JSON canônico (RFC 8785-like, restrito ao que precisamos):
 *  - chaves de objeto ordenadas recursivamente por code point;
 *  - sem espaços;
 *  - propriedades `undefined` omitidas (ausente ≡ undefined);
 *  - `number` é proibido: todo campo de negócio é string, inclusive dinheiro,
 *    então a serialização nunca depende de formatação de ponto flutuante.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export const PAYLOAD_HASH_VERSION = 'v1';

/** `v1:` + sha256 hex do JSON canônico. O prefixo permite trocar o algoritmo sem ambiguidade. */
export function payloadHash(value: unknown): string {
  return `${PAYLOAD_HASH_VERSION}:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
