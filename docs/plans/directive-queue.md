# Directive queue (plan steps per agent)

Decided with the Admiral's operator on 2026-09-10 (18:15 CT); implemented the same evening.

**Status: LIVE.** Backend `src/server/lib/plan-queue.ts` (evaluator), table `directive_queue`
in `db.ts`, hook at the loop head in `agent.ts`, routes `src/server/routes/plan.ts`
(`/api/profiles/:id/plan`), panel `components/character/tabs/PlanTab.tsx` (the "Plan" tab on
the character page). Tests: `tests/plan-queue.test.ts` (subprocess helper). The two hand-rolled
watchers of that day (CyberSpock phase-1 crafting, Ledger Voss tritium expedition) are the
fixtures the test encodes.

## Decisions

- **Agent sees the active step only.** No upcoming steps, no orientation line. One job,
  one directive, under the per-profile character cap (1,200 for local-model agents).
- **Steps apply between turns**, at the loop head in `agent.ts` (the `while (this.running)`
  loop), never via `restartTurn()`. The existing prompt rebuild (`currentDirective !==
  cachedPromptDirective`) makes the swap take effect on the next turn.
- **Default safe-moment gate on every step:** docked at a station and no macro in flight
  (`goto_system`, `mine_until_full`, `sell_cargo`). A step can name the station.
- **Steps replace the directive, never append.** Each step stores the directive it
  displaced (`restore_to`) so a plan's final step can restore the loop directive.

## Schema (proposed)

`directive_queue`: id, profile_id, plan_id, plan_name, seq, title, directive, todo (nullable),
condition_json, completion_json (nullable), status (queued|armed|active|done|cancelled|skipped),
restore_to (nullable), fired_at, completed_at, notes, created_at.

## Condition vocabulary (all evaluated from harness state, no agent turns)

- `docked_at: <station_id>` / `docked: true`
- `no_macro: true` (default on)
- `result_matches: <substring>` against tool_result summaries since the step was queued
- `storage_at_least: {station_id, item_id, qty}` — evaluator refreshes a stale
  `storage_inventory` snapshot with a silent `view_storage` when docked there (today's bug)
- `cargo_at_least: {item_id, qty}` — the ship's own hold, read from the connection's live
  local state (the last player-scoped result: get_cargo, refuel, sell …); `cargo unknown`
  until the hold has been read once. Added 2026-09-11 after a load step retired on
  `docked_at` while two of its three withdraw lines had been skipped — gate a load on
  what is aboard, not on where the ship is
- `wallet_at_least: <credits>`
- `after: <ISO time>` (cron already exists in `schedules`; do not duplicate it)
- `admiral_go: true` — never fires on its own; a fire-now button or API call releases it

## Hook points

- Evaluate at the loop head before each turn (`agent.ts` ~line 444).
- Fresh facts come from the tool-result chokepoint in `tools.ts` next to
  `recordStorageFromCommand` / `captureFactionFromCommand`.
- Every fire writes a `system` log entry: `Plan <name> step <seq>/<n> applied: <title>`.
  Failed checks are silent.

## Panel

New tab on the character dossier page (`components/character/tabs/PlanTab.tsx`) beside
Financials/Inventory: ordered steps, status pills, condition in words, char count vs cap,
fired/completed times, edit / reorder / cancel / insert-before, fire-now override.
API: `GET/POST /api/profiles/:id/plan`, `PUT/DELETE /api/profiles/:id/plan/:stepId`,
`POST /api/profiles/:id/plan/:stepId/fire`.

## Non-goals for v1

Merging with `event_triggers` or `fleet_orders`; agent-authored steps; cross-agent plans.
