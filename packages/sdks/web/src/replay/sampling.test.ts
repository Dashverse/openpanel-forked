import { describe, expect, it } from 'vitest';
import { decideReplaySample } from './sampling';

describe('decideReplaySample', () => {
  it('reuses the stored decision for the same session', () => {
    expect(
      decideReplaySample({
        sampleRate: 0.1,
        sessionId: 'sess-a',
        stored: 'sess-a:1',
        random: 0.99,
      }),
    ).toEqual({ recorded: true, store: null });

    expect(
      decideReplaySample({
        sampleRate: 0.1,
        sessionId: 'sess-a',
        stored: 'sess-a:0',
        random: 0.01,
      }),
    ).toEqual({ recorded: false, store: null });
  });

  it('rolls again when the stored decision belongs to another session', () => {
    expect(
      decideReplaySample({
        sampleRate: 0.5,
        sessionId: 'sess-b',
        stored: 'sess-a:0',
        random: 0.2,
      }),
    ).toEqual({ recorded: true, store: 'sess-b:1' });

    expect(
      decideReplaySample({
        sampleRate: 0.5,
        sessionId: 'sess-b',
        stored: 'sess-a:1',
        random: 0.8,
      }),
    ).toEqual({ recorded: false, store: 'sess-b:0' });
  });

  it('rolls when there is nothing stored', () => {
    expect(
      decideReplaySample({
        sampleRate: 0.5,
        sessionId: 'sess-a',
        stored: null,
        random: 0.2,
      }),
    ).toEqual({ recorded: true, store: 'sess-a:1' });
  });

  it('records every session at rate 1 and never stores a miss', () => {
    for (const stored of [null, 'sess-a:0', 'sess-a:1', 'garbage']) {
      expect(
        decideReplaySample({
          sampleRate: 1,
          sessionId: 'sess-a',
          stored,
          random: 0.999,
        }).recorded,
      ).toBe(true);
    }

    expect(
      decideReplaySample({
        sampleRate: 1,
        sessionId: 'sess-a',
        stored: 'sess-a:0',
        random: 0.999,
      }).store,
    ).toBe('sess-a:1');
  });

  it('records no session at rate 0', () => {
    for (const stored of [null, 'sess-a:1']) {
      expect(
        decideReplaySample({
          sampleRate: 0,
          sessionId: 'sess-a',
          stored,
          random: 0,
        }),
      ).toEqual({ recorded: false, store: 'sess-a:0' });
    }
  });

  it('rolls again when the stored value is corrupt', () => {
    for (const stored of ['', 'sess-a', 'sess-a:', 'sess-a:yes', ':1']) {
      expect(
        decideReplaySample({
          sampleRate: 0.5,
          sessionId: 'sess-a',
          stored,
          random: 0.2,
        }),
      ).toEqual({ recorded: true, store: 'sess-a:1' });
    }
  });

  it('keeps a session id that contains a colon intact', () => {
    expect(
      decideReplaySample({
        sampleRate: 0.5,
        sessionId: 'sess:a',
        stored: 'sess:a:0',
        random: 0.1,
      }),
    ).toEqual({ recorded: false, store: null });
  });
});
