# Admiral — CoPilot Project Instructions

## What This Is
Admiral is a web-based AI agent manager for SpaceMolt (an MMO played by AI agents). It runs multiple autonomous game-playing agents simultaneously, each with their own LLM loop, game connection, and log stream.

## Tech Stack
- **Runtime:** Bun (NOT Node.js) — use `bun` for all commands
- **Backend:** Hono (lightweight web framework), TypeScript, SQLite (via `bun:sqlite`)
- **Frontend:** React 19, Vite 6, TailwindCSS 4, Lucide icons
- **Build:** `bun run build` compiles to a standalone `admiral.exe` binary via `bun build --compile`
- **Dev:** `bun run dev` runs backend (port 3031) + Vite (port 3030) via concurrently
- **Package manager:** bun (NOT npm/yarn)

## Architecture

### Backend (`src/server/`)
- **`lib/agent.ts`** — Core `Agent` class. Manages connection lifecycle, LLM loop (`while (this.running)`), system prompt building, game state caching, nudge injection. The agent loop is the heart of the system.
- **`lib/loop.ts`** — `runAgentTurn()` — single LLM turn execution with tool calling, context compaction, retry logic. Uses `@mariozechner/pi-ai` for LLM calls.
- **`lib/tools.ts`** — Tool execution: local tools (read_todo, update_memory, etc.) and game commands (via connection). Has cooldown system, query vs action classification, briefing cache intercept, auto-parameter correction.
- **`lib/agent-manager.ts`** — Singleton managing all Agent instances. Handles connect/disconnect/restart, backoff, safe dock, status reporting.
- **`lib/briefing.ts`** — Background data collector (60s interval) that caches game state and builds a text briefing injected into system prompts at zero LLM token cost.
- **`lib/fleet-intel.ts`** — Passive intel collector that parses command results across all agents for shared market/threat data.
- **`lib/schema.ts`** — Fetches and parses the SpaceMolt OpenAPI spec, formats command signatures for system prompts.
- **`lib/connections/`** — Game connection implementations: `http.ts`, `http_v2.ts`, `websocket.ts`, `mcp.ts`, `mcp_v2.ts`. All implement `GameConnection` interface.
- **`lib/db.ts`** — SQLite database layer. Profiles, logs, preferences, financial snapshots, fleet orders, fleet intel.
- **`lib/model.ts`** — LLM model resolution and API key management. Supports Anthropic, OpenAI, Google, Bedrock, OpenRouter, Ollama, etc.
- **`routes/`** — Hono route handlers: `profiles.ts` (CRUD, connect, nudge, safe-dock), `analytics.ts` (timeline, tokens, financial), `logs.ts` (SSE streaming).

### Frontend (`src/frontend/`)
- **`components/ProfileView.tsx`** — Main agent view: status bar, log stream, side pane (memory/todo/status), command panel, quick commands.
- **`components/AnalyticsPane.tsx`** — Fleet analytics: timeline, comms, financial charts, token economics.
- **`components/Dashboard.tsx`** — Top-level layout, polling loop (5s), agent sidebar.

### Shared (`src/shared/`)
- **`types.ts`** — Shared TypeScript interfaces (Profile, LogEntry, etc.)

## Critical Patterns

### Dual-Model Planner/Executor
Agents can use two models: a powerful planner (e.g., Opus) runs every N turns to set strategy via TODO, and a fast executor (e.g., Haiku) runs the other turns to take actions. Planning turns are capped at 10 tool rounds, executor turns at 30.

### Game State
- Raw `gameState` from `get_status` has nested structure: `{ player: { credits, docked, ... }, ship: { ... }, location: { docked_at, ... } }`
- `slimGameState()` in `agent-manager.ts` flattens this for the API/frontend
- `cacheGameState()` in `agent.ts` only fires on `get_status` responses (checks for `player`/`ship`/`location` keys)
- Docked detection: check `location.docked_at` (truthy = docked), with fallbacks to `player.docked` / `player.is_docked`

### SpaceMolt API v2
- Commands are grouped: `spacemolt_{tool_group}_{action}` (e.g., `spacemolt_market_view_market`)
- Tool groups: `market_`, `storage_`, `social_`, `intel_`, `faction_`, `faction_admin_`, `salvage_`, `catalog_`, `ship_`, `battle_`, `transfer_`, `facility_`, `auth_`
- Query commands are free (no game tick cost), action commands cost 1 tick (~10s)
- The `QUERY_COMMANDS` set in `tools.ts` has 3-layer detection: full name, bare name, deep-bare name

### System Prompt Caching
The system prompt is expensive to rebuild. It's cached and only regenerated when memory, directive, phase, or briefing content actually changes. Do NOT add `briefingEnabled` to the cache invalidation condition with `||` — this defeats the cache.

### Context Compaction
When messages exceed the budget (fraction of context window MINUS system prompt tokens), older messages are summarized. The budget must be calculated as `(contextWindow - systemPromptTokens) * ratio`, NOT `contextWindow * ratio`.

### Feature Flags
Stored in SQLite `preferences` table. Key ones:
- `situational_briefing` — set to `'off'` to disable briefing injection
- `max_turns`, `max_session_hours`, `llm_timeout`

## Common Pitfalls (Lessons Learned)

1. **Don't add `game()` to the Local Tools section** of the system prompt — it's a game command wrapper, not a local tool. Agents get confused.
2. **Don't remove command descriptions** from `formatCommandSignature()` — agents need them to know what commands do without wasting a turn calling `help`.
3. **Don't include system prompt tokens in the compaction comparison** without adjusting the budget to exclude them — causes compaction every single turn.
4. **Don't use `briefingEnabled ||` in the prompt cache condition** — it rebuilds every turn. Track briefing content changes instead.
5. **Fleet order injection must be capped** — uncapped orders can cause 200k+ token prompts. Currently capped at 10 most recent, descriptions truncated to 200 chars.
6. **`admiral.exe` locks on Windows** — must `Stop-Process` before rebuilding, or build will fail with EPERM.
7. **Background tasks need `stopRequested`** — when stopping an agent, add profileId to `stopRequested` set to prevent auto-restart via backoff.

## Testing
No test suite currently exists. Verify changes by:
1. `bun run build` (must succeed)
2. Start `admiral.exe`, connect agents via batch connect API
3. Watch agent logs for errors in the dashboard
4. Check financial snapshots, token analytics work

## Current Fleet (STLR Faction)
6 agents: Nova Reyes (leader), Ledger Voss (CFO), CyberSpock, CyberSapper, Morg'Thar, Bob Comet. All use `http_v2` connections with dual-model (Opus planner / Haiku executor).
