# Database improvement plan — second opinion on the AdmiralDBExplorer review

2026-08-25. Source documents: `AdmiralDBExplorer/docs/schema-review.md` and
`actual-data-profile.md` (external review of the 2026-08-21 22:40Z offline snapshot).
Every load-bearing claim below was re-verified against the **live** DB
(`C:\dev\admiral\data\admiral.db`, 218.3 MB, server stopped) and the current code.

## Verdict on the external review

Competent structural review; strongest on schema mechanics, weakest on operational
context. Verified claim-by-claim:

### Confirmed — real defects worth fixing

| Claim | Live verification |
|---|---|
| `idx_fis_police` created only in the legacy ALTER branch → clean DBs never get it | Confirmed at [db.ts:772-774](../src/server/lib/db.ts) — index creation sits inside `if (!fisCols.some(...))` |
| `balance_after` empty on every ledger row | Confirmed: **0 of 10,535** live. Root cause found (below) — buy/sell payloads carry no `player.credits`/`wallet`, which is all `readBalance()` reads |
| No versioned migrations (`user_version` 0, imperative `IF NOT EXISTS` + ALTER branches) | Confirmed; the idx_fis_police drift is the proof it bites |
| Year-1 sentinel timestamps in `freight_contracts` | Confirmed: **18 of 18** rows. Nuance: the sentinel comes from the *game API* (`accepted_at: 0001-01-01T00:00:00Z` in raw responses) — capture should normalize to NULL, history can be backfilled in one UPDATE |
| One `system_danger_daily` orphan | Confirmed: 1 row |
| OpenAPI caches bloat `preferences` | Confirmed: 2.67 MB across two spec keys (1.96 MB + 0.7 MB) |
| `fleet_orders` 75.8% cancelled with no reason/superseder recorded | Accepted (matches how cancels are issued today) |
| Facilities/killzone capture gaps (owner, build_cost, maintenance, killzone system_id) | Accepted; folded into the capture-completeness batch |
| Credentials populated in plaintext | Confirmed (12 passwords, 3 API keys). Priority disputed — see Decisions |

### Wrong, moot, or missing context

| Claim | Reality |
|---|---|
| "Deduplicate unchanged directive/todo/memory snapshots" | **Already done.** The three triggers guard with `WHEN OLD.x IS NOT NEW.x` ([db.ts:183-205](../src/server/lib/db.ts)). The 17.7 MB is genuine change history; the real gap is **retention** (table is never pruned) |
| "schema_version 87 vs 94" presented as app versioning drift | That is **`PRAGMA schema_version`** — SQLite's internal DDL counter, incremented by every CREATE/ALTER. It is not an app version; the historical DB simply executed more DDL (the legacy branches). The genuine finding is `user_version = 0` |
| Storage remediation via content-addressed artifact store | Over-scale. `auto_vacuum=INCREMENTAL` is already on, `incremental_vacuum` already runs after every prune, freelist is 0. The fix is retention policy for the two unpruned tables, not an artifact architecture |
| "Budget and schedule evidence is absent" | Half-stale: `llm_spend_daily` is populated (backfilled 22,405 rows / $2,011). `context_budget` is a per-profile *knob* (read at [agent.ts:390](../src/server/lib/agent.ts)), unset = default ratio — not missing evidence |
| Empty tables read as data gaps | Context: `insurance_policies` empty **by doctrine** (fleet self-insures); `schedules`/`event_triggers` unused by choice. But `empire_policy_snapshots` and `fleet_intel_threats` empty because their **capture hooks never fire** — that part is a real bug |

### New findings (neither document caught these)

1. **URGENT — the 7-day prune will wipe the pathfinder corpus ~Aug 28-29.**
   `pruneOldData` deletes `fleet_intel_systems` rows where `updated_at` is older than
   7 days. All 505 rows currently date from the Aug 21-22 seed/sweep. Police levels,
   empire, POI types — quasi-static world facts that cost a four-agent evening to
   collect — evaporate on the next prune cycle after Aug 28. Worse, `assessSystemDanger`
   treats unknown police as RISKY, so the loss actively degrades danger grading.
   (`system_links` — the routes themselves — are *not* pruned; routes are safe.)
2. **Why `balance_after` never populates:** `readBalance()` reads `r.player.credits ?? r.wallet`;
   live `raw_ref` samples show buy/sell payloads carry neither. Robust fix: the server
   already holds each agent's live credits in its cached game state — pass it into the
   ledger as a balance hint at insert time instead of re-parsing payloads.
3. **Retention gaps confirmed live:** `action_events` never pruned (47,521 rows back to
   June 3), `profile_state_history` never pruned (17.7 MB). These two plus log detail
   are the actual size story.
4. **Free backfill nobody costed:** empire (and station presence) for every system is
   derivable from the free `https://game.spacemolt.com/api/stations` endpoint — no agent
   turns. Coverage today: empire 70/505 from gameplay; the endpoint can fill most of the rest.
5. `fleet_intel_market` **is** pruned at 7 days (their "3,943 rows" table implies
   accumulation; it is a rolling window by design).

## The plan

### P0 — this week (stop data loss, fix correctness)

1. **Retention policy split — volatile vs. static intel.** `fleet_intel_systems` stops
   age-pruning entirely (world facts don't rot; rows are upserted on revisit). Add the
   missing retention instead: `action_events` 90d, `profile_state_history` last 20
   versions per profile+field. One-time `VACUUM` after the first prune with the new
   rules. *This must land before Aug 28.*
2. **Versioned migrations, right-sized.** Add a `schema_migrations` ledger
   (version, name, checksum, applied_at, build) driven off `PRAGMA user_version`;
   current initializer becomes baseline v1; all future DDL becomes numbered steps.
   Fold in the immediate fix: create `idx_fis_police` unconditionally.
3. **`balance_after` via server-side balance hint** from the agent's cached credits at
   booking time, plus a reconciliation view in `scripts/fleet-accounts.ts`: per
   profile/day, ledger sum vs. `wallet_daily` delta, flagging drift.
4. **Timestamp normalization at capture.** One `toUtcIso()` helper for new writes;
   freight capture maps year-1 sentinels → NULL (one-time backfill UPDATE for the 18
   rows); stub-row upsert for danger-table system references (fixes the 1 orphan and
   prevents the class).

### P1 — next (capture completeness, hygiene)

5. **Dead capture paths:** make `empire_policy_snapshots` and `fleet_intel_threats`
   hooks actually fire (or delete the tables if the payloads no longer exist);
   killzone rows get `system_id`; facilities capture owner/build_cost/maintenance.
6. **Free-endpoint backfill job:** empire + station data for all 505 systems from
   `/api/stations` at startup-time cost only.
7. **`fleet_orders.cancel_reason` + `superseded_by`** columns, populated at the
   cancel/replace sites — 75.8% of orders are cancels with no recorded why.
8. **OpenAPI spec cache → disk file** beside the existing catalog disk cache;
   preferences shrinks 2.67 MB and returns to being a settings table.
9. **Lite turn correlation:** a `turn_id` (uuid per `runAgentTurn`) stamped on
   `log_entries` (+ index). Joins "what did this turn call, cost, and conclude"
   without an orchestration warehouse.

### P2 — decided separately (see Decisions)

10. Credentials-at-rest handling.
11. STRICT + CHECK conventions for **new** tables (documented in CLAUDE.md; no
    retrofit rebuilds).
12. Declared-encoding pass: one comment per TEXT field — JSON / prose / enum / ref.

### Deliberately not doing (and why)

- **`runs` / `run_attempts` / `run_steps` / `tool_calls` warehouse, event
  inbox/outbox with correlation+causation, leases/heartbeats, artifact CAS,
  capability registry, evaluation metadata** — this is Temporal/Airflow-grade
  machinery for a 12-profile single-user fleet. The lite `turn_id` + existing
  per-call cost logs capture most of the debugging value at ~2% of the cost.
  Revisit only if the fleet scales or multiple Admirals coordinate.
- **Five-way `profiles` split** — churn across every route/component for
  permissions boundaries this deployment doesn't have.
- **Retrofitting FKs + STRICT onto existing tables** — table rebuilds with real
  regression risk under the no-test-suite constraint. Instead: `scripts/db-doctor.ts`
  (orphan/encoding/sentinel audit, runnable any time) added in P1 as the
  enforcement mechanism that can't break capture.

## Verification per change

`bun run build` → boot binary → exercise: prune dry-run counts before/after (1);
fresh-DB init in a temp dir diffed against live schema (2); one live buy/sell books a
row with balance (3); re-run the profiler's queries and confirm the finding closed.

## Execution log (2026-08-25)

**P0 — landed and verified same day.** Fresh-DB init now converges with the evolved
schema at `user_version=4` (idx_fis_police present, nullable freight timestamps,
migrations ledgered). Live DB: sentinels 0/18, orphans 0, state history 2,374 → 699,
file 218.3 → 203.2 MB via the existing incremental vacuum. `fleet_intel_systems` is
no longer age-pruned — the pathfinder corpus is permanent. `balance_after` fix is in
(top-level `credits` read); populates from the next real trade onward.

**P1 — landed and verified, with two findings the plan didn't predict:**

- **Manual/API commands ran NONE of the self-accounting captures.** The block lived
  only in `executeTool` (LLM path); silent admin commands took `Agent.executeCommand`.
  Extracted to `captureFromCommandResult()`, now called from both paths — ships,
  policies, freight, links, and empire policy capture identically everywhere. The
  capture catch also warns now instead of swallowing (the silence hid this for weeks).
- **`get_empire_info` on http_v2 returns structured data, not the text report** —
  `empires: [{empire_id, *_bps, eviction_grace_cycles, ...}]`. The hook now parses the
  structured form (richer: basis-point rates, `policy_updated_at`) with the text regex
  as v1 fallback. Verified live: all 5 empires captured, rates matching known values
  (crimson 1%/wk property, grace 260 everywhere).
- Stations backfill: 76 systems gained `has_station`/`station_services` from the free
  endpoint at boot. (The endpoint carries no per-system empire; empire coverage keeps
  filling from gameplay observations instead.)
- `turn_id` correlation live on `log_entries` (indexed); `cancel_reason`/`superseded_by`
  on `fleet_orders` with a `cancelFleetOrder()` helper all future cancels must use.
- OpenAPI specs moved to `data/openapi-cache-*.json`; preferences shed 2.67 MB.
- `fleet_intel_threats` emptiness is EXPLAINED, not broken: the pipeline works but its
  triggers (combat notifications, scan results) never fire — the fleet avoids combat
  and agents avoid `scan` because of the known QUERY_COMMANDS cooldown drift. No code
  change; fixing the scan classification is the upstream item.

**Deferred from P1** (small, next session): facilities capture for
owner/build_cost/maintenance; killzone rows missing `system_id`.

## Decisions (operator, 2026-08-25)

1. **Scope: P0 + P1 approved for execution.** P2 items stay parked in this doc.
2. **Credentials: keep as-is.** The documented local-machine tradeoff stands
   (127.0.0.1 bind, API never returns secrets, private encrypted OneDrive backup).
   The reviewer's P0 is declined for this threat model.
3. **Tracing: lite `turn_id` correlation.** The runs/attempts/steps warehouse,
   inbox/outbox, and leases are declined as over-scale.
4. **Intel decay: `fleet_intel_systems` is never age-pruned.** World facts persist;
   `updated_at` continues to carry staleness for danger grading.
