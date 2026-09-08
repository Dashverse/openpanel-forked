import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEDUP_TTL_SECONDS,
  isDedupableInsertId,
  parseDedupTtlSeconds,
  resolveDedupId,
} from './kafka-dedup';

const V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const V1 = 'd9428888-122b-11e1-b85c-61cb3c1cf9d3';
const NIL = '00000000-0000-0000-0000-000000000000';
const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

describe('isDedupableInsertId', () => {
  it('accepts a real versioned UUID (v1–v8)', () => {
    expect(isDedupableInsertId(V4)).toBe(true);
    expect(isDedupableInsertId(V1)).toBe(true);
    expect(isDedupableInsertId(V4.toUpperCase())).toBe(true);
  });

  it('rejects the nil UUID (version 0)', () => {
    // A client that fails to generate an id often defaults to all-zeros; if we
    // trusted it, every such event would collapse into one dedup key.
    expect(isDedupableInsertId(NIL)).toBe(false);
  });

  it('rejects the max UUID (version f)', () => {
    expect(isDedupableInsertId(MAX)).toBe(false);
  });

  it('rejects weak / non-UUID / non-string values', () => {
    expect(isDedupableInsertId('1')).toBe(false);
    expect(isDedupableInsertId('not-a-uuid')).toBe(false);
    expect(isDedupableInsertId('')).toBe(false);
    expect(isDedupableInsertId(undefined)).toBe(false);
    expect(isDedupableInsertId(null)).toBe(false);
    expect(isDedupableInsertId(12345)).toBe(false);
  });
});

describe('resolveDedupId', () => {
  it('uses the $insert_id when it is a real UUID', () => {
    expect(resolveDedupId(V4, 'job-abc')).toBe(V4);
  });

  it('falls back to the jobId for nil / max / weak insert ids', () => {
    expect(resolveDedupId(NIL, 'job-abc')).toBe('job-abc');
    expect(resolveDedupId(MAX, 'job-abc')).toBe('job-abc');
    expect(resolveDedupId('1', 'job-abc')).toBe('job-abc');
    expect(resolveDedupId(undefined, 'job-abc')).toBe('job-abc');
  });

  it('returns undefined when neither is usable (caller skips dedup, never drops)', () => {
    expect(resolveDedupId(undefined, undefined)).toBeUndefined();
    expect(resolveDedupId(NIL, undefined)).toBeUndefined();
  });
});

describe('parseDedupTtlSeconds', () => {
  it('honors a valid positive integer string', () => {
    expect(parseDedupTtlSeconds('3600')).toBe(3600);
  });

  it('falls back for a fat-fingered unit-suffixed value ("6h" must NOT become 6)', () => {
    // parseInt("6h") === 6 would give a 6-SECOND window; Number("6h") is NaN.
    expect(parseDedupTtlSeconds('6h')).toBe(DEFAULT_DEDUP_TTL_SECONDS);
  });

  it('falls back for empty / undefined / zero / garbage', () => {
    expect(parseDedupTtlSeconds('')).toBe(DEFAULT_DEDUP_TTL_SECONDS);
    expect(parseDedupTtlSeconds(undefined)).toBe(DEFAULT_DEDUP_TTL_SECONDS);
    expect(parseDedupTtlSeconds('0')).toBe(DEFAULT_DEDUP_TTL_SECONDS);
    expect(parseDedupTtlSeconds('abc')).toBe(DEFAULT_DEDUP_TTL_SECONDS);
  });

  it('respects a caller-supplied fallback', () => {
    expect(parseDedupTtlSeconds('nope', 100)).toBe(100);
  });
});
