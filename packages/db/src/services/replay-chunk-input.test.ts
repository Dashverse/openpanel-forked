import { describe, expect, it } from 'vitest';
import { normalizeReplayChunkFields } from './replay-chunk-input';

const base = {
  chunk_index: 3,
  started_at: '2026-10-19T09:00:00.000Z',
  ended_at: '2026-10-19T09:00:10.000Z',
  events_count: 12,
  is_full_snapshot: false,
  payload: '[]',
};

describe('normalizeReplayChunkFields', () => {
  it('passes a well-formed SDK chunk through unchanged, payload last', () => {
    const r = normalizeReplayChunkFields(base);
    expect(r).toEqual({ ok: true, fields: base });
    if (r.ok) expect(Object.keys(r.fields).at(-1)).toBe('payload');
  });

  it('normalises numeric and offset timestamps to ISO UTC', () => {
    const r = normalizeReplayChunkFields({
      ...base,
      started_at: Date.parse('2026-10-19T09:00:00Z'),
      ended_at: '2026-10-19T14:30:10+05:30',
    });
    expect(r.ok && r.fields.started_at).toBe('2026-10-19T09:00:00.000Z');
    expect(r.ok && r.fields.ended_at).toBe('2026-10-19T09:00:10.000Z');
  });

  it('reads epoch seconds and numeric strings like the worker does', () => {
    const at = Date.parse('2026-10-19T09:00:00Z');
    for (const started_at of [at / 1000, String(at / 1000), String(at)]) {
      const r = normalizeReplayChunkFields({ ...base, started_at });
      expect(r.ok && r.fields.started_at).toBe('2026-10-19T09:00:00.000Z');
    }
  });

  it.each([
    ['missing started_at', { started_at: undefined }],
    ['garbage started_at', { started_at: 'yesterday-ish' }],
    ['object started_at', { started_at: {} }],
    ['negative chunk_index', { chunk_index: -1 }],
    ['fractional chunk_index', { chunk_index: 1.5 }],
    ['chunk_index past UInt16', { chunk_index: 70_000 }],
    ['non-string payload', { payload: [] }],
  ])('rejects %s', (_label, patch) => {
    expect(normalizeReplayChunkFields({ ...base, ...patch }).ok).toBe(false);
  });

  it('tolerates a bad ended_at / events_count instead of dropping the chunk', () => {
    const r = normalizeReplayChunkFields({
      ...base,
      ended_at: 'nope',
      events_count: 'x',
    });
    expect(r.ok && r.fields.ended_at).toBe(base.started_at);
    expect(r.ok && r.fields.events_count).toBe(0);
    const before = normalizeReplayChunkFields({
      ...base,
      ended_at: '2026-10-19T08:00:00.000Z',
      events_count: 1e6,
    });
    expect(before.ok && before.fields.ended_at).toBe(base.started_at);
    expect(before.ok && before.fields.events_count).toBe(65_535);
  });
});
