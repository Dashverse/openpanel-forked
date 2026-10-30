import { describe, expect, it } from 'vitest';
import { createLogger, type winston } from './index';

// colorize throws on an entry whose level has no colour; in the API that throw
// became an uncaughtException and restarted the pod.
describe('createLogger', () => {
  const logger = createLogger({ name: 'logger-test' });

  it('logs at fatal, which syslog/npm colours do not cover', () => {
    // winston adds a method per level; Fastify (given this logger) calls it.
    const pinoStyle = logger as unknown as { fatal: (message: string) => void };
    expect(() => pinoStyle.fatal('fatal entry')).not.toThrow();
  });

  it('logs an entry written without a level', () => {
    expect(() =>
      logger.log({ message: 'no level' } as unknown as winston.LogEntry),
    ).not.toThrow();
  });

  it('still logs the ordinary levels', () => {
    expect(() => {
      logger.error('error entry', { error: new Error('boom') });
      logger.warn('warn entry');
      logger.info('info entry');
    }).not.toThrow();
  });
});
