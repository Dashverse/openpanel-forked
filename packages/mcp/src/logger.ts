import { createLogger as createBaseLogger } from '@openpanel/logger';

/**
 * The upstream MCP code (ported here) logs pino-style — object first, message
 * second: `logger.info({ sessionId }, 'msg')`. This fork's `@openpanel/logger`
 * is message-first (winston-style): `logger.info('msg', meta)`. This shim
 * adapts the calling convention so the ported files stay byte-identical to
 * upstream and future syncs don't churn.
 */
type Meta = Record<string, unknown>;

function adapt(fn: (message: string, ...meta: unknown[]) => unknown) {
  return (a: string | Meta, b?: string | Meta) => {
    if (typeof a === 'string') {
      fn(a, b as Meta | undefined);
    } else {
      // pino-style: (metaObject, message)
      fn(typeof b === 'string' ? b : '', a);
    }
  };
}

export function createLogger(options: { name: string }) {
  const base = createBaseLogger(options);
  return {
    info: adapt(base.info.bind(base)),
    warn: adapt(base.warn.bind(base)),
    error: adapt(base.error.bind(base)),
    debug: adapt(base.debug.bind(base)),
  };
}
