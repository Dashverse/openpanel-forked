import { describe, expect, it, vi } from 'vitest';
import { requestLoggingHook } from './request-logging.hook';

describe('requestLoggingHook', () => {
  it('redacts OAuth callback query parameters', async () => {
    const info = vi.fn();

    await requestLoggingHook(
      {
        method: 'GET',
        url: '/oauth/google/callback?code=authorization-secret&state=state-secret',
        log: { info },
        headers: {},
        body: undefined,
      } as never,
      { elapsedTime: 12 } as never,
    );

    expect(info).toHaveBeenCalledWith(
      'request done',
      expect.objectContaining({ url: '/oauth/google/callback' }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      'authorization-secret',
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('state-secret');
  });
});
