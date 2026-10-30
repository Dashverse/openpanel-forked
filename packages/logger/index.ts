import * as HyperDX from '@hyperdx/node-opentelemetry';
import winston from 'winston';

export { winston };

export type ILogger = winston.Logger;

const logLevel = process.env.LOG_LEVEL ?? 'info';
const silent = process.env.LOG_SILENT === 'true';

// Pino's fatal/trace on top of syslog's levels, so pino-style callers (Fastify
// is given this logger) find every method they expect.
const levels: Record<string, number> = Object.assign(
  { fatal: 0, warn: 4, trace: 7 },
  winston.config.syslog.levels,
);
// syslog/npm colours don't cover fatal/trace, and colorize throws on a level
// without a colour; the throw escaped as an uncaught exception and restarted
// the API.
winston.addColors({ fatal: 'red', trace: 'gray' });

// triple-beam's LEVEL symbol, which colorize reads.
const LEVEL = Symbol.for('level');

/**
 * Give every entry a level this logger knows before colorize sees it: an entry
 * written without one (e.g. `logger.log({ message })` from a library) has no
 * LEVEL and would also make colorize throw.
 */
const normalizeLevel = winston.format((info) => {
  const record = info as Record<string | symbol, unknown>;
  const current = record[LEVEL] ?? info.level;
  const level =
    typeof current === 'string' && current in levels ? current : 'info';
  record[LEVEL] = level;
  info.level = level;
  return info;
});

export function createLogger({ name }: { name: string }): ILogger {
  const service = [process.env.LOG_PREFIX, name, process.env.NODE_ENV ?? 'dev']
    .filter(Boolean)
    .join('-');

  const prettyError = (error: Error) => ({
    ...error,
    stack: error.stack,
    message: error.message,
  });

  const errorFormatter = winston.format((info) => {
    if (info.error instanceof Error) {
      return {
        ...info,
        error: prettyError(info.error),
      };
    }
    if (info instanceof Error) {
      return {
        ...info,
        ...prettyError(info),
      };
    }
    return info;
  });

  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'authorization',
    'apiKey',
  ];

  const redactSensitiveInfo = winston.format((info) => {
    const redactObject = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj;

      return Object.keys(obj).reduce((acc, key) => {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some((k) => lowerKey.includes(k))) {
          acc[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          if (obj[key] instanceof Date) {
            acc[key] = obj[key].toISOString();
          } else {
            acc[key] = redactObject(obj[key]);
          }
        } else {
          acc[key] = obj[key];
        }
        return acc;
      }, {} as any);
    };

    return Object.assign({}, info, redactObject(info));
  });

  const transports: winston.transport[] = [];
  let format: winston.Logform.Format;

  if (process.env.HYPERDX_API_KEY) {
    transports.push(
      HyperDX.getWinstonTransport(logLevel, {
        detectResources: true,
        service,
      }),
    );
    format = winston.format.combine(
      errorFormatter(),
      redactSensitiveInfo(),
      winston.format.json(),
    );
  } else {
    transports.push(new winston.transports.Console());
    format = winston.format.combine(
      normalizeLevel(),
      errorFormatter(),
      redactSensitiveInfo(),
      winston.format.colorize({
        all: true,
      }),
      winston.format.printf((info) => {
        const { level, message, service, ...meta } = info;
        const metaStr =
          Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta, (_, v) => typeof v === 'bigint' ? v.toString() : v)}` : '';
        return `${level} ${message}${metaStr}`;
      }),
    );
  }

  const logger = winston.createLogger({
    defaultMeta: { service },
    level: logLevel,
    format,
    transports,
    silent,
    levels,
  });

  return logger;
}
