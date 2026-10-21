import { describe, expect, it } from 'vitest';
import { resolveActiveWindowId, resolveDefaultWindowId } from './replay-utils';

const w = (windowId: string, activeDurationMs: number) => ({
  windowId,
  activeDurationMs,
});

describe('resolveDefaultWindowId', () => {
  it('is null with no windows', () => {
    expect(resolveDefaultWindowId([], null)).toBeNull();
    expect(resolveDefaultWindowId([], 'a')).toBeNull();
  });

  it('picks the most active window on first resolve', () => {
    expect(resolveDefaultWindowId([w('a', 2_000), w('b', 60_000)], null)).toBe(
      'b',
    );
  });

  it('keeps the pinned window when another overtakes it on a later poll', () => {
    const first = resolveDefaultWindowId([w('a', 10_000), w('b', 5_000)], null);
    expect(first).toBe('a');
    const polled = [w('a', 11_000), w('b', 90_000)];
    expect(resolveDefaultWindowId(polled, first)).toBe('a');
  });

  it('re-picks when the pinned window is no longer listed', () => {
    expect(resolveDefaultWindowId([w('b', 1_000), w('c', 3_000)], 'a')).toBe(
      'c',
    );
  });

  it('pins the legacy (empty id) window like any other', () => {
    expect(resolveDefaultWindowId([w('', 1_000), w('b', 9_000)], '')).toBe('');
  });
});

describe('resolveActiveWindowId', () => {
  const windows = [w('a', 1_000), w('b', 2_000)];

  it('uses the explicit selection when it is listed', () => {
    expect(
      resolveActiveWindowId({
        selectedId: 'a',
        defaultId: 'b',
        windows,
        listLoaded: true,
      }),
    ).toBe('a');
  });

  it('falls back to the default for a stale selection', () => {
    expect(
      resolveActiveWindowId({
        selectedId: 'gone',
        defaultId: 'b',
        windows,
        listLoaded: true,
      }),
    ).toBe('b');
  });

  it('trusts the selection before the list has loaded', () => {
    expect(
      resolveActiveWindowId({
        selectedId: 'a',
        defaultId: null,
        windows: [],
        listLoaded: false,
      }),
    ).toBe('a');
  });

  it('uses the default with no selection', () => {
    expect(
      resolveActiveWindowId({
        selectedId: null,
        defaultId: 'b',
        windows,
        listLoaded: true,
      }),
    ).toBe('b');
  });
});
