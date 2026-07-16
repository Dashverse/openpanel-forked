# Session Replay — Storage, Retention & the Recording-Volume Problem

Status: design + observations (2026-07). Owner: analytics/replay.

This doc covers two linked things:
1. **Observations & testing** on why replay data volume is far higher than it should be (ghost recordings).
2. **The storage/retention design** — keep 30 days hot in ClickHouse, archive older data to **Azure Blob Storage**, then let it drop.

---

## 1. Observations & testing — recording volume

### The symptom
`session_replay_chunks` is enormous and grows fast:

| Day | Size | Rows |
|---|---|---|
| 2026-07-07 | 60 GiB | 1.13M |
| 2026-07-08 | 75 GiB | 1.10M |
| 2026-07-09 | 72 GiB | 1.10M |
| 2026-07-10 | 67 GiB | 1.06M |
| 2026-07-11 | 27 GiB | 0.47M |

Peak is **~60–75 GiB/day (~2 TB/month)**. Much of it is **"ghost" recording** — the recorder running for hours while the user does nothing.

### Root cause (validated)
The recorder has a **5-minute inactivity cap** that is *supposed* to stop capturing when idle ("stop capturing so background churn doesn't grow a ghost recording"). It's keyed on `isInteractiveEvent()`, which mirrors PostHog's `ACTIVE_SOURCES` (MouseMove, MouseInteraction, Scroll, Input, TouchMove, MediaInteraction, Drag).

**The Frameo canvas (tldraw) + several 1-second `setInterval` re-renders programmatically cycle focus/blur ~once per second**, even when nobody is interacting. rrweb records those as `MouseInteraction` → the recorder counts them as "activity" → the 5-min idle timer never expires → **it never stops recording**, and the client-owned `session_id` never rotates (same activity signal).

Evidence:
- Session `8a4894a0-…`: **3+ hours of chunks with ZERO tracked events**; hour-by-hour showed 182/303/141 chunks/hr with 0 events.
- Payload analysis of the idle window: near-equal **Focus (55) ≈ Blur (54)** pairs cycling on the *same DOM node* (`id:247`).
- Fleet-wide (10 min, all sessions): **~1.8 focus/blur events per real click**, focus≈blur — a periodic programmatic cycle, not a human.
- Confirmed in Frameo code: `ChatInputV3.tsx` does `editor.blur()` → `setTimeout(editor.focus)`; tldraw keeps focus on a hidden input; 1s interval re-renders re-assert it.

**Not a fork-specific bug:** PostHog's activity check is `ACTIVE_SOURCES.indexOf(event.data?.source)` (source only, no sub-type) — so PostHog counts Focus/Blur as activity too and would hit the identical runaway on a canvas app.

### Fix direction (separate workstream)
- Exclude **Focus/Blur** sub-types (and MouseMove) from `isInteractiveEvent` so the existing 5-min cap actually fires and the session rotates.
- Optionally a **tracked-event backstop**: rotate/stop if no real product event for 30 min (immune to any synthetic rrweb events).

> **This matters for storage:** fixing ghost recordings likely cuts daily volume substantially, which shrinks everything below. Do the recording fix *and* the archival — they compound.

---

## 2. Storage & retention design

### Current state (already in place)
```sql
-- migration 17
PARTITION BY toYYYYMMDD(started_at)            -- one partition per day
ORDER BY (project_id, session_id, started_at, chunk_index)
-- TTL:
ALTER TABLE session_replay_chunks
  MODIFY TTL toDateTime(started_at) + INTERVAL 30 DAY;   -- auto-DELETE after 30d
```
- **Deletion after 30 days is already automatic** (TTL DELETE).
- **Day-level partitions** mean dropping a day is instant (`DROP PARTITION`, no heavy mutation).

**So the only missing piece is: archive each day to Azure Blob *before* the TTL removes it.**

> **Interim decision (2026-07): archival is ON HOLD; do not alter the table yet.**
> For now we want to keep **more** data in ClickHouse for analysis — target **45 days** of hot retention (up from 30). The table's TTL is currently `30 DAY`, so actually retaining 45 days would require bumping it to `45 DAY` (a one-line `ALTER`) — **not yet applied**. The Azure-Blob archival design below is the *eventual* plan, not being built right now.

### Goal
- Keep **45 days hot** in ClickHouse (interim decision; was 30).
- **Archive every chunk to Azure Blob (ADLS Gen2)** as Parquet — **we never delete, we relocate.** ClickHouse is the hot cache; Blob is the store-of-record for all history.
- Only after a day is verified in Blob does ClickHouse drop it (TTL). Nothing leaves CH before it's safely archived.

### Decision (2026-07): ClickHouse writes to Blob directly, run from a K8s CronJob

> **This is the SHIPPED design — see [session-replay-blob-archive.md](session-replay-blob-archive.md) for the authoritative, implementation-accurate reference (Parquet layout, `replay_archive_index` schema, watermark, retrieval).** The Databricks-based alternative explored in the sections below was **superseded**: we verified on prod that Aiven ClickHouse *can* write to Blob via `INSERT INTO FUNCTION azureBlobStorage(...)`, so a thin **K8s CronJob** (`pnpm --filter @openpanel/db archive:replay`) orchestrates the export — ClickHouse streams the Parquet directly to Blob, with no Databricks/Spark and no bytes flowing through Node. Everything from here down is retained only as exploratory context; where it conflicts with the shipped design, the shipped design wins.

### 1. Storage — a dedicated ADLS Gen2 account

Create a **new dedicated storage account** (isolation, clean cost attribution, its own lifecycle + access):

| Setting | Value | Why |
|---|---|---|
| Name / RG | e.g. `dashreplayarchive` / `rg-frameo` | dedicated; Frameo replay data |
| Region | **Central India** | match other accounts + ClickHouse; no cross-region egress |
| Kind | StorageV2, **Hierarchical Namespace ON (ADLS Gen2)** | Databricks/Synapse/Spark query the Parquet directly; ClickHouse can still read it via `azureBlobStorage()` |
| Default access tier | **Cool** | cheap storage, **instant** reads |
| Redundancy | **ZRS** (GRS if cross-region DR wanted) | store-of-record durability |
| Soft-delete + versioning | **ON** | protect the archive from accidental deletion |
| Lifecycle rule | Cool → **Cold @ 90d** (both instant); **Archive** only @ 1yr+ *or never* | cheap and keeps retrieval instant. **Avoid the Archive tier if instant retrieval matters — it needs hours to rehydrate.** |

Container, Hive-partitioned so a single day/project reads cheaply (shipped: container `clickhouse-export`, session-hash `bucket=N.parquet` files):
```text
clickhouse-export/dt=YYYY-MM-DD/project_id=<p>/bucket=<hash>.parquet
```

### 2. Archival job — Databricks (read ClickHouse → write Parquet)

Same shape as the existing events jobs; scheduled as a Databricks Workflow (daily, or hourly for smaller runs):

```python
day = "2026-07-13"
df = (spark.read.format("jdbc")
  .option("url", "jdbc:clickhouse://<aiven-host>:<port>/default?ssl=true")
  .option("user", dbutils.secrets.get("ch","user"))
  .option("password", dbutils.secrets.get("ch","pass"))
  .option("query", f"""
     SELECT project_id, session_id, chunk_index, started_at, ended_at,
            events_count, is_full_snapshot, window_id, payload
     FROM session_replay_chunks
     WHERE toYYYYMMDD(started_at) = {day.replace('-','')}
  """)
  # parallelize the read — a day is 60–75 GiB; don't pull it through one socket
  .option("partitionColumn","chunk_index").option("lowerBound","0")
  .option("upperBound","2000").option("numPartitions","24")
  .load())

# sort so a later single-session read prunes Parquet row-groups (matches CH ORDER BY)
df = df.sortWithinPartitions("project_id","session_id","chunk_index")

# idempotent: overwrite the day's partition path on re-run
(df.write.mode("overwrite")
   .partitionBy("project_id")
   .parquet(f"abfss://replay-chunks@dashreplayarchive.dfs.core.windows.net/dt={day}/"))
```

Notes:
- **Auth:** grant the Databricks workspace access to the new account — Unity Catalog external location + storage credential (preferred), a service principal, or account key/SAS to start.
- **Don't hammer live CH:** read off a replica if Aiven provides one, and keep the read parallelized (predicates by hour / `chunk_index` / session hash).
- **Sort is load-bearing** — without it, single-session retrieval scans the whole day file.
- **Format:** Parquet (columnar, compressed, re-readable by CH / Databricks / Synapse). Delta is an option if we want ACID + time-travel on the archive.

### 3. Index / manifest

After each write, record what's archived: a small `replay_archive_index` (a Delta table and/or a tiny CH table) — day, project, session_id range, blob path, row count. Lets retrieval find *which blob holds session X*, and lets us **verify Parquet rows == CH rows per day before anything is dropped**.

### 4. Retrieval — real-time in OpenPanel + analytics

One Parquet copy, multiple readers:
- **Recent (within the 45-day CH window):** served from ClickHouse exactly as today — unchanged, full speed.
- **Archived session in OpenPanel:** the read path falls back to Blob — look up `replay_archive_index` → `SELECT … FROM azureBlobStorage('<path>', 'Parquet') WHERE session_id = X ORDER BY chunk_index` → returns the **same chunk shape** → player unchanged → cache the result in Redis. Because the Parquet is sorted by `session_id`, this reads a few MB (row-group pruning), not the whole day — real-time-ish, then cached.
- **Bulk / analytics:** Databricks queries the same Parquet directly.
- **If Aiven blocks CH reading Azure:** fallback is an on-demand restore (copy that session's rows back into a temp CH table) or a small **Databricks SQL** query for the rare old-session view.

### Rollout order (no data loss)
1. Ship the **ghost-recording fix** (Focus/Blur exclusion) — shrinks the volume before we archive it.
2. **Create the ADLS Gen2 account** + grant Databricks access.
3. Build + run the **Databricks archival job**; backfill the days currently in CH; verify Parquet rows == CH rows via the manifest.
4. Wire the **OpenPanel read-back** (index lookup + `azureBlobStorage()` fallback).
5. **Only after** archive is verified end-to-end, bump TTL to 45 days and let CH drop older days — keeping TTL ≥ the archive lag so nothing is deleted before it's safely in Blob.

### Verify before building
- **Aiven ClickHouse** allows JDBC reads at archival scale (for the Databricks read) and `azureBlobStorage()` **reads** (for the OpenPanel fallback). CH-write-to-Azure is **not** required — Databricks does the write.
- **Databricks workspace** has access to the new account (external location / credential).
- **Also consider `sampleRate`** (record fewer sessions) as a complementary volume lever.
