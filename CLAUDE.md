# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Admiral is a web-based manager for **SpaceMolt** (an MMO played by AI agents). It
runs multiple autonomous agents at once — each with its own game connection, LLM
loop, and log stream — and serves a React dashboard for monitoring and control.

## Commands (use Bun, not Node/npm)

```bash
bun install            # install dependencies
bun run dev            # backend :3031 + Vite :3030 (hot reload, via concurrently)
bun run build          # build frontend + compile standalone `admiral` binary
./admiral              # run the compiled binary (admiral.exe on Windows); serves :3031
```

- Runtime is **Bun** (`bun:sqlite`, `bun build --compile`). Do not introduce Node-only APIs.
- There is **no automated test suite**. Verify changes by: `bun run build` must
  succeed, then boot the binary and exercise the relevant API/UI (see Verifying below).
- `tsc --noEmit` reports a handful of *pre-existing* errors (Bun-only globals like
  `import.meta.dir` / `bun:sqlite`, plus a couple of `unknown` casts). These are
  expected — the project builds via Bun's bundler, not `tsc`. Don't treat them as
  regressions; just make sure you don't add *new* ones in files you touch.

## Layout

```
src/server/         Bun + Hono backend
  index.ts          app wiring, static serving, scheduler + retention prune startup
  lib/agent.ts      Agent class — connection lifecycle, LLM loop, state caching
  lib/loop.ts       runAgentTurn() — one LLM turn: tools, compaction, retries
  lib/agent-manager.ts  singleton over all agents: connect/disconnect/restart/backoff
  lib/tools.ts      tool execution (local tools + game commands), cooldowns, query cache
  lib/db.ts         SQLite layer (bun:sqlite, WAL); schema auto-migrates on startup
  lib/connections/  GameConnection impls: http, http_v2, websocket, mcp, mcp_v2
  lib/briefing.ts   background collector → text briefing injected into prompts (0 LLM cost)
  lib/fleet-intel.ts  passive shared market/system/threat intel from agent responses
  lib/schema.ts     fetch/parse SpaceMolt OpenAPI spec → command signatures
  routes/           Hono handlers (profiles, providers, analytics, schedules, logs, ...)
src/frontend/       React 19 + Vite 6 + Tailwind 4 dashboard
src/shared/types.ts shared TS interfaces
```

`.github/copilot-instructions.md` has deeper architecture notes and a longer
"lessons learned" list — read it before non-trivial backend changes.

## Data & secrets (important)

- All state lives in **`data/admiral.db`** (SQLite). This directory is **gitignored**
  and never committed — it holds SpaceMolt agent credentials and LLM provider API
  keys in plaintext on the local machine.
- The server binds to **`127.0.0.1` by default**. Set `ADMIRAL_HOST=0.0.0.0` only
  to intentionally expose it to the LAN (it warns on startup).
- The API **never returns** `password` (profiles) or `api_key` (providers) — it sends
  `has_password` / `has_key` flags instead. Writes treat an empty secret as "keep the
  existing value" so the UI can edit a record without wiping the secret it can't read
  back. Preserve this contract when changing profile/provider routes.

## Invariants — don't regress these

- **System-prompt cache:** the prompt is only rebuilt when memory, directive, phase,
  or briefing *content* changes. Do not add `briefingEnabled ||` to the invalidation
  condition — it defeats the cache.
- **Compaction budget:** `messageBudget = (contextWindow − systemPromptTokens) * ratio`,
  floored to a sane minimum. Never compare message tokens against the *full* window,
  and never let the budget go to zero/negative — both cause per-turn compaction thrash.
- **Query vs action commands:** queries are free (no game tick); actions cost a tick
  and are rate-limited by a cooldown. Keep `QUERY_COMMANDS` in `tools.ts` accurate.
- **Connection retries are bounded:** `rate_limited` retries are capped; MCP
  session-expiry re-init retries at most once (re-running a mutation twice is a bug).
  Connections clear notification handlers on `disconnect()`.
- **Stopping an agent:** add the profileId to `stopRequested` so backoff doesn't
  auto-restart it; `Agent.stop()` also clears per-profile state in `tools.ts`.
- **An aborted LLM response is a failure, never an idle turn.** A timed-out call
  returns `stopReason: 'aborted'` with a *partial* `thinking` block and 0/0 usage —
  it is not `'error'` and its content is not empty, so it slips past both guards in
  `completeWithRetry` unless explicitly caught. If it is returned as a real
  response, the turn loop sees zero tool calls on round 0, scores the turn `idle`,
  and three of those trip the idle backoff, which parks the agent until a human
  nudges it. Covered by `tests/llm-abort-handling.test.ts`.
- **A turn must never end without the agent recording state.** The prompt tells it
  to persist *after* acting, so a turn guillotined at the tool-round cap loses
  everything and the next turn re-derives it from a stale TODO — which is what
  exhausts the budget, so it self-sustains. `runAgentTurn` reserves
  `WRAPUP_RESERVE_ROUNDS` past the cap **and replaces the toolset with
  `update_todo`/`update_memory` only** for those rounds. The tool restriction is
  the load-bearing part: an earlier version merely *asked* the model to persist
  and was measurably ignored. Restoration is in a `finally` — the turn has nine
  exit paths and `context` is reused. Covered by `tests/wrapup-reserve.test.ts`.
- **Timeouts are per-provider, not global.** `DEFAULT_LLM_TIMEOUT_MS` (90s) is a
  hosted-API figure. Local providers (`custom`/`ollama`/`lmstudio`) are bounded by
  local memory bandwidth and get `LOCAL_LLM_TIMEOUT_MS` (300s) instead. Sanity-check
  any timeout against `maxTokens / measured tok-per-s`: if the budget cannot fit the
  token allowance, the model is guaranteed to be killed mid-generation.
- **State the agent needs must be INJECTED, never left to re-derivation.** The
  execution prompt tells the agent not to re-query injected fields, so anything
  missing or stale is something it will guess at — confidently, every turn. Three
  instances in one day on Morg'Thar (2026-09-01): a stale `location` in the
  http_v2 cache put his prompt in `iron_reach` while he was at Glenhaven; an
  absent weapon loadout had him burn ~11 tool rounds guessing which of seven
  near-identical weapon ids to reload; and a wrong ammo fact in his directive had
  him hauling 89 boxes for the one gun that was already full while six guns ran
  dry. When an agent repeatedly re-queries the same thing, the missing briefing
  field is the bug — not the agent.
- **Enumerate the whole list before writing a fact into a directive.** The
  "your ammo is standard_rounds_box" line came from reading ONE
  `loaded_ammo_name` off a truncated `get_ship`. The ship had seven weapons and
  two ammo types. A directive fact is injected into every prompt and outranks
  what the game is telling the agent, so a wrong one is worse than none.
- **All local agents must share ONE model.** oMLX (the local MLX server) keeps a
  single model resident and swaps on demand, so two different local models across
  the fleet thrash: measured 2026-09-01, alternating gpt-oss-120b (59GB) and
  Qwen3.6-35B-A3B (35GB) on a 128GB box collapsed throughput from 73.5 tok/s to
  12.3 and then returned HTTP 400s once free memory hit ~285MB with 1.5GB swap in
  use. A local planner paired with a *hosted* executor is fine; two local models
  are not. Measured generation throughput, from oMLX's own `~/.oMLX/stats.json`
  over 1,489 production requests:
  gpt-oss-120b-MXFP4-Q8 **48.4 tok/s** · Muse-Glimmer-30B-4bit 29.8 ·
  Qwen3.8-27B-OptiQ-4bit 24.5 · Qwen3.8-27B-MLX-8bit 16.7. The largest model is
  the fastest because it is sparse MoE (5.1B active of 117B) — parameter count is
  not the speed predictor, active parameters are.
- **Qwen3.8 defaults to `reasoning_effort: xhigh`** in its chat template
  (`reasoning_effort|default('xhigh')`), which is why it burned whole timeouts
  thinking. Set it to `low` before judging that family on speed.
- **Cron schedules** are validated on create (`validateCronExpression`) — reject
  malformed expressions rather than storing ones that silently never fire.
- **Tables are pruned** periodically (`pruneOldData` in `index.ts`): logs, financial
  snapshots, and fleet intel have retention windows so they don't grow unbounded.

## SpaceMolt API v2 notes

- v2 groups commands as `spacemolt_{group}_{action}` (e.g. `spacemolt_market_view_market`).
- `http_v2` transparently falls back to a parallel v1 session for commands missing
  from the v2 route map, so all ~150 commands work regardless of v2 spec coverage.

## Prompt / token efficiency (read before touching prompts)

Full analysis and the staged plan: **`docs/PROMPT-ARCHITECTURE.md`**. Key facts a
future session must not re-derive or get wrong:

- **Prompt caching is already ON and working — 84.3% hit rate.** `@mariozechner/pi-ai`
  sets `cache_control` for us (system block + last user message), retention `"short"`
  (5-min TTL). There is nothing to "enable"; the Claude Console card is not a setting.
- **The fleet runs on the `claude-max` OAuth subscription**, so the metered API Console
  shows zero spend and zero token volume. That is expected, not a misconfiguration.
- **`systemPromptTokens` in `llm_call` logs is an ESTIMATE, not real tokens** —
  `CHARS_PER_TOKEN = 2` in `loop.ts`. Only `cacheRead`/`cacheWrite`/`input`/`output`
  come from the provider.
- **The cost lever is cache WRITES, not enabling caching.** `buildSystemPrompt`
  interpolates memory, todo, fleet orders, and a situational briefing that refreshes
  every 60s — all inside the cached prefix, so each one invalidates it. Moving those
  out is worth more than any size reduction.
- **Never bulk-delete directive sections without a mapping.** Deleting the
  `PROCUREMENT SIZING — HARD CAPS` block on 2026-08-06 cost 55,000 game credits within
  the hour. Relocate by volatility; delete only what is provably superseded.
- Pre-change baseline: `data/baselines/llm-usage-2026-08-06.json` (source log rows
  prune after 14 days).

## Verifying a change

1. `bun run build` (must succeed).
2. `./admiral`, then hit the relevant endpoint(s) under `http://127.0.0.1:3031/api/...`
   or drive the UI at `http://127.0.0.1:3031`.
3. For agent behavior, create/connect a profile and watch its log stream in the
   dashboard (or `GET /api/profiles/:id/logs?stream=true`).
4. Stop any test server and remove the throwaway `data/` dir when done.

## SpaceMolt information sources — check these BEFORE brute-forcing

The game exposes far more knowledge than the Admiral DB holds. Every source below has,
at least once, answered in minutes a question that agents were burning hours on. Check
them **before** dispatching a fleet-wide sweep, guessing a recipe, or declaring something
unobtainable.

**1. The in-game forums — free, and other players have already solved your problem.**
`forum_list` and `forum_get_thread` cost **no game tick**. 613 threads were searchable in
about six minutes (`scripts/`-style sweep: list every category page, then read bodies).
This is how we learned that adamantite exists in exactly one place and that the Deep Core
Extractor Mk I — a `quest_item` with no recipe and no seller — comes from a *repeatable*
20,000cr mission. Five agents scanning asteroid belts could never have found either.
**Search the forums first whenever something looks unobtainable.**

**2. The public market board — https://spacemolt.com/market**
A live, galaxy-wide order book across all five empires, with **real tradeable depth** in
parentheses (it excludes predatory 1cr lowball orders). Per-station boards live at
`/market/<station_id>` (e.g. `/market/starfall_salvage_station`). Reach it with the
Browser tools. This beats polling stations one at a time: it found adamantite_ore at
20,000 in Outer Rim when Grand Exchange wanted 30,000, and showed exotic_crystal was
*cheaper to buy than to craft*. Note the quantity column is the whole point — see the
`min(held, buy_qty)` rule below.

**3. The 13 in-game guides — `get_guide`, free.**
miner, trader, arbitrage, mission-runner, passenger-lines, pirate-hunter, explorer,
base-builder, crafting, packages, drones, fuel, client-dev. Reading them overturned three
standing fleet rulings at once (missions pay ~10x ore; bulk ore with no bid should be
listed with `create_sell_order`, not dumped; "sell into the best bid" is a documented
1-credit trap).

**4. The codex — `/api/codex/...` and the agents' `codex` tool.**
`/api/codex/ship/<id>` gives a ship's authoritative `build_materials` + `default_modules`;
`/api/codex/recipe/<id>` gives exact inputs; `/api/codex/item/<id>` gives `produced_by`,
`extracted_by`, rarity and `quest_item`. **`/api/codex/chain/<item>` is LOSSY** — it showed
`synthesize_neutronium` needing only weapons_grade_plutonium, silently dropping
durasteel_plate and power_core. Use `/api/codex/recipe/<id>` for anything you will act on.

**5. Two arithmetic rules that have each cost us real money.**
- Realisable value is **`min(held, buy_qty) × best_buy`**, never `price × holdings`. A
  surplus that looked like 1.13M realised 61,187.
- Resolve a requirement **to raw inputs before comparing stock**. Comparing a stock at one
  depth of the crafting tree against a requirement at another drops the multiplier and
  produces a confident wrong answer.

### Live data over HTTP — use this INSTEAD of tasking an agent

**Never spend an agent turn looking something up.** These are free, unauthenticated, and current:

```
https://game.spacemolt.com/api/market        live order book, 3,565 items, WITH BID DEPTH
https://game.spacemolt.com/api/catalog.json  every item/module/recipe/skill/ship/facility
https://game.spacemolt.com/api/stations      stations + empires
https://spacemolt.com/sitemap.md             index of every page; each page also serves .md
```

`/api/market` carries `best_bid`, `best_ask` **and** `bid_quantity_at_best` — the depth field.
`realisable = min(held, bid_quantity_at_best) x best_bid`, never `price x holdings`. A headline
bid has been observed 112 units deep on one item and 1 unit deep on another, so depth is never
safe to assume.

Admiral's local `fleet_intel_market` now records depth too (`best_buy_qty` / `best_sell_qty`),
captured from `view_market`. Use `realisableValue()` in `db.ts`, or `GET /api/fleet-intel/realisable`,
rather than multiplying price by holdings. **A row with NULL depth was written before depth capture
existed** — its value is still an unvalidated ceiling, and the briefings label it `(depth unknown)`.
This feed cannot backfill those rows: it aggregates per *empire*, while the table is per *station*.

`https://spacemolt.com/market` is a client-rendered SPA — fetching it returns only the page shell.
Use the `game.spacemolt.com` JSON for data and the `.md` suffix for prose docs.

Agents are for *acting* (buy, sell, craft, travel). Looking things up is free over HTTP.

**Agents cannot fetch HTTP.** Their tool set is `game`, `mine_until_full`, `goto_system`,
`sell_cargo`, `codex`, `codex_chain`, memory/todo/status/fleet-order — no web access. The
endpoints above are for the Admiral to read and *relay*. In-game, agents have
`analyze_market()` (scales with trading skill), `faction_query_trade_intel()` (cross-station
price database; item_id lookup at L2), and `faction_trade_intel_status()`.

`view_market` only shows the station you are docked at, and prices differ enormously **by
empire** — nickel_ore asked 500 in crimson versus 33 in nebula on the same day. Relay a
cross-empire sheet rather than letting agents price locally.


### Ship and loadout decisions — run the script, do not reason from memory

**`bun scripts/ship-match.ts <agent>`** ranks hulls for a specific agent against their real skill
sheet, the live catalog, and fleet stock. **`bun scripts/ship-match.ts <agent> <hull_id>`** prints
a full bill of materials showing what the fleet already holds versus what must be bought, with
market ask depth per line.

Read **[docs/ship-doctrine.md](docs/ship-doctrine.md)** before any ship, module or hauling
decision. The short version:

- **Cargo capacity alone is never the criterion.** `congregation` holds 1,900 and has zero
  utility/weapon/defense slots — it can never mount a mining laser or a shield.
- **A slot you cannot power is not a slot.** Mining Laser III is 6 CPU / 12 power; multiply
  against `cpu_capacity` and `power_capacity` before trusting a slot count.
- **Read `inherent_capabilities`.** `ore_cargo_efficiency: 50` halves ore's cargo cost;
  `ore_yield_bonus` multiplies every extraction. This is why a purpose-built Miner beats a
  larger generic hauler.
- **Match hull to the agent's skills, not their job title.** Check the skill sheet.
- **Price it before calling it impossible.** Half a bill of materials is usually already in
  `storage_inventory`, and a 400-cargo freighter has sold for 7,376 credits.
- **Read ask DEPTH, not the headline ask** — `engine_core` quotes 7,148 at a depth of two.
- **Fit the ship before flying it.** Both haulers the fleet lost were undefended.

This exists because the fleet concluded "we have no hauler, this is impossible" three times in one
day while a cheap freighter sat on the market, and flew a mining_power-5 laser for weeks when
mining_power-22 fits the same slot.

### Before writing any directive — run plan-check

**`bun scripts/plan-check.ts <agent> [--to <system>] <item:qty> ...`**

Answers the questions that produced most of this project's wrong directives: does this agent
hold it, AT WHICH STATION, how many jumps from where they actually are, will it fit in the hold,
is it a commission line, and what is the live price *with depth*. It exits noisy when the market
cache is stale, because depth moves within minutes.

The agent-side companion is **[docs/agent-verification-protocol.md](docs/agent-verification-protocol.md)** —
each agent runs their own six checks and publishes verified findings to faction chat so nobody
pays twice for the same lookup.

**The failure mode both exist to stop:** asserting a fact about a place you are not standing in.
One session produced ~15 corrections; almost all were that shape — summing per-station storage
fleet-wide, quoting a bid without its depth, planning a "quick handoff" 25 jumps away, or reading
a cached snapshot instead of the live result. The checks that were made mechanical have produced
none since. The ones left to discipline kept failing.

### Changing an agent's behaviour — pick the mechanism, don't default to nudging

There are five ways to alter what an agent does. Three are silent; two interrupt. **Match the
mechanism to the agent's state**, because interruption cost scales with how mobile they are.

| mechanism | effect | use when |
|---|---|---|
| `POST /:id/nudge` | **restarts the turn**; agent re-plans | one transient fact, agent is DOCKED |
| `PUT /:id {directive}` | **restarts the turn**; rewrites standing orders | policy change, agent is DOCKED |
| `PUT /:id {todo}` | silent — but **the agent will overwrite it** | seeding a plan they then own |
| `PUT /:id {memory}` | silent — **agent-owned, they rewrite it** | facts worth surviving, expect edits |
| disconnect → `PUT` → `connect_llm` | clean boot on the new state | agent is MID-ROUTE or oscillating |

**Only `directive` triggers `restartTurn()`.** But `todo` and `memory` are AGENT-OWNED — they have
`update_todo`/`update_memory` and will overwrite you. One rewritten TODO was replaced by the agent
**40 seconds** after restart, and the replacement cancelled the job it contained, because she was
correctly obeying a **stale directive**. Agents apply `directive > todo > memory`, which is right.
**Put the actual order in the directive or it will not stick.**

**Measured cost of getting this wrong (2026-08-20):** both agents received nine interruptions in
two hours. Morg was docked throughout — 17 transactions, 51,316 credits. Nova was mid-route every
time — she re-derived a destination on each restart, changed target eight times in 90 minutes,
arrived nowhere, and managed 6 transactions for 14,600. Same interruptions, wildly different cost.

The stop-rewrite-start sequence fixed it in one pass: disconnect, rewrite `todo` and `memory`
directly, reconnect. She booted on the new plan with no mid-flight re-derivation and immediately
sold 100 trade_cipher at the full 504 wall — the same item she had sold at 150 two hours earlier.

**Before writing another nudge, ask: is this transient or structural, and is the agent moving?**
A long persuasive message to a travelling agent is the worst combination — it interrupts the
journey to deliver something that belonged in state they read on boot.

### First thing every session — check who is waiting on you

```bash
bun scripts/needs-admiral.ts --catchup   # what came in while nobody was watching
bun scripts/needs-admiral.ts             # then leave running as a Monitor
bun scripts/needs-admiral.ts --ack       # after you have acted on the backlog
```

Detection persists to `data/needs-admiral.jsonl` and the read cursor to `data/needs-admiral.ack`,
so **the backlog survives a session restart, a server restart and a reboot.** Watch mode is
session-scoped by nature — nothing can notify a Claude session that does not exist — so `--catchup`
is the part that matters: run it before anything else.

It filters, in order: relayed third-party MAYDAY traffic, routine "check passed / batch
progressing" status, and `NEED: <AgentName>` peer-to-peer requests. What survives is an agent that
is genuinely stopped and waiting on the Admiral.

**Why it is narrow:** a previous monitor fired on every `HALT` and was switched off as noise, after
which an agent sat blocked for eight minutes with nobody watching. A watcher that cries wolf gets
turned off, which is strictly worse than no watcher — so bias the filters toward silence.
