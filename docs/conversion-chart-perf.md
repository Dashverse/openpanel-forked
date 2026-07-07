# Conversion Chart Performance — Current Understanding

Document tracking the perf investigation for conversion charts with cohort breakdowns. Started May 2026, updated 2026-07-07.

## 2026-07-07 — Linear-chart property filter routed to profile_event_property_summary_mv

### What we found

The dashboard's linear (time-series) chart currently has two read paths:

1. `events_daily_stats` MV — used when there are NO filters and NO breakdowns (schema: `project_id, name, date`). Sub-second.
2. `events` table with query builder — used for everything else. Skip-index-driven pruning helps when the filtered column has one (`idx_country`, `idx_path`, etc.), but a filter on any column WITHOUT a skip index reads the full name-pruned slice and easily times out at 40s.

Concrete: on 2026-07-07 the `logIn + type='truecaller'` 30-day query took **52.4s** direct (6.68 B rows, 152 GiB read). `type` had no skip index and isn't in `proj_funnel`, so it was full-scan territory.

**But `profile_event_property_summary_mv` already exists and has EXACTLY the right sort key for this query shape:**

```
ORDER BY (project_id, name, property_key, property_value, profile_id, event_date)
```

The 4-column prefix matches "project + event + property + value" filters exactly. The MV is populated via `ARRAY JOIN mapKeys(properties) / mapValues(properties)` so every event contributes one row per (key, value) pair.

### Measured (2026-07-07, dashreels, 30-day logIn + type='truecaller')

| Read path | Elapsed | Rows read | Bytes read | Note |
|---|---|---|---|---|
| `events` + type filter (no skip idx) | **52.4 s** | 6.68 B | 152 GiB | Over 40s prod timeout |
| `events` + country='US' (has skip idx) | 7.9 s | 2.26 B | 11 GiB | Reference — same shape with skip idx |
| **`profile_event_property_summary_mv` (this route)** | **0.38 s** | **1.4 M** | **128 MiB** | ~140× faster than raw events |

Multi-property AND (`type='truecaller' AND $os='Android'`) via intersection JOIN: **0.39 s / 5.6 M rows / 457 MiB** — basically same speed as single-property. Not part of shipped MVP but confirmed working; follow-up PR.

### MV coverage window

`profile_event_property_summary_mv` was populated starting April 2026. Verified via `system.parts`:
- 202603 (March): 424 MiB (near-empty)
- 202604 (April): **2.96 TiB** (first fully-populated month)
- 202605 (May): 1.97 TiB
- 202606 (June): 1.34 TiB
- 202607 (July partial): 229 GiB

Retention window is ~3 months (older partitions are near-empty). Router gates on a **rolling 3-month cutoff** — `startDate < (now - 3 months)` falls through to the events-table path. Rolling gate (computed at query time, not a compile-time constant) means we don't need to redeploy as the retention window slides forward.

### Router shipped

Added `canUsePropertyMV` gate + `getChartSqlFromPropertyMV` builder to `chart.service.ts`. Sits between the existing `events_daily_stats` MV route and the events-table fallback.

Gate (intentionally conservative for MVP):
- Exactly ONE event-level property filter with `operator='is'` and non-empty value list
- `filter.name` starts with `properties.` (dashboard's canonical form)
- No breakdowns
- No cohort filters
- Segment: `user` or `event` (MV has profile_id + countState; no session-uniq state)
- Interval: `day` / `week` / `month`
- Event name is explicit (not `*`)
- Date range within a rolling ~92-day cutoff (`startDate >= today - 92 days`, recomputed per request)
Anything outside the gate falls through unchanged.

### What this doesn't cover (yet)

- Multi-property AND (2-3 filters) — works via intersection JOIN, measured 0.39s in the same session. Deferred to next PR to keep this MVP tight.
- Property breakdown (chart's breakdown-by-property, not filter-by-property) — needs a JOIN with sibling MV rows, adds complexity.
- Anonymous-heavy events (where `profile_id == device_id`) — MV excludes them via its WHERE clause; if we ever route an anonymous-heavy event we'd under-count. Only routing on filter-present shapes limits exposure — most filtered charts are on identified events (logIn, purchase, subscribeStart, etc.).
- Conversion / funnel queries — separate services, separate PR.

### Follow-ups

- Multi-property AND (2 filters) via intersection JOIN → probably ~80 more lines in the builder
- Extend to `conversion.service.ts` / `funnel.service.ts` read paths (same MV, different query shape)
- Instrument MV vs events routing decisions (metric: % of chart queries routed to MV, mean latency by route) to prove the win in aggregate

## 2026-07-04 — Fast path for property breakdown + ref_utm_source materialized

Two changes shipped together to fix the 30-day breakdown-by-property case (shortreels `installReferrer → deepLinkCaptured` with `ref_utm_source` breakdown, previously 35.6s on prod).

### 1. Materialized `ref_utm_source` column on `events`

The hourly `openpanel-materialize-analysis` CronJob picks up hot dashboard properties, ranks them by `usage × cardinality × size`, and executes `ALTER TABLE events ADD COLUMN <key> String MATERIALIZED properties['<key>']`. `ref_utm_source` had never been materialized because the analyzer only counts saved reports (not ad-hoc dashboard queries) and no saved report used it.

Manual `kubectl create job --from=cronjob/openpanel-materialize-analysis` run at 2026-07-03 17:52 UTC picked `events:ref_utm_source` (cardinality 10, well under the 5000 cap). Column exists in schema post-ALTER, new writes populate it, but OLD partitions store data only in the `properties` Map — CH computes the MATERIALIZED expression on read for those parts.

Backfill via `ALTER TABLE events MATERIALIZE COLUMN ref_utm_source IN PARTITION '<yyyymm>'`:

| Partition | Compressed | Uncompressed | Elapsed | Notes |
|---|---|---|---|---|
| `202607` | 89.5 GiB | 626 GiB | 14 min | Single big part `202607_0_45020_8` dominated |
| `202606` | 911.4 GiB | 6.35 TiB | 30 min | 9-way parallelism per replica; ~25 GiB/min throughput |

Progress observable via `system.parts.modification_time > mutation_start_ts` (parts pending vs rewritten) and `system.merges WHERE is_mutation = 1` (per-replica progress %). `system.mutations` is denied for `avnadmin` on Aiven, so `system.merges` is the primary monitoring surface.

Query-builder rewrite (`chart.service.ts` — `getSelectPropertyKey`) auto-swaps `properties['ref_utm_source']` → `ref_utm_source` once the API pod's 1h materialized-columns cache refreshes. Force-refresh via `kubectl rollout restart deployment openpanel-api -n prod` if immediate rewrite is needed.

### 2. Fast path extended to support ONE event-level property breakdown

The `buildArrayPatternSql` fast path in `conversion.service.ts` previously refused any breakdown (`breakdowns.length === 0` gate) — so a query with a `ref_utm_source` breakdown fell through to the multi-CTE ASOF LEFT JOIN path.

Extended the builder to accept an optional `breakdown` param. When set, emits a split-scan variant:

```sql
user_installs AS (SELECT resolved_pid, <breakdown_expr> AS b_0, groupArray(...) AS opens
                  FROM events WHERE name = '<first>' AND ...
                  GROUP BY resolved_pid, b_0),
user_finishes AS (SELECT resolved_pid, groupArray(...) AS finishes
                  FROM events WHERE name = '<last>' AND ...
                  GROUP BY resolved_pid),
user_events AS (SELECT ui.*, coalesce(uf.finishes, []) AS finishes
                FROM user_installs ui LEFT JOIN user_finishes uf USING (resolved_pid)),
per_user_per_day AS (arrayJoin over opens, keep b_0 threaded through),
agg AS (GROUP BY event_day, b_0 → total_first / conversions),
<top-N wrap via dense_rank OVER (ORDER BY _bucket_rate DESC)>
```

Why split rather than reuse the single-scan `user_events`: grouping the single scan by `(user, breakdown)` pins `finishes` to the install's breakdown bucket. Measured on shortreels — the single-scan variant reported `apps.instagram.com` converting at 6-10% because deepLinkCaptured events either carry empty or different `ref_utm_source` and never join with the install bucket. The split-scan variant preserves the "convert on the user, not on the utm-tagged finish" semantic → matched 22-93% (aligns with 94% observed on Query B's 3-day sample).

Fast-path gate (in `getConversion`) relaxed to allow ONE breakdown when it's a simple event-level property (not `profile.*`, not cohort, not custom event). All other paths (holds, cohorts, custom events, session group, TTC, multi-breakdown) unchanged and continue falling through to ASOF.

### Measured impact

Prod query (shortreels, 30-day `installReferrer → deepLinkCaptured` breakdown by `ref_utm_source`, executed via curl at 2026-07-03 evening):

| Path | Elapsed | Rows read | Bytes read | Notes |
|---|---|---|---|---|
| Baseline ASOF (properties Map) | ~50s (est) | — | — | Pre-materialization state |
| Baseline ASOF (materialized column) | **35.6s** | — | — | Post-materialization, current dashboard code |
| Fast path (single-scan, broken semantics) | 13.4s | 1.06 B | 77.2 GiB | Under-counts by-breakdown conversions — rejected |
| **Fast path (split scans, correct semantics)** | **20.1s** | 613 M | 38.3 GiB | Shipped |

**1.77× speedup on the exact 30-day breakdown query the user's dashboard runs.** Zero timeouts observed during test.

### What this doesn't fix

- Historical partitions older than 202606 still read `ref_utm_source` via the on-the-fly MATERIALIZED computation (= same speed as reading `properties['ref_utm_source']` directly). Query date ranges that reach into 202605 or earlier don't see the full win. To fix: run `MATERIALIZE COLUMN IN PARTITION '<older>'` as needed. Cost: ~4-8h per ~1 TiB partition.
- Multi-breakdown conversions (2+ properties broken down) still fall to ASOF.
- The `openpanel-materialize-analysis` CronJob still only scans saved reports for property usage. Ad-hoc dashboard queries don't feed the scoring input. Follow-up: extend the analyzer to read `system.query_log.query LIKE '%properties[%'` for a full-coverage usage signal.



## TL;DR

Conversion charts were hitting 40s timeouts on prod. Three PRs shipped so far:

- **PR #268 (merged)** — cohort event-criteria switched from `profile_event_summary_mv` to `cohort_events_mv` (1.2B → 27M rows on cohort CTE)
- **PR #269 (merged)** — IN-filter pushed into cohort CTE branches (cohort result 1.46M → 16K profiles)
- **PR #271 (open)** — `agg` CTE single-pass refactor (measured 2× speedup: 72M → 36M rows scanned per query)

**Dashboard queries are still hitting the 40s `max_execution_time` ceiling under cluster load.** Today's investigation confirmed:

- **Two distinct bottlenecks** depending on event volume:
  - LOW-volume events (showOpen, trialStarted): cohort scan against the 6.24 TiB `profile_event_property_summary_mv` is heaviest (~1 GiB / 9M rows)
  - HIGH-volume events (reelOpen, reelFinish, screen events): events table scan via `proj_funnel` projection is heaviest (~14 GiB / 211M rows for 8 days)
- **Under-load amplification of ~13–24×** — same SQL reads dramatically more data when cluster is busy. Runtime plan degradation we can't fully isolate.

Two PRs proposed next:

- **Slim events sidecar MV** with 14d TTL — fixes HIGH-volume event conversions (reelOpen-style charts)
- **45d TTL on `profile_event_property_summary_mv`** + cohort lookback audit — fixes LOW-volume + cohort-heavy conversions

Stack them and the 40s timeouts should end across all chart shapes.

## Original Problem

Users reported conversion charts loading in 30-40s and frequently timing out the dashboard. The slowest charts had cohort breakdowns enabled (e.g., A/B variants as breakdown values).

Sample slow query observed on prod (`dashreels` project, `showOpen → show1Activated` 8-day window, with cohort filter on `userFlags`):

- `read_rows`: 444M – 1.03B per call
- `query_duration_ms`: 40-42s
- `type`: `ExceptionWhileProcessing` — query killed by `max_execution_time = 40`

Dashboard user experience: error/timeout instead of slow response.

## Root Causes Identified

### 1. Wrong MV for cohort event criteria

The dynamic cohort path used `profile_event_summary_mv` for "did event X" queries. Its sort key is:

```
ORDER BY (project_id, profile_id, name, event_date)
```

This is good for "what events did profile P do" lookups. But cohort queries filter by `(project_id, name, event_date)` — `profile_id` is in position 2 unfiltered, so CH must scan every profile's events to find the ones matching `name = 'X'`. Near-full project scan.

`cohort_events_mv` exists (since 2024-10-15) with a different sort key:

```
ORDER BY (project_id, name, created_at, profile_id)
```

3-column prefix match for the cohort filter. Exactly the shape these queries want.

### 2. `IN (start_events_raw)` prefilter on outer wrapper, not pushed into MV scan

The dynamic cohort CTE was built as:

```sql
WITH `cohort-X` AS (
  SELECT profile_id FROM (
    SELECT profile_id FROM <property MV> WHERE ... GROUP BY profile_id HAVING ...
    INTERSECT
    SELECT profile_id FROM <event MV>    WHERE ... GROUP BY profile_id HAVING ...
  )
  WHERE profile_id IN (SELECT profile_id FROM start_events_raw)  -- outer wrap
)
```

ClickHouse computes the **full** cohort INTERSECT first (potentially millions of profiles), then filters down to the ~16K profiles in `start_events_raw`. The MV scans run over the entire population, not the relevant subset.

## Fixes Shipped

### PR #268 — Use `cohort_events_mv` for event-only cohort criteria

[#268](https://github.com/Dashverse/openpanel-forked/pull/268). Modified `buildEventCriteriaQuery` in [`cohort.service.ts`](../packages/db/src/services/cohort.service.ts) to read from `cohort_events_mv` instead of `profile_event_summary_mv` when computing event-only cohort criteria. Engine difference: `cohort_events_mv` is plain `MergeTree` (not `AggregatingMergeTree`), so `countMerge(event_count)` becomes `sum(event_count)`. Time column name changes from `event_date` to `created_at` (the `.replace()` in the old code is no longer needed).

**Measured on prod CH (cohort INTERSECT in isolation, dashreels / trialStarted, 3-week lookback):**

| metric | OLD (`profile_event_summary_mv`) | NEW (`cohort_events_mv`) | ratio |
|---|---|---|---|
| `read_rows` | 1,221,294,539 (~1.22B) | 26,739,451 (~27M) | **~46× less** |
| `read_bytes` | ~72 GiB | ~3.1 GiB | ~23× less |
| `elapsed` | 9–17s | 2.2s consistent | **~4–8× faster** |
| result set | 1,458,615 profiles | 1,458,627 profiles | match (HLL drift) |

Set-equality verified: `only_old=0`, `only_new=2` (drift from new events), `both=1,459,082`.

### PR #269 — Push `start_events_raw` IN filter into cohort CTE branches

[#269](https://github.com/Dashverse/openpanel-forked/pull/269). Added optional `profileIdPrefilter?: string` parameter to `buildEventCriteriaQuery`, `buildPropertyBasedCohortQuery`, and `buildCohortMembershipQuery`. When the conversion service builds the cohort CTE, it now passes `'SELECT profile_id FROM start_events_raw'` as the prefilter. The filter is injected into each branch's WHERE clause, so granule-level filtering can use it.

The outer wrap `SELECT profile_id FROM (...) WHERE profile_id IN (...)` is dropped because the prefilter is now applied inside.

**Measured on prod CH (cohort CTE only, with `start_events_raw` from a real 1-day showOpen scan):**

| metric | OLD (outer wrap, post-#268) | NEW (pushed, post-#268+#269) | ratio |
|---|---|---|---|
| `read_rows` | 26,739,451 | 27,034,985 | ~same |
| `read_bytes` | 3.1 GB | 1.59 GB | **~2× less** |
| `elapsed` warm | 2.2s | 257–272ms | **~8× faster** |
| cohort result rows | 1,458,627 | 16,322 | **~90× smaller** |

The 90× smaller result rows is the more important number for downstream — the `LEFT ANY JOIN` to flag cohort membership now hashes 16K profiles instead of 1.46M.

## What's Still Open

### Dashboard timeouts persist under cluster load

Aiven `query/stats` and `system.query_log` still show conversion queries averaging 30–39s with read_rows of 600M – 1.3B. These are `ExceptionWhileProcessing` entries — killed at the 40s `max_execution_time` ceiling.

**Investigation finding**: The PRs reduced steady-state cohort cost (~10s of work eliminated), but the remaining query work — events table scans and the `agg` double-inlining (see below) — is sensitive to runtime conditions on CH. Under cluster load (memory pressure, concurrent queries, in-flight merges), CH chooses worse physical plans for the same SQL, dramatically inflating read counts.

Reproducing this is hard: when the cluster is healthy, all 3 replicas serve the same query in 7–8s consistently (verified via 5 sequential curl runs landing on hosts 32 and 33). When load spikes, the same query on the same replicas reads 8× more rows and hits the timeout. Same SQL, same projection (`proj_funnel`), same data, same query plan in EXPLAIN — but different physical execution under stress.

This is **tail-latency from runtime plan degradation**, not a fixable bug in our SQL.

### `agg` CTE is computed twice per conversion query

The conversion SQL has:

```sql
WITH ...
  agg AS (SELECT event_day, b_0, ..., countIf(converted) AS conversions, ... FROM (...) GROUP BY ...),
  top_breakdowns AS (
    SELECT b_0, avg(conversion_rate_percentage) AS avg_rate
    FROM agg                                -- reference 1
    GROUP BY b_0 ORDER BY avg_rate DESC LIMIT 50
  )
SELECT agg.event_day, ...
FROM agg                                    -- reference 2
INNER JOIN top_breakdowns ON agg.b_0 = top_breakdowns.b_0
```

`EXPLAIN PLAN` confirms the full `agg` subtree (start_events_raw scan + end_events_raw scan + cohort INTERSECT) is computed twice — once for the outer SELECT, once for `top_breakdowns`. Every conversion query does ~2× the actual SQL work.

Fixing this would halve every conversion query universally (~7s → ~3.5s under normal load; ~40s → ~20s under stress, likely within timeout). Options:

- Use a window function (`avg() OVER (PARTITION BY b_0)`) instead of `top_breakdowns` JOIN
- Use `LIMIT BY` instead of the INNER JOIN to top_breakdowns
- Force agg materialization via a session-scoped temp table (heavier)

Not yet implemented. **Highest-ROI next move.**

### `max_execution_time = 40` is too tight

Bump to 120s as a band-aid so queries complete during load spikes instead of erroring. Not a fix — just stops the user-visible failures while we attack the underlying cost.

## Tests Run During Investigation (for future reference)

### How we measured PR #268

Two queries via curl against prod CH, 3 runs each, 60s timeout, comparing `X-ClickHouse-Summary` header:

```sql
-- OLD branch (pre-#268)
SELECT profile_id FROM profile_event_summary_mv
WHERE project_id = 'dashreels' AND name = 'trialStarted'
  AND event_date >= toDate('2026-03-26')
GROUP BY profile_id HAVING countMerge(event_count) >= 1
FORMAT Null;

-- NEW branch (post-#268)
SELECT profile_id FROM cohort_events_mv
WHERE project_id = 'dashreels' AND name = 'trialStarted'
  AND created_at >= toDate('2026-03-26')
GROUP BY profile_id HAVING sum(event_count) >= 1
FORMAT Null;
```

Also ran the full cohort INTERSECT (property MV + event MV) in OLD and NEW forms with 3 runs each.

### How we verified set equality

Pairwise set check after PR #268:

```sql
SELECT countIf(in_old AND NOT in_new) AS only_old,
       countIf(in_new AND NOT in_old) AS only_new,
       countIf(in_old AND in_new)     AS both
FROM (
  SELECT profile_id,
         max(src = 'OLD') AS in_old,
         max(src = 'NEW') AS in_new
  FROM (
    SELECT 'OLD' AS src, profile_id FROM (<old INTERSECT>)
    UNION ALL
    SELECT 'NEW' AS src, profile_id FROM (<new INTERSECT>)
  )
  GROUP BY profile_id
);
```

Result: `only_old=0, only_new=2 (drift), both=1,459,082`.

### How we ruled out replica imbalance

```sql
SELECT hostName() AS host, count() AS proj_parts, sum(rows) AS proj_rows
FROM clusterAllReplicas('default', system.projection_parts)
WHERE table LIKE 'events%' AND active AND name = 'proj_funnel'
GROUP BY host;
```

All 3 replicas: 151 projection parts, 9.88B rows, 588 GiB. Identical state.

5 sequential conversion query runs across replicas: all 7.3–7.5s, 72M rows. No replica is inherently slow.

### How we found the timeout situation

```sql
SELECT event_time, type, query_duration_ms, read_rows, hostName() AS host,
       tables, projections, ProfileEvents['SelectedParts'] AS parts
FROM clusterAllReplicas('default', system.query_log)
WHERE event_time >= toDateTime('2026-05-11 13:15:00')
  AND event_time <= toDateTime('2026-05-11 13:18:00')
  AND query LIKE '%cohort-d88ad6d3%'
  AND query NOT LIKE '%query_log%'
ORDER BY query_duration_ms DESC;
```

Showed `type = 'ExceptionWhileProcessing'` with read_rows of 444M-1.03B and durations right at the 40s ceiling. Confirmed queries were killed by `max_execution_time`, not finishing slowly.

## Next Steps (in priority order)

1. **Fix `agg` double-inlining** — refactor conversion.service.ts to avoid the `top_breakdowns AS (... FROM agg ...)` + outer `FROM agg INNER JOIN top_breakdowns` pattern. Halves every conversion query universally. ROI: highest among remaining options.

2. **Bump `max_execution_time`** for conversion queries from 40s to 120s. Band-aid — stops the user-visible timeouts during load spikes while we work the underlying cost. ~2-line change in `client.ts` or per-query via `clickhouse_settings`.

3. **Consider events-table slim sidecar MV** — `events_journey_mv` with just `(project_id, profile_id, name, session_id, created_at, materialized hold props)`. ~10-20% the size of `events`, scan would be 5-10× cheaper. Bigger workstream — only if (1) and (2) don't bring tail latency under control.

4. **Investigate the source of load spikes** — what other queries hit the cluster at 13:15-13:17? Are there cron jobs, batch imports, or analytics rollups that overlap with peak dashboard hours? Schedule them off-peak if so.

## File References

- Cohort SQL builder: [`packages/db/src/services/cohort.service.ts`](../packages/db/src/services/cohort.service.ts)
- Cohort membership query: [`packages/db/src/services/chart.service.ts`](../packages/db/src/services/chart.service.ts)
- Conversion service: [`packages/db/src/services/conversion.service.ts`](../packages/db/src/services/conversion.service.ts)
- Conversion TRPC procedure: [`packages/trpc/src/routers/chart.ts`](../packages/trpc/src/routers/chart.ts)
- CH client init: [`packages/db/src/clickhouse/client.ts`](../packages/db/src/clickhouse/client.ts)
- MV definitions: [`packages/db/code-migrations/3-init-ch.ts`](../packages/db/code-migrations/3-init-ch.ts) (cohort_events_mv), [`packages/db/code-migrations/4-cohorts.ts`](../packages/db/code-migrations/4-cohorts.ts) (profile_event_summary_mv)
- Materialize columns job: [`packages/db/src/services/materialize-columns.service.ts`](../packages/db/src/services/materialize-columns.service.ts)

---

# Updated Findings (2026-05-13)

## PR #271 — `agg` CTE single-pass refactor (open)

**Problem**: the conversion SQL referenced `agg` twice — once in `top_breakdowns AS (... FROM agg ...)` and once in the outer SELECT `FROM agg INNER JOIN top_breakdowns`. CH inlines CTE references, so the entire conversion subtree (events scans + ASOF JOIN + cohort INTERSECT) ran twice per query.

**Fix**: replaced `top_breakdowns` CTE + INNER JOIN with a window function over a single `FROM agg` reference. Uses a 2-layer subquery to avoid nested-window-in-ORDER-BY (which fails on CH 25.x):

```sql
SELECT event_day, b_0, total_first, conversions, conversion_rate_percentage
FROM (
  SELECT *, dense_rank() OVER (ORDER BY _bucket_rate DESC) AS _bucket_rank
  FROM (
    SELECT *, avg(conversion_rate_percentage) OVER (PARTITION BY b_0) AS _bucket_rate
    FROM agg
  )
)
WHERE _bucket_rank <= 50
ORDER BY _bucket_rate DESC, event_day ASC
```

**Measured impact** on dashreels `showOpen → show1Activated` 8d query (3 runs each, normal cluster load):

| metric | OLD | NEW | ratio |
|---|---|---|---|
| `read_rows` | 72.6M | **36.4M** | **2.0× less** |
| `read_bytes` | 6.81 GiB | **3.41 GiB** | **2.0× less** |
| `elapsed` | 7.7–9.0s | **3.5–4.0s** | **~2.2× faster** |
| `result_rows` | 16 | 16 | identical |

Halves every conversion query universally. Compatible with TTC and multi-breakdown holdProperties.

## Even with #271, dashboard still hits 40s under load

Verified via `system.query_log` at 2026-05-12 11:26:31 — the same SQL with #271 applied was killed by `max_execution_time`. ProfileEvents on the killed query:

```
type:               ExceptionWhileProcessing
duration:           40.7s (killed)
read_rows:          484M
read_bytes:         48 GiB (16.5 GiB compressed)
disk_read_us:       207s (summed across threads)
UncompressedCacheHits: 0           ← completely cold cache
SortedTotalRows:    0              ← sort never started
MergedRows:         0              ← merge never started
HashJoinPreallocated: 0            ← join never reached
memory_usage:       1.13 GiB       ← not memory-bound
CPU time:           98s            ← ~17% CPU utilization
parts touched:      165
```

**Key insight: the query is killed during disk I/O scan, before reaching JOIN/sort/window stages.** The agg refactor's window function is NOT the bottleneck — the bottleneck is **reading bytes off cold disk** at ~412 MB/s sustained.

The 484M rows scanned is ~13× more than the same SQL produced via curl under warm cache (~36M rows). Under-load amplification is real and consistent with our earlier observations. Same SQL, same projection (`proj_funnel`), same data — but CH chooses worse physical execution under memory/concurrency pressure.

## Per-component bottleneck analysis (2026-05-13)

Ran each conversion sub-query in isolation to find the heaviest table. dashreels, 8-day window, against warm cache:

| component | rows | uncompressed | compressed | parts | time |
|---|---|---|---|---|---|
| `profile_event_property_summary_mv` (userFlags 3w + property filter) | 9.43M | **1.03 GiB** | 290 MiB | 46 | 1.2s |
| `events` showOpen 8d | 6.47M | 441 MiB | 499 MiB | 19 | 0.5s |
| `cohort_events_mv` ($ae_first_open 3w) | 3.31M | 231 MiB | 115 MiB | 16 | 0.4s |
| `events` show1Activated 9d | 0.37M | 25 MiB | 328 MiB | 20 | 0.4s |

Sum in isolation: ~20M rows / ~1.73 GiB uncompressed.
Killed under-load query: 484M rows / 16.5 GiB compressed.
**Ratio: ~24× more work under load than the sum of isolated components.**

The 24× amplification factor is the dominant problem. No single component optimization fully solves it. But: **smaller per-row scans = smaller absolute bytes scanned even when amplified**, so fixing the scan size still gives proportional improvements.

## Bottleneck differs by event volume

Critical discovery: the heaviest component depends on which events the conversion uses.

### LOW-volume events (showOpen, trialStarted, $ae_first_open)

- 8-day showOpen: 6.47M rows / 441 MiB compressed
- Events scan is SMALL compared to cohort property MV scan
- Cohort scan is the bottleneck

### HIGH-volume events (reelOpen, reelFinish, screen events)

Tested with `reelOpen → reelFinish` 8d conversion, no cohort, no breakdown, 3 runs:

| metric | value |
|---|---|
| `read_rows` | **211M** |
| `read_bytes` (compressed) | **14.22 GiB** |
| `elapsed` | 19–23s (3 runs across hosts 32 and 33) |
| `cache_hits` | 0 (cold every run) |
| parts | 51–69 |

**14 GiB compressed for two events scans alone, no cohort involved.** Reels get opened/watched many times per session — ~30× higher volume than show-level events. For these queries, events scan IS the bottleneck.

## Two-bottleneck model

| chart type | events volume | dominant bottleneck | best fix |
|---|---|---|---|
| `trialStarted → show5Activated` + cohort | low | property MV scan (1.03 GiB) | TTL on property MV |
| `showOpen → show1Activated` + cohort | medium | both, ~50/50 | both fixes help |
| `reelOpen → reelFinish` (no cohort) | very high | events table scan (14 GiB) | slim events sidecar MV |
| `trialStarted → trialCancelled` (no cohort) | low | events scan but small | not slow today |

Neither single fix covers all cases. Both are needed.

## Proposed forward plan

### Plan A: slim events sidecar MV (`events_conversion_mv`)

Targets the HIGH-volume events case. Lighter row width + 14-day TTL.

```sql
CREATE MATERIALIZED VIEW events_conversion_mv
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toDate(created_at)               -- daily for clean TTL drops
ORDER BY (project_id, name, toDate(created_at), created_at, profile_id)
TTL created_at + INTERVAL 14 DAY DELETE
SETTINGS index_granularity = 8192
AS SELECT
  project_id, name, profile_id, session_id, created_at,
  country, region, os, browser, device, model,
  referrer_name, referrer_type,
  showId, source, variant, type, action, flow, step, phase
FROM events;
```

**Size estimate**: ~470 GiB (14d worth at ~30 GiB/day).

**Routing**: in `conversion.service.ts`, check if (date range ≤ 14d) AND (all referenced columns are in MV's schema) AND (no custom events filtering on non-MV columns). If yes → MV. Else → events table (existing behavior).

**Expected impact** on reelOpen-style queries: ~14 GiB → ~6 GiB compressed (per-row ~64 bytes → ~30 bytes). Cold-cache scan ~20s → ~10s. Fast path: 80-90% of analyst traffic.

**Maintenance hook** in [`materialize-columns.service.ts`](../packages/db/src/services/materialize-columns.service.ts): when a new column is materialized on `events` via `ALTER TABLE events ADD COLUMN`, the job needs to also:

1. `ALTER TABLE events_conversion_mv ADD COLUMN ...`
2. `ALTER TABLE events_conversion_mv MODIFY QUERY ...` to include the new column in the SELECT

The 14d TTL means old MV rows without the new column expire naturally — no manual backfill needed.

### Plan B: 45d TTL on `profile_event_property_summary_mv`

Targets the cohort-heavy case AND saves storage. Property MV is currently 6.24 TiB.

| TTL | drops everything before | storage freed | breaks cohorts with lookback > |
|---|---|---|---|
| 14d | 2026-04-29 | ~5.2 TiB | 14 days (breaks ~50% of current cohort queries) |
| 30d | 2026-04-13 | ~3.9 TiB | 30 days (breaks ~50% — 48-day lookbacks fail) |
| **45d** | 2026-03-29 | **~2.6 TiB** | 45 days (breaks ~5%) |
| 60d | 2026-03-14 | ~1.2 TiB | 60 days (covers all current cohorts) |

**Observed cohort lookbacks** in `system.query_log` (last 7 days):
- 45 queries: `event_date >= toDate('2026-03-26')` ≈ 48 days
- 39 queries: `event_date >= toDate('2026-04-21')` ≈ 22 days
- 7 queries: `event_date >= toDate('2026-05-08')` ≈ 5 days

Pre-requisite: audit cohort definitions in Postgres `cohort` table. Identify any with >45d match window. For A/B variant cohorts (assignment doesn't change over time), shorten to ≤30d.

After audit + shortening, apply 45d TTL. Saves ~2.6 TiB.

### Plan C: `max_execution_time` bump (band-aid)

From 40s → 120s for conversion queries. Doesn't fix the cost — just lets queries complete under load instead of erroring. 2-line change in `conversion.service.ts`:

```ts
clickhouse_settings: { 
  session_timezone: timezone,
  max_execution_time: 120,
}
```

### Combined expected outcome

For a worst-case chart (high-volume events + cohort breakdown):

| metric | today | + slim events MV | + slim MV + property TTL | + max_execution_time bump |
|---|---|---|---|---|
| events scan (cold) | 14 GiB | ~6 GiB | ~6 GiB | (no change) |
| property MV scan (cold) | ~1 GiB | ~1 GiB | ~300 MiB | (no change) |
| total compressed read | ~15.2 GiB | ~7.2 GiB | ~6.5 GiB | (no change) |
| cold-cache time @ 412 MB/s | ~37s (timeout) | ~17s | ~16s | ~16s, completes if amplified |
| warm-cache time | ~5s | ~2s | ~1-2s | ~1-2s |

Stacking the fixes drops cold-cache conversion queries from 40s timeouts to ~15s consistently.

## Open questions for team discussion

1. **TTL on property MV** — start at 45d (covers ~95% of cohorts) or 30d (more aggressive savings but requires shortening some cohort definitions)?

2. **Initial column set on slim events MV** — only the 18 columns I picked, or extend to all currently-active materialized columns from the registry (gives day-1 fast path for more queries, costs ~600 GiB instead of 470 GiB)?

3. **Funnel service** — should it also route through `events_conversion_mv`? Same fundamental SQL shape, same speedup potential, ~4 lines change in `funnel.service.ts`.

4. **Under-load amplification root cause** — the 13–24× amplification is a runtime plan choice we can't isolate from logs alone. Worth a CH-side investigation (system.metric_log around bad-load periods)?

5. **`materialize-columns.service.ts` modification** — confirm we're OK with the job also altering the new MV when adding columns, with 14d TTL covering the gap until full coverage.

## Diagnostic queries used in this session (for future reference)

### Per-component scan size
```sql
-- Run each component query in isolation with log_comment, then pull stats
SELECT log_comment, query_duration_ms, read_rows,
  formatReadableSize(read_bytes) AS bytes,
  ProfileEvents['SelectedParts'] AS parts,
  ProfileEvents['UncompressedCacheHits'] AS cache_hits
FROM clusterAllReplicas('default', system.query_log)
WHERE log_comment LIKE '<tag>%' AND type = 'QueryFinish';
```

### ProfileEvents on a killed query (find scan vs sort/join time)
```sql
SELECT 
  query_duration_ms, read_rows, formatReadableSize(read_bytes) AS bytes,
  ProfileEvents['SelectedParts'] AS parts,
  ProfileEvents['SelectedRanges'] AS ranges,
  ProfileEvents['DiskReadElapsedMicroseconds'] AS disk_read_us,
  ProfileEvents['UncompressedCacheHits'] AS cache_hits,
  ProfileEvents['SortedTotalRows'] AS sort_rows,
  ProfileEvents['HashJoinPreallocatedElementsInHashTables'] AS hash_join,
  memory_usage
FROM clusterAllReplicas('default', system.query_log)
WHERE event_time = toDateTime('<exact_time>')
  AND type = 'ExceptionWhileProcessing'
LIMIT 1 FORMAT JSONEachRow;
```

### Per-partition storage breakdown for an MV
```sql
SELECT partition, count() AS parts, sum(rows) AS rows,
  formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE table = '.inner_id.<UUID>'  -- inner table of the MV
  AND active
GROUP BY partition ORDER BY partition DESC;
```

### Lookback distribution in production cohort queries
```sql
SELECT 
  extract(query, 'event_date >= toDate\(''(\d{4}-\d{2}-\d{2})') AS lookback_date,
  count() AS query_count
FROM clusterAllReplicas('default', system.query_log)
WHERE event_time >= now() - INTERVAL 7 DAY
  AND query ILIKE '%profile_event_property_summary_mv%'
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
GROUP BY lookback_date ORDER BY query_count DESC;
```
