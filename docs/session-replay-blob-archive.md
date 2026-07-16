# Session Replay — Blob Archive

**TL;DR:** ClickHouse keeps replays hot for a rolling window (**30 days today → moving to 45**). A K8s CronJob copies every chunk to **Azure Blob** as Parquet so we keep **all** replays **forever** and never lose data. ClickHouse serves recent replays today; **serving archived replays from Blob is a planned follow-up** (see [Retrieval](#retrieval-planned)) — this PR ships the *archival* half only, and deletes nothing.

> **Status:** archival is implemented (`pnpm --filter @openpanel/db archive:replay` + a K8s CronJob). Retrieval-from-Blob in the dashboard is **not yet built** — no ClickHouse day may be deleted until it ships.

---

## Why
- Replay volume is ~**2 TB/month** at full volume (~70 GiB/day, ~3–4k sessions/day) — too much to keep hot in ClickHouse.
- We don't **delete**, we **relocate**: ClickHouse = hot cache, Blob = store-of-record (forever).

## How we store it
A **K8s CronJob** runs `archive:replay`, which issues `INSERT INTO FUNCTION azureBlobStorage(...)` — **ClickHouse writes the Parquet directly to Blob**; no replay bytes flow through Node. Layout, partitioned by **day + project**:

```text
clickhouse-export/
  dt=2026-07-14/                 ← day (UTC, from started_at)
    project_id=frameo/           ← project
      bucket=0.parquet           ← session-hash slice (see below)
      bucket=1.parquet
      ...
```

Each Parquet **row = one chunk** — the `session_replay_chunks` columns as-is:
`project_id · session_id · window_id · chunk_index · started_at · ended_at · payload`

- **Partition (folders) = day + project.**
- **Sorted by `project_id, session_id, started_at, chunk_index`** → one session's rows sit together (fast retrieval via row-group pruning).
- **Session-hash bucketing:** a whole 78 GiB day OOMs if sorted at once (~44 GiB CH memory limit), so big days are split into `ceil(sizeGiB / 5)` slices via `cityHash64(session_id) % N`. This keeps every session's chunks in **one** file (never split) while bounding memory. Small days → 1 bucket.
- **Timezone = UTC everywhere** (partition + query). Playback is timezone-free (absolute timestamps).
- `profile_id` is **not** a Parquet column — the chunks table has none. It's enriched into the *index* (below) via a join to `events`.

## The index — `replay_archive_index` (ClickHouse)
A locator table in ClickHouse (created by code-migration `23-add-replay-archive-index`), written per session after each day is verified. It's also the **watermark** (no separate progress table):

```sql
replay_archive_index (
  project_id, session_id, profile_id, dt,
  blob_path,            -- dt=<date>/project_id=<p>/bucket=<hash>.parquet
  chunks, first_started_at, last_started_at, archived_at
) ENGINE = ReplacingMergeTree(archived_at)
ORDER BY (project_id, session_id, dt)   -- dt in key: midnight-crossing sessions keep both file pointers
-- NO TTL: must outlive the session_replay_chunks hot window.
```

- **`blob_path` is deterministic** (day + project + `cityHash64(session_id) % buckets`), so retrieval reads exactly one file per session.
- **Watermark = set-difference:** a day is "done" only when `sum(chunks)` in the index for that `dt` equals the source row count — so a partial index (populate failed mid-run) is retried, not skipped. Oldest-first, gapless, self-healing.

## Retrieval (planned)
*Not implemented in this PR.* The intended dashboard read path for an archived session:
1. Recent (in the hot window): served from ClickHouse as today — unchanged.
2. Archived: look up `replay_archive_index` → `blob_path` → read that Parquet via `azureBlobStorage(...) WHERE session_id = X ORDER BY chunk_index` → same chunk shape → cache in Redis. (Optionally a SAS URL so the browser fetches from Blob directly.)

**Validated manually on prod:** index → blob_path → raw rrweb payloads read back with matching counts. The dashboard code branch is the remaining work.

## Retention & safety
- **ClickHouse:** rolling hot window — 30 days today, moving to 45 (one-line TTL change, *not yet applied*).
- **Blob:** forever — **Cool → Cold** tier (both instant; avoid Archive tier — hours to rehydrate).
- The CronJob **only copies**; nothing is deleted from ClickHouse. **No day may be TTL'd/dropped until the retrieval path ships**, or archived replays would 404.

## Open items before deletion is enabled
1. **Aiven** must allow `azureBlobStorage()` **reads** for the dashboard fallback (writes are already confirmed).
2. Ship the **dashboard serving fallback** (`session.service.ts` + tRPC read path).
3. Only then bump the TTL / let ClickHouse drop old days.
