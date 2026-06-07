# Admiral / SpaceMolt Fleet — Session Handoff & Context Memory

> Purpose: complete context so a new chat session can resume managing the SpaceMolt fleet
> without re-deriving everything. Last updated end of session ~2026-06-07.

---

## 1. What this is

- **Admiral** = a local web app (Bun + Hono backend, React frontend) that manages **SpaceMolt**,
  an MMO played by autonomous AI agents. Repo: `Brainstem2000/admiral` (cloned here, on `main`).
- We run **6 AI agents** that play SpaceMolt. We steer them by editing their **directive / TODO /
  memory** and sending **nudges**, and we monitor them via the Admiral API + the SQLite log DB.

## 2. Environment & how to operate

- **Project dir:** `E:\BWC-Labs-OneDrive\OneDrive - BWC Labs\Claude-Code-Projects\admiral`
- **Runtime:** Bun at `~/.bun/bin/bun` (NOT node/npm). `gh` CLI installed. Authed GitHub: Brainstem2000.
- **Dev server:** backend on **:3031**, Vite UI on **:3030**. Start with `bun run dev`.
  (Currently running as a standalone backend on :3031 + standalone Vite on :3030 because Vite
  crashed once — `STATUS_STACK_BUFFER_OVERRUN`, a OneDrive-folder file-watch quirk.)
- **PATH note:** `bun` and `gh` aren't on the default PATH for spawned shells; prepend in PowerShell:
  `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")`
- **DB (read-only for queries):** `data/admiral.db` (bun:sqlite, WAL). Key tables: `profiles`,
  `log_entries` (profile_id, timestamp, type, summary, detail), `financial_snapshots`,
  `fleet_intel_market/systems/threats`, `fleet_orders`, `preferences` (incl. cached OpenAPI spec).
- **Directive library (canonical .md):** `E:\BWC-Labs-OneDrive\OneDrive - BWC Labs\Claude-Code-Projects\spacemolt\DirectivesForPlayers\`
  — mirror of the live DB directives. DB is the live source of truth; keep `.md` in sync (overwrite
  `.md` from DB when they drift). Backups of every edit are kept as `*-pre-<change>.md`.
  TODOs and memory are runtime (DB only) and are NOT mirrored to `.md`.

### Operating the agents (HTTP API on http://127.0.0.1:3031)
- `GET /api/profiles` — list agents (id, name, connected, running, activity, model, planner_model).
- `GET /api/profiles/:id` — full profile incl. `directive`, `todo`, `memory`.
- `PUT /api/profiles/:id` `{directive|todo|memory|model|planner_model}` — edit. Changing `directive`
  triggers a turn-restart (re-read). Changing `model`/`planner_model` needs a **loop restart** to
  take effect (model is resolved at loop start), i.e. disconnect + connect_llm.
- `POST /api/profiles/:id/connect` `{action: "connect_llm" | "disconnect"}` — start/stop the LLM loop.
- `POST /api/profiles/:id/command` `{command, args, silent:true}` — run a game command directly via
  the agent's connection (e.g. get_status, view_orders, send_gift). Collides with the running loop →
  retry on error message containing "another action is already in progress".
- `POST /api/profiles/:id/nudge` `{message}` — inject a one-off instruction (agent must be running).
- Common pattern: a `bun -e` script that calls the command/profiles endpoints AND reads `log_entries`
  from the DB for activity/cost analysis. Watch for curly apostrophe in "Morg'Thar" when matching by name — match by id or substring.

## 3. Code changes made this session (all committed + pushed to `main`)

1. **Newest Claude models** in the model picker (`src/server/routes/models.ts`, `lib/model.ts`):
   added `claude-opus-4-8`/`4-7`; unknown ids clone the highest-maxTokens template.
2. **`db.ts`** — tolerate `EEXIST` from `mkdirSync` (Bun/Windows/OneDrive bug crashed every boot after first).
3. **`agent.ts` + `agent-manager.ts`** — fixed silent agent-loop failure: `running` flag left true on
   early throw (zombie), and `.catch(()=>…)` swallowed the real error. Now logs the cause and resumes.
4. **`tools.ts` — THE BIG ONE (commit `e25fbbd`):** the arg auto-correct was renaming `target_id` → `id`
   for scan/attack based on a stale assumption; the current game API wants `target_id`, so **all combat
   was impossible** and the agent was gaslit into thinking it typed the wrong key. Reversed it to
   normalize id/target → `target_id`. Verified live (a real battle started).
5. **`tools.ts` + `briefing.ts` (commit `5fa195b`):** fixed stale-location bug. Agents acted on the wrong
   system after rapid jumps because the situational-briefing cache intercepted their explicit
   get_status/get_nearby/get_location/get_ship calls AND let out-of-order async refreshes write old
   locations. Now those reality-verification queries always hit live state, and a per-agent epoch
   discards stale in-flight refreshes. **NOTE: live backend must be restarted to pick up any code change.**
6. **`tools.ts` + `briefing.ts` (cache complaints, finished):** `5fa195b` only freed status/nearby/
   location/ship — it LEFT `get_system`, `get_active_missions`, `get_cargo` intercepted, so agents still
   got a lossy/stale briefing snapshot on those explicit calls (Morg couldn't see `get_system` POI
   ids/types → couldn't find pirate belts → looped "force a fresh query"; CyberSapper saw an old system
   after a jump). Fix: **emptied the briefing intercept entirely — ALL explicit query calls now hit live
   state**; the briefing stays a 0-token *passive* prompt injection only. Also fixed the briefing's
   location/docked parsing: real `get_status` is `{player,ship,modules}` with NO `location` object and NO
   `docked` flag (location is `player.current_system`/`current_poi`), so the old code always rendered
   `Location: ?` / `IN SPACE`. Added `readLocation()` + `isAgentDocked()` helpers (station-suffix
   inference) — locations now render correctly for every agent. Verified: 0 `(cached)` in last 100 tool
   results; live get_system/get_active_missions; correct location lines. **IMPORTANT: run as the compiled
   `admiral.exe` binary, NOT `bun run dev` — the dev process keeps dying overnight in the OneDrive folder
   (3× this session). The binary has no file-watcher and survives. Real fix: move repo off OneDrive.**

## 4. The 6 agents — roles, models, state (FINAL)

| Agent | id (prefix) | Role | Executor | Planner |
|---|---|---|---|---|
| **CyberSapper** | f6b7b342 | **Supplier / trader / miner** (richest ~5.3M; officially reassigned — he's best at mining/supply) | haiku-4-5 | sonnet-4-6 |
| **Bob Comet** | d9bf6343 | **Smuggler** (trade/hauling missions + high-value sells). Smuggling L3, progressing | haiku-4-5 | sonnet-4-6 |
| **Nova Reyes** | 377a51c2 | **Faction leader** — "lead by doing", NO mining campaign | haiku-4-5 | sonnet-4-6 |
| **Morg'Thar** | a9e3b41a | **Combat / pirate-hunter** (Crimson). Upgraded executor for real-time combat | **sonnet-4-6** | sonnet-4-6 |
| **CyberSpock** | (query) | Smuggler / trader. Often idle/stuck — may need diagnosis | haiku-4-5 | sonnet-4-6 |
| **Ledger Voss** | (query) | **CPA + mining** (designated miner) | haiku-4-5 | sonnet-4-6 |

All are in one faction: **Stellar Alliance (STLR)**, faction_id `fd6310fbe39520866a0e5338391eb04a`
(home empires differ: outerrim/solarian/nebula/crimson). Shared faction **vault ~3.85M**.

## 5. Key game mechanics learned (IMPORTANT — agents get these wrong)

- **Credits live ONLY in the wallet.** Per-station personal credit storage was removed (v0.222.0).
  Personal `view_storage` holds ITEMS + gifts, not loose credits.
- **Faction vault** = global treasury. `view_faction_storage` (must be docked at a base w/ storage),
  `faction_deposit_credits` (anyone), `faction_withdraw_credits` (needs manage_treasury perm).
- **Gifts** = the player-to-player credit transfer: `send_gift(recipient=<player_id/username>, credits=N)`.
  Lands as a claimable gift at a station; recipient claims via `view_storage`.
- **Buy orders** lock credits in **escrow**; `cancel_order` returns them to wallet. Sell orders don't.
- **Smuggling XP comes from SELLING goods** (~**1 XP per ~100 credits of sale value**), scales with
  sale value. It does **NOT** come from the pirate-rep-gated "smuggling mission" chain (that chain is
  bug-blocked: pirate rep stuck at -30; petition filed). Liquid Hydrogen sells are proven (~100 XP/sale).
  Trade/hauling/delivery contracts ARE smuggling work — there is no mission literally labeled "smuggling".
- **Combat:** `attack(target_id=<player_id>)` starts a battle (returns `battle_id`); then the **`battle`**
  command each tick (`action: advance|fire|stance ...`); `loot_wreck` after a kill. You can only attack
  **ONLINE** targets in your **current system**. **Weapons need AMMO** (armor_piercing_rounds etc.) —
  ships fire for ZERO damage with empty magazines (this is why Morg kept losing). `get_ship` to check.
- **NPC pirate scarcity (the real combat blocker):** NPC pirates are very scarce / possibly disabled
  in the current version. They spawn (if at all) at **asteroid belts / ice fields in unpoliced space**
  (NOT planets/stars/fuel-depots), possibly time-gated (~30 min in zone) or mining-triggered. Online
  players are often AFK-protected/invulnerable. Reliable combat = **faction fleet battles** (e.g. Misthollow).
- **Ships:** `catalog(type=ships, tier=N)`. Combat picks: Casting Vote / Hell's Bells (cruisers ~32k),
  Warmaul (Crimson, commissioned ~350k+materials), Annihilator (Crimson dreadnought ~600k, 9 guns,
  faction bonus — endgame). `commission_status` → `claim_commission` when "ready" (builds take hours).
- **Pirate-hunter guide:** `get_guide(guide="pirate-hunter")` — authoritative combat progression.
  Bounty missions (get_missions) give targets+rewards: single 2k, sweep-3 5k, medium 6-8k, elite-3 15k+.

## 6. Fleet policy & governance (CURRENT)

- **Credit policy = WALLET-FIRST:** everyone keeps credits in their OWN wallet; deposit to the vault
  ONLY when Nova Reyes or Ledger Voss explicitly asks. Nova & Ledger have "treasury authority" to request deposits.
- **Balance Reconciliation Sweep** (all agents, every station): `view_storage` to claim gifts,
  `cancel_order` on stale buy orders to free escrow, `claim_commission` for finished ships, `get_notifications`.
- **Role discipline / anti-mining:** Morg and Bob are FORBIDDEN to mine (a top-of-directive rule that
  tells them to delete any mining TODO they write). CyberSapper & Ledger are the designated miners/suppliers.
  Nova must NOT launch mining campaigns or conscript specialists ("no mining campaign — cancelled").
- **Why this exists:** agents kept drifting back to mining (it's productive) and **self-rewrite their own
  TODOs** (overwriting our edits within a session). The durable fix is **directive rules** (they survive
  self-rewrites), not TODO edits or nudges (which wash out).

## 7. Model strategy (the principle)

- **Loop-based roles** (mining, smuggling, trading, supply, hauling) → **Haiku executor** is correct:
  repeatable work, executes fine, cheap. Don't upgrade them.
- **Combat (Morg)** → **Sonnet executor** — the ONE role needing real-time tactical reasoning. Haiku
  produced empty-gun charges, constant fleeing, and a panic self-destruct. Sonnet now reasons (loads
  ammo, picks target-rich systems, manages fuel) — but kills are still blocked by content scarcity.
- **Planners** → all on **Sonnet** (removed wasteful Opus planners on CyberSpock/Ledger/Nova).
- Opus is reserved for nothing right now; bump a planner to Opus only if strategic complexity demands it.

## 8. Persistent problems to watch

- **Chronic over-jumping / roaming** (movement waste) across all agents — biggest efficiency leak.
- **TODO self-rewrites** — agents overwrite our TODO edits; rely on directive rules for durability.
- **Mining reversion** — solved by reassigning CyberSapper as supplier + anti-mine directive for Morg/Bob.
- **Morg combat = content-blocked.** Even with Sonnet + ammo checklist, NPC targets are scarce.

## 9. State at session end & open items

- **Morg:** lost the Warmaul (Haiku-era self-destruct); **commissioning a "Broadaxe"** (Crimson warship,
  ~33 min build); flying a free Shard meanwhile; executor now Sonnet; directive fully rewritten with a
  **MANDATORY PRE-COMBAT CHECKLIST (load ammo!)**. Lifetime kills 10 pirates / 1 ship; no new kills (content).
  **Kill watcher running** (background task, 55-min window) — if still 0 kills after Broadaxe + a proper
  hunt, conclude it's game content: commit him to **faction PvP wars** or drop him back to Haiku to stop overpaying.
- **Bob:** smuggling working (L2→L3), 0 mining; just told trade/hauling contracts ARE smuggling work
  (was abandoning missions hunting for a "smuggling" label). Watch he doesn't churn/roam.
- **CyberSapper:** productive supplier (~5.3M); accept the mining (officially his role now).
- **CyberSpock:** frequently idle/0 actions — diagnose why if you want him active.
- **Directive `.md` library:** fully synced to DB as of session end.

## 10. Quick-resume checklist

1. Confirm dev server up: `GET http://127.0.0.1:3031/api/profiles` returns 200.
2. `GET /api/profiles` → who's connected/running + current models.
3. Per agent: `POST /command {command:"get_status",silent:true}` for wallet/skills/stats; read
   `log_entries` (DB) for recent tool_call frequency to see what they're actually doing.
4. Edit behavior via `PUT /api/profiles/:id {directive|todo|memory}`; nudge via `/nudge`.
5. After directive edits, sync the matching `.md` (DB → file) and keep `*-pre-*.md` backups.
6. Model changes need disconnect + connect_llm to apply.
