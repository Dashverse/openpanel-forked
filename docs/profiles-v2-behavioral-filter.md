# Profiles page — behavioural filter on the v2 property MV

Mixpanel-style **"Profiles who did event X (where property = Y) OP N times, in a
window"** — routed to `profile_event_property_summary_v2` for a ~350 ms answer
instead of a multi-second (occasionally multi-minute) raw-`events` scan.

Gated per-project behind an allowlist; anything the MV can't serve falls back to
the raw-`events` path, so it's always correct — just slower off the fast path.

---

## What the page is

Profiles page (the `identified` route is the default — the index redirects to
it, and the fork shows no tab nav, so it's effectively the single "all profiles"
page). It lists **all profiles (anonymous + identified)** and, optionally:

- an **event** (or several — OR), e.g. `showOpen`
- one **property** filter, e.g. `source is SEARCH_BUTTON` (one key, any number of
  values = OR)
- a **count threshold**, e.g. `more than 8 times`
- a **date window** (defaults to last 15 days, ending now)

Returns the matching profiles + a count, sorted by "Last seen".

## Routing — when v2, when fallback

`canRouteBehavioralToV2()` returns true only when **all**:

1. project ∈ `PROFILES_BEHAVIORAL_V2_PROJECTS` (env allowlist — per-project rollout)
2. window start ≥ `PROFILES_BEHAVIORAL_V2_START_DATE` (v2 coverage bound)
3. **exactly one** `properties.*` filter

Anything else → raw-`events` fallback (correct, slower). Rule 3 is the key one:

- **0 property filters** ("did showOpen at all") → v2 is the *wrong* table. v2
  explodes each event into one row per property (`ARRAY JOIN`), so a name-only
  scan reads ~10× the events across every property combo — slower than events.
- **2+ property keys** ("source=X AND screen=Y, same event") → v2 lost the
  co-occurrence in the explosion; only raw events can match both on one event.

## Two-step (v2 path)

1. **Rank in v2** — `WHERE project_id, name, property_key, property_value` (a
   sort-key prefix scan) `GROUP BY profile_id ORDER BY maxMerge(last_event_time)
   LIMIT 50`. All aggregation/sort/limit happen in v2; only the page comes back.
2. **Hydrate** the 50 ids from `profiles` via `getProfiles()` — `GROUP BY id`,
   **no `FINAL`**. (`profiles FINAL WHERE id IN (50)` merges across every monthly
   partition — ~17 M rows / ~2.1 s on prod; the no-FINAL aggregation is the same
   result in ~190 ms.)
3. **"Last seen"** = the ranked `last_event_time` (exact, see below), sorted by it.

The count query uses the **identical** WHERE + HAVING (just `count()` / grouped),
so the top-line number and the rows can never disagree.

## Timezone handling — the invariant

The user picks wall-clock times in the project tz (e.g. IST). Those are converted
**once** to a UTC instant, and every comparison is UTC on both sides:

- `events.created_at` is **UTC**.
- `v2.event_date` = `toStartOfDay(created_at)` in **UTC** → a **UTC-day bucket**.
- `v2.last_event_time` = `maxState(created_at)` → the **exact UTC instant** (ms),
  *not* the day bucket.

The `event_date` WHERE bound must therefore be UTC-day aligned:
`toStartOfDay(toTimeZone(toDateTime(x, tz), 'UTC'))`. Truncating in the project
tz instead lands ~half a day off and silently drops the last UTC day of the
window — this was a real bug (undercounted a 3-day window's count by ~29%).

## Exact-window clamp — "last seen *within* the window"

`event_date` is UTC-day granular, so it over-includes the partial edge days (a
`09:00 → 13:59` IST window would leak `05:30 IST` / next-day `05:29 IST` rows —
UTC midnight shown in IST). Because `last_event_time` is exact, we add a `HAVING`:

```
HAVING maxMerge(last_event_time) BETWEEN <startInstant> AND <endInstant>
```

This makes membership + the displayed times **strictly** "profiles whose last
such event is inside the window". Consequences (intended):

- Every "Last seen" time falls inside the picked window (no 05:29 artefacts).
- A **straddler** (did it in-window *and* again after) is excluded — its last
  event isn't in-window, and v2's daily max can't recover the in-window max. This
  is why the clamped count is lower than the raw UTC-day count.

Exact intra-day cutoffs for a *past mid-day* window are only possible on the v2
path via this clamp; the raw-events fallback bounds `created_at` exactly by
instant natively.

## Count threshold — `did event OP N times`

`countHavingClause()` maps 8 operators to a `HAVING` on the count expression
(`countMerge(event_count)` on v2, `count()` on the fallback):
`eq, ne, gt, gte, lt, lte, between, notBetween`. Evaluated over the audience
"profiles who did the event", so `lt 3` = "did it 1–2 times", **not** "including
profiles that never did it" (they aren't in a "who did X" audience; `= 0` / `< 1`
return empty). `gte 1` is a no-op. "Is numeric / Is not numeric" are intentionally
omitted — a count is always numeric; those are property-value operators.

## Semantics today (OR), and what's deferred

On the fast path everything is **OR**; the only AND is multi-key property filters
(→ fallback):

| Add… | Meaning | Path |
|---|---|---|
| more values on one key (`source ∈ {A,B}`) | OR | v2 |
| more events (`showOpen`, `trialStarted`) | OR (did either) | v2 |
| more property **keys** (`source=X` and `screen=Y`) | AND, same event | events fallback |
| events with AND ("did both") | intersection | **deferred** |
| per-event property filters, `then`/funnel | — | **deferred** |

**Deferred multi-condition builder** (Mixpanel `and`/`or`/`then` rows): reachable
on v2 for `and` (INTERSECT on `profile_id`) and `or` (UNION) — each row is a
prefix-scan subquery. `then` is a funnel (needs event ordering v2's daily grain
can't provide → funnel engine / raw events). Same-event multi-property is the one
thing INTERSECT genuinely can't reconstruct (co-occurrence lost in the explosion).

## Anonymous + identified

The page shows **all profiles** — no `is_external` filter. The behavioural count
counts distinct `profile_id`s who did the event, which includes anonymous
`device_id`s (v2 has no `profile_id != device_id` filter). The base list must
therefore also include anonymous, else adding an event filter could *raise* the
count above the identified-only base.

## Env / config

- `PROFILES_BEHAVIORAL_V2_PROJECTS` — comma-separated allowlist (per-project rollout).
- `PROFILES_BEHAVIORAL_V2_START_DATE` — earliest window start v2 may serve.

## Files

- `packages/db/src/services/profile.service.ts` — routing, two-step, clamp,
  operators, count.
- `packages/db/src/clickhouse/client.ts` — v2 in `TABLE_NAMES`.
- `packages/trpc/src/routers/profile.ts` — `eventCount` input.
- `apps/start/.../profiles._tabs.identified.tsx` — query wiring, 15-day default,
  all-profiles (no is_external).
- `apps/start/src/components/profiles/event-count-filter.tsx` — operator control.
- `apps/start/src/components/events/filters/events-filters.tsx` — `eventLabel` +
  `afterEventSlot` props.
- `apps/start/src/components/{column-created-at,profiles/table/columns,profiles/last-seen-range}.tsx`,
  `apps/start/src/hooks/use-profiles-sort.ts` — Last-seen display + URL state.
