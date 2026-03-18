# Admiral API Audit (Re-baselined)

Date: 2026-03-18  
Scope: Runtime connections, command discovery, agent prompt command surfacing, and frontend command metadata.

This file replaces older findings that were already fixed in code.

## Executive Summary

- HTTP v1: Healthy. Core session/auth/command flow works.
- HTTP v2: Healthy with robust v1 fallback and dynamic route mapping.
- WebSocket: Healthy and protocol-aligned.
- MCP v1/v2: Healthy, with known polling overhead tradeoff.
- Commands API route: Version-aware and cache-keyed by version.

Most prior critical items are now resolved. Remaining issues are quality/usability, not release blockers.

## Resolved Since Prior Audit

1. `retry_after` handling is implemented for rate limiting in both HTTP connectors.
2. Command catalog route is no longer hardcoded to v1; it now supports `api_version`.
3. OpenAPI fetch path selection uses versioned URL first (`/api/v2/openapi.json`), then fallback.
4. HTTP v1 login `player_id` extraction no longer assumes `result.player_id`; it reads nested player data.
5. MCP session expiry recovery is implemented (reinitialize and retry once).
6. Push-vs-poll behavior is explicit via `supportsNotifications()`.

## Current Status by Area

### HTTP v1 (`src/server/lib/connections/http.ts`)

Status: Stable

- Session creation/reconnect logic is present.
- Notification fanout from envelope is present.
- Rate-limit retry uses `retry_after`.

Residual notes:
- `disconnect()` is local-state only (no explicit `/logout`). This is acceptable for current server semantics.

### HTTP v2 (`src/server/lib/connections/http_v2.ts`)

Status: Stable

- Builds route map from v2 OpenAPI and supports action/tool aliases.
- Uses `structuredContent` when available.
- Falls back to v1 per-command when missing from v2 map.
- Rate-limit retry uses `retry_after`.

Residual notes:
- Idle notifications are only seen when commands run (no standalone `/notifications` polling in HTTP mode).

### WebSocket (`src/server/lib/connections/websocket.ts`)

Status: Stable

- Uses native WS `{type, payload}` model.
- Notifications are push-driven.
- No significant conformance issues found.

### MCP v1 (`src/server/lib/connections/mcp.ts`)

Status: Stable

- Initialize + initialized handshake implemented.
- Session-expiry recovery implemented.
- Notification polling after command is implemented.

Residual notes:
- Notification polling is cadence-throttled (not per-command), but still polling-based.

### MCP v2 (`src/server/lib/connections/mcp_v2.ts`)

Status: Stable

- Tool discovery (`tools/list`) and action-to-tool routing implemented.
- Session-expiry recovery implemented.
- Returns both parsed and structured content paths.

Residual notes:
- Notification polling is cadence-throttled (not per-command), but still polling-based.

## Remaining Actionable Issues

No critical or high-severity API conformance gaps are currently open in this scope.

Minor follow-ups are now mostly optimization-oriented (for example, reducing notification polling overhead on MCP paths).

## Recently Completed

1. Added v2-aware mutation fallback heuristics in `schema.ts` when `x-is-mutation` metadata is absent.
2. Added explicit active connection mode/API protocol context in the agent system prompt.
3. Consolidated command catalog interfaces (`GameCommandInfo`, `GameCommandParam`) into shared types and removed frontend duplication.
4. Improved MCP v2 unknown-command handling with local validation and suggested command names.
5. Reduced MCP v1/v2 notification polling overhead via minimum-interval throttling.

## Non-Issues (Confirmed)

1. Quick command names like `view_market` and `captains_log_list` are still routable in v2 through mapping/translation layers.
2. v1-style parameter names remain broadly usable in v2 due to translation/passthrough behavior.
3. WebSocket does not need REST-style envelope fields (`session`, `notifications`) to be conformant.

## Recommended Next Pass

1. Consider replacing heuristic v2 mutation classification with a server-sourced action/query map if gameserver exposes one.
2. If gameplay responsiveness needs it, tune MCP polling interval adaptively by connection load.
