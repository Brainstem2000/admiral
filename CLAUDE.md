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
- **Cron schedules** are validated on create (`validateCronExpression`) — reject
  malformed expressions rather than storing ones that silently never fire.
- **Tables are pruned** periodically (`pruneOldData` in `index.ts`): logs, financial
  snapshots, and fleet intel have retention windows so they don't grow unbounded.

## SpaceMolt API v2 notes

- v2 groups commands as `spacemolt_{group}_{action}` (e.g. `spacemolt_market_view_market`).
- `http_v2` transparently falls back to a parallel v1 session for commands missing
  from the v2 route map, so all ~150 commands work regardless of v2 spec coverage.

## Verifying a change

1. `bun run build` (must succeed).
2. `./admiral`, then hit the relevant endpoint(s) under `http://127.0.0.1:3031/api/...`
   or drive the UI at `http://127.0.0.1:3031`.
3. For agent behavior, create/connect a profile and watch its log stream in the
   dashboard (or `GET /api/profiles/:id/logs?stream=true`).
4. Stop any test server and remove the throwaway `data/` dir when done.
