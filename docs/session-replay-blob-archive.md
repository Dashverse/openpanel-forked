# Session Replay — Blob Archive

**TL;DR:** ClickHouse keeps replays hot for a rolling window (**30 days today → moving to 45**). A K8s pod copies every chunk to **Azure Blob** so we keep **all** replays **forever** and never lose data. OpenPanel serves recent replays from ClickHouse and old ones from Blob — transparently.

> **Validated against industry practice:** this is essentially PostHog's architecture — recordings in blob storage, only a small pointer/metadata in the analytics DB. PostHog *started* with recordings in ClickHouse and deprecated it because it was "impractical and expensive at scale." Partition-by-date + sort-by-lookup-key + pre-signed direct downloads are all standard.

---

## Why
- Replay volume is ~**1 TB/month** — too much to keep hot in ClickHouse.
- We don't **delete**, we **relocate**: ClickHouse = hot cache, Blob = store-of-record (forever).
- Scale is small: ~**3–4k sessions/day**, avg ~**10–20 MB/session**.

## How we store it
A **K8s pod** reads from ClickHouse (daily) and writes to Azure Blob (ADLS Gen2), partitioned by **day + project**:

```
replay-chunks/
  dt=2026-07-14/                ← day (UTC)
    project_id=frameo/          ← project
      part-000                  ← big files, not many tiny ones
      part-001
```

Each **row = one chunk**: `profile_id · session_id · window_id · chunk_index · started_at · ended_at · payload`

- **Partition (folders) = day + project.**
- **Sorted by `session_id, window_id, chunk_index`** → one session's rows sit together (fast lookup).
- **Timezone = UTC everywhere** (partition + query). IST only for display labels; playback is timezone-free (absolute timestamps).
- **`profile_id` snapshotted at export** (from events, while still hot in CH) → archive is self-describing.

> **Open decision — file format:** **compressed JSON blocks** (simplest, playback-first — what PostHog does) vs **Parquet** (columnar, only worth it if we'll run analytics on the *replay payloads* in Databricks). Recommendation: **blocks unless payload-analytics is a real need.** Events analytics already live in Databricks separately.

## How we retrieve (the key part)
- **Recent (in the hot window):** served from ClickHouse exactly as today — unchanged, full speed.
- **Archived (older):** three-hop, all fast:
  1. **Index → exact locator.** A permanent index maps `session_id → project, dt, blob path (+ byte range)`. One lookup, ~5 ms. *No day-scan.*
  2. **Direct fetch.** Read exactly that object (byte-range GET) — a few MB, not the whole day.
  3. **Pre-signed URL.** The client downloads **straight from Blob** (like PostHog) — the API never proxies the bytes. Result cached in Redis.
- **First open ~0.3–0.5 s; instant on replay/scrub (cached).**

## Index (the "where is it" pointer)
- Lives in a **small DB table** (Postgres, or hung off existing session metadata), **kept forever** — outlives the CH copy.
- Shape: `session_id → profile_id, project_id, dt, blob_path (+ byte offset)`.
- Written by the **pod** at archive time (it's the only thing that knows which object each session landed in).
- ~3.5k rows/day → ~1.3M/year — trivial.

## Fallback
- If Aiven ClickHouse can't read Blob directly: fall back to **pre-signed-URL fetch in the app**, an **on-demand restore** into a temp CH table, or **Databricks SQL**.
- Full **event feed** for an old session comes from **Databricks** (events archive), joined on `session_id`. `profile_id` is already in the archive, so "whose replay" needs no lookup.

## Retention
- **ClickHouse:** rolling hot window — **30 days today, moving to 45** (one-line TTL change, *not yet applied*).
- **Blob:** forever — **Cool → Cold** tier (both instant retrieval; avoid Archive tier — hours to rehydrate).
- Nothing is dropped from ClickHouse until it's **verified in Blob**.

## Open items before build
1. Does **Aiven ClickHouse** allow reading Blob (`azureBlobStorage()`)? If not → pre-signed URL / Databricks read.
2. **Databricks events retention ≥ replay retention** (so old replays keep their event feed).
3. **File format decision** (blocks vs Parquet — see above).
