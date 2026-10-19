/**
 * Compression benchmark for session-replay chunk lines: the production LZ4
 * (lz4js, same call as compressReplayLine) vs zstd (node:zlib, levels 1/3/6)
 * and gzip 6, on REAL chunk lines read from the replay Blob blocks.
 *
 * READ-ONLY: lists + downloads blobs under `blocks/` (in memory only, nothing is
 * written to disk) and never touches Kafka, ClickHouse, Redis or Postgres. The
 * connection string is read from the repo .env inside this process and never
 * printed.
 *
 *   npx tsx scripts/bench-replay-compression.ts [--days 4] [--max-mb 300]
 *     [--projects frameo,dashreels-1126] [--largest 15]
 *
 * Caveat: chunks over 950000 bytes after LZ4 were dropped at the API before the
 * blocks were written, so the sample has (almost) no such chunks; the
 * zstd-vs-LZ4 ratio on the largest chunks is what predicts how many of them a
 * codec switch would rescue.
 */
/// <reference path="../src/lz4js.d.ts" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constants,
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';
import * as lz4 from 'lz4js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(path.join(root, 'packages/db/package.json'));
// @azure/storage-blob is a dependency of @openpanel/db, not of this package,
// so load it from there and type only the calls used here.
interface BlobContainer {
  listBlobsFlat(o: { prefix: string }): AsyncIterable<{
    name: string;
    properties: { contentLength?: number };
  }>;
  getBlobClient(name: string): { downloadToBuffer(): Promise<Buffer> };
}
const { BlobServiceClient } = require('@azure/storage-blob') as {
  BlobServiceClient: {
    fromConnectionString(c: string): {
      getContainerClient(n: string): BlobContainer;
    };
  };
};

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const DAYS = Number(arg('days', '4'));
const MAX_BYTES = Number(arg('max-mb', '300')) * 1024 * 1024;
const PROJECTS = arg('projects', 'frameo,dashreels-1126').split(',');
// Largest blobs per project taken first (fat sessions), then a random spread.
const LARGEST = Number(arg('largest', '15'));
const LIMIT = 950_000;

// Only the keys we need, without echoing anything.
const envValue = (key: string): string | undefined => {
  if (process.env[key]) return process.env[key];
  const text = readFileSync(path.join(root, '.env'), 'utf8');
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1]!.trim().replace(/^"(.*)"$/, '$1') : undefined;
};

// An append blob is a concatenation of independent zstd frames, and Node's
// decoder stops after the first, so walk the frame headers to split them.
function zstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      p += 8 + buf.readUInt32LE(p + 4); // skippable frame
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error(`bad zstd magic at ${p}`);
    const start = p;
    p += 4;
    const fhd = buf[p++]!;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag]!;
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag]!;
    for (;;) {
      const h = buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      p += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) p += 4;
    frames.push(buf.subarray(start, p));
  }
  return frames;
}

interface Codec {
  name: string;
  enc: (b: Uint8Array) => Uint8Array;
  dec: (b: Uint8Array) => Uint8Array;
}
const zstd = (level: number): Codec => ({
  name: `zstd-${level}`,
  enc: (b) =>
    zstdCompressSync(b, {
      params: { [constants.ZSTD_c_compressionLevel]: level },
    }),
  dec: (b) => zstdDecompressSync(b),
});
const CODECS: Codec[] = [
  {
    name: 'lz4 (prod)',
    enc: (b) => lz4.compress(b),
    dec: (b) => lz4.decompress(b),
  },
  zstd(1),
  zstd(3),
  zstd(6),
  {
    name: 'gzip-6',
    enc: (b) => gzipSync(b, { level: 6 }),
    dec: (b) => gunzipSync(b),
  },
];

interface Stat {
  sizes: number[];
  encMs: number;
  decMs: number;
}
const stats = new Map<string, Stat>(
  CODECS.map((c) => [c.name, { sizes: [], encMs: 0, decMs: 0 }]),
);
const rawSizes: number[] = [];
const fullFlags: boolean[] = [];
const enc = new TextEncoder();

function measure(line: string) {
  const raw = enc.encode(line);
  rawSizes.push(raw.length);
  fullFlags.push(/"is_full_snapshot":(true|1)\b/.test(line));
  for (const c of CODECS) {
    const s = stats.get(c.name)!;
    let t = performance.now();
    const out = c.enc(raw);
    s.encMs += performance.now() - t;
    t = performance.now();
    const back = c.dec(out);
    s.decMs += performance.now() - t;
    if (back.length !== raw.length)
      throw new Error(`${c.name} round trip failed`);
    s.sizes.push(out.length);
  }
}

const pct = (sorted: number[], q: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
    : 0;
const kb = (n: number) => `${(n / 1024).toFixed(0)}K`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}M`;

async function main() {
  const conn = envValue('AZURE_BLOB_CONNECTION_STRING');
  if (!conn) throw new Error('AZURE_BLOB_CONNECTION_STRING not set');
  const containerName =
    envValue('REPLAY_ARCHIVE_CONTAINER') || 'clickhouse-export';
  const prefix = envValue('REPLAY_BLOCKS_PREFIX') || 'blocks';
  const container =
    BlobServiceClient.fromConnectionString(conn).getContainerClient(
      containerName,
    );

  // 1. List recent blobs per project.
  const blobs: { name: string; size: number; project: string }[] = [];
  for (let d = 0; d < DAYS; d++) {
    const dt = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    for (const project of PROJECTS) {
      const pfx = `${prefix}/dt=${dt}/project=${encodeURIComponent(project)}/`;
      for await (const b of container.listBlobsFlat({ prefix: pfx })) {
        blobs.push({
          name: b.name,
          size: b.properties.contentLength ?? 0,
          project,
        });
      }
    }
  }
  const listedBytes = blobs.reduce((a, b) => a + b.size, 0);
  console.log(
    `listed ${blobs.length} blobs (${mb(listedBytes)}) over ${DAYS} days for ${PROJECTS.join(',')}`,
  );

  // 2. Sample: the largest blobs (fat snapshots) + a seeded random spread,
  // per project, under the byte cap.
  const pick: typeof blobs = [];
  let budget = MAX_BYTES;
  const take = (b: (typeof blobs)[number]) => {
    if (b.size <= budget && !pick.includes(b)) {
      pick.push(b);
      budget -= b.size;
    }
  };
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (const project of PROJECTS) {
    const mine = blobs
      .filter((b) => b.project === project)
      .sort((a, b) => b.size - a.size);
    for (const b of mine.slice(0, LARGEST)) take(b);
  }
  const shuffled = [...blobs].sort(() => rnd() - 0.5);
  for (const b of shuffled) {
    if (budget < 64 * 1024) break;
    take(b);
  }
  const pickedBytes = pick.reduce((a, b) => a + b.size, 0);
  console.log(`sampling ${pick.length} blobs (${mb(pickedBytes)} compressed)`);

  // 3. Download (memory only), split frames, measure every chunk line.
  let done = 0;
  const queue = [...pick];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const buf = await container.getBlobClient(b.name).downloadToBuffer();
      for (const frame of zstdFrames(buf)) {
        const text = zstdDecompressSync(frame).toString('utf8');
        for (const line of text.split('\n')) if (line) measure(line);
      }
      done++;
      if (done % 50 === 0)
        console.log(
          `  ${done}/${pick.length} blobs, ${rawSizes.length} chunks`,
        );
    }
  };
  // Downloads overlap; the measuring is synchronous anyway.
  await Promise.all([worker(), worker(), worker(), worker()]);

  // 4. Report.
  const n = rawSizes.length;
  const rawTotal = rawSizes.reduce((a, b) => a + b, 0);
  const rawSorted = [...rawSizes].sort((a, b) => a - b);
  console.log(
    `\n${n} chunks (${fullFlags.filter(Boolean).length} full snapshots), raw ${mb(rawTotal)}; raw per chunk p50 ${kb(pct(rawSorted, 0.5))} p90 ${kb(pct(rawSorted, 0.9))} p99 ${kb(pct(rawSorted, 0.99))} max ${kb(rawSorted[n - 1] ?? 0)}\n`,
  );
  const lz4Sizes = stats.get('lz4 (prod)')!.sizes;
  const head = [
    'codec',
    'total',
    'ratio',
    'p50',
    'p90',
    'p99',
    'max',
    '>950000',
    'enc MB/s',
    'dec MB/s',
    'vs lz4 (big)',
  ];
  const rows: string[][] = [head];
  // "big" = chunks whose LZ4 value is >= 256 KB: the population near the limit.
  const bigIdx = lz4Sizes
    .map((s, i) => (s >= 256 * 1024 ? i : -1))
    .filter((i) => i >= 0);
  for (const c of CODECS) {
    const s = stats.get(c.name)!;
    const total = s.sizes.reduce((a, b) => a + b, 0);
    const sorted = [...s.sizes].sort((a, b) => a - b);
    const bigRatio = bigIdx.length
      ? bigIdx.reduce((a, i) => a + s.sizes[i]!, 0) /
        bigIdx.reduce((a, i) => a + lz4Sizes[i]!, 0)
      : Number.NaN;
    rows.push([
      c.name,
      mb(total),
      `${(rawTotal / total).toFixed(2)}x`,
      kb(pct(sorted, 0.5)),
      kb(pct(sorted, 0.9)),
      kb(pct(sorted, 0.99)),
      kb(sorted[n - 1] ?? 0),
      String(s.sizes.filter((x) => x > LIMIT).length),
      (rawTotal / 1024 / 1024 / (s.encMs / 1000)).toFixed(0),
      (rawTotal / 1024 / 1024 / (s.decMs / 1000)).toFixed(0),
      bigRatio.toFixed(2),
    ]);
  }
  const widths = head.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows)
    console.log(r.map((v, i) => v.padStart(widths[i]!)).join('  '));
  console.log(
    `\n"vs lz4 (big)": codec bytes / lz4 bytes over the ${bigIdx.length} chunks with an LZ4 value >= 256 KB.`,
  );

  // Full snapshots only (the oversize population).
  const fullIdx = fullFlags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  if (fullIdx.length) {
    console.log(`\nfull snapshots only (${fullIdx.length}):`);
    for (const c of CODECS) {
      const s = stats.get(c.name)!;
      const sizes = fullIdx.map((i) => s.sizes[i]!).sort((a, b) => a - b);
      const raw = fullIdx.reduce((a, i) => a + rawSizes[i]!, 0);
      const tot = sizes.reduce((a, b) => a + b, 0);
      console.log(
        `  ${c.name.padEnd(11)} ratio ${(raw / tot).toFixed(2)}x  p50 ${kb(pct(sizes, 0.5))}  p90 ${kb(pct(sizes, 0.9))}  p99 ${kb(pct(sizes, 0.99))}  max ${kb(sizes[sizes.length - 1]!)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
