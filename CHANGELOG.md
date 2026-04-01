# Changelog

All notable changes to Admiral are documented here.

## [0.3.11] - 2026-04-01

### Fixed
- **Immediate briefing refresh after actions** -- After action commands (dock, jump, buy, etc.), the briefing cache now triggers an async background refresh immediately instead of waiting up to 60s. Eliminates "cache is stale" / "cache is serving old data" complaints from agents who just changed state.
- **Prominent docked state in briefing** -- Briefing now leads with `** STATUS: DOCKED at <poi> **` or `** STATUS: IN SPACE (not docked — cannot trade/market/storage/missions) **`. Reduces planners queuing docked-only actions while in space (was causing 6+ `no_base` errors per 30min for Nova Reyes).
- **Extended parameter auto-correction** -- Added `target`→`target_system` for jump/find_route, `target_poi`→`target_system` for jump, `search`/`item`→`item_id` for view_market, `item_id`/`item`→`search` for analyze_market. Eliminates ~10 more wasted API calls per session.
- **Chat channel name correction** -- Auto-remaps invalid channel names (`global`/`general`/`local`→`system`, `trade`→`trading`) to eliminate `invalid_channel` errors across 3 agents.

### Added
- **Fleet map improvements** -- System name labels (always-on for hubs and agent locations, hover for others). Agent status indicators with docked anchor icon, mini hull/fuel/cargo health bars, and OFF badge. Movement heading cones showing travel direction.
- **Log analysis script** -- `scripts/analyze-logs.ts` for quick fleet diagnostics (agent activity, tool call frequency, error patterns, cache complaints, token usage).
- **GitHub Copilot instructions** -- `.github/copilot-instructions.md` with full project architecture, conventions, and common patterns for AI-assisted development.

## [0.3.10] - 2026-03-26

### Fixed
- **Server hang / 23GB memory leak** -- `getTokenAnalytics()` loaded ALL 73,900+ llm_call log entries (with JSON detail blobs) into memory on every `/tokens` and `/roi` request. With a 15GB database this consumed 23GB RAM and deadlocked the event loop. Now defaults to last 24h with a 10,000 row cap. Analytics tabs load instantly.
- **ROI endpoint crash** -- `/api/analytics/roi` referenced removed `parseStorageCreditsFromMemory()` function (deleted in v0.3.7). Now uses wallet-only totals matching v0.222.0 credit model.
- **Stale cache after actions** -- Briefing cache AND market query cache now invalidate after any action command. Catalog cache (static data) preserved. Eliminates "Cache is serving old data" complaints.
- **Log filter persistence across profile switches** -- Log type filters now persist when switching between agents via localStorage.
- **Extended auto-correction for common param mistakes** -- Added corrections for: `find_route` (destination/text→target_system), `travel` (target→target_poi), `search_systems` (text→query), `catalog` (category→type, singular→plural, default type=items). Redirects deprecated `get_ships` to `browse_ships`. Eliminates ~15 wasted API calls per session across the fleet.

## [0.3.9] - 2026-03-23

### Added
- **Safe Dock & Disconnect button** -- New per-agent "Safe Dock" button (orange anchor icon) in the dashboard. One click sends an urgent dock nudge, then auto-disconnects the agent after it docks. No more racing to manually disconnect before the loop resumes. Detects docked state via `location.docked_at` from structured game state. Sets `stopRequested` to prevent auto-restart.

### Fixed
- **Fleet orders capping** -- Pending fleet orders injected into system prompts are now capped at 10 (most recent) with descriptions truncated to 200 chars. Prevents prompt overflow that was causing 213k+ token prompts when orders accumulated.
- **Removed debug snapshot logging** -- Cleaned up `[Snapshot]` console.log statements from `takeFinancialSnapshots()`.

## [0.3.8] - 2026-03-17

### Added
- **Situational Briefing System** -- Background data collector queries game state (status, cargo, nearby, system, missions, market) every 60s using direct connection calls (zero LLM tokens). Builds a compact text briefing injected into the agent's system prompt so planners/executors already know their situation without spending turns on query commands. Estimated 40-60% reduction in planning token usage. Kill switch: Settings > "Sit. briefing" checkbox, or `PUT /api/preferences` with `{"key": "situational_briefing", "value": "off"}`. Enabled by default.

## [0.3.7] - 2026-03-13

### Added
- **New agent: Ledger Voss** -- Fleet CFO and financial adviser for STLR faction. Solarian Confederacy empire. Dual-model (Opus planner / Haiku executor). Tracks fleet finances, analyzes arbitrage, advises Nova Reyes, and trades for profit when idle. Promoted to officer with manage_treasury permissions.

### Fixed
- **Query commands wrongly hitting action cooldown on MCP v2** -- `QUERY_COMMANDS` had v1 bare names (`view_market`, `view_storage`, `captains_log_get`) but MCP v2 sends grouped names (`market_view_market`, `storage_view`, `social_captains_log_get`). The `spacemolt_` prefix strip wasn't enough. Added all v2 grouped names to the set, plus a deep-strip of v2 tool group prefixes, plus a heuristic fallback (`get_*`, `view_*`, `list_*`, etc. = query). Eliminated ~40 false cooldown blocks per session across fleet.
- **Auto-correct common parameter mistakes** -- Agents frequently use wrong param names (`destination` or `target_system` for `travel`, `destination` for `jump`). Now auto-remaps before sending to the game server, preventing wasted API calls and error responses.
- **Fleet Wealth Over Time graph never updating** -- `takeFinancialSnapshots()` read `gameState.player.credits` but gameState stores credits at the top level (`gameState.credits`). Wallet was always 0, so no snapshots were ever recorded. Frontend now also refreshes snapshot data every 5 minutes instead of only on page load.

### Changed
- **Financial dashboard: removed storage credits** -- SpaceMolt v0.222.0 moved all credits to the wallet (per-station storage credits abolished). Fleet Net Worth now equals sum of wallets. Removed `parseStorageCreditsFromMemory()`, "Storage: X" display, and storage column from snapshots. Historical snapshots with storage data still render correctly (included in `total`).

## [0.3.6] - 2026-03-13

### Changed
- **Adaptive action cooldown** -- Replaced fixed 8s cooldown with context-aware timing: 4s after successful actions (faster successive actions), 10s after "action pending" responses (matches game tick cadence). Agents now act as soon as the game allows.
- **Early turn exit on action pending** -- When the game returns "action pending", the agent's turn now ends immediately instead of burning up to 29 more tool rounds. Saves tokens and prevents Haiku from making redundant calls.
- **System prompt caching** -- System prompt is no longer rebuilt from scratch every turn. Cached and only regenerated when memory, phase, or directive actually changes (~80% of turns skip the rebuild, saving ~2-3k tokens/turn).
- **Reduced maxTokens for executor** -- Executor turns now use `maxTokens: 2048` (down from 4096). Planning turns keep 4096. Halves worst-case generation time for the common case.
- **Skip redundant inter-turn polling** -- Push-capable connections (WebSocket, MCP, MCP v2) no longer call `get_status` between turns since notifications already arrive via push. HTTP connections still poll. Saves ~500-1k tokens/turn and ~200ms per cycle.

## [0.3.5] - 2026-03-13

### Fixed
- **Action-pending spam loop** -- Agents (especially Haiku 4.5) would call action commands like `mine` dozens of times in a single turn when the game returned "Action pending. Resolves next tick." Added two defenses: (1) 8-second cooldown between action commands within a turn (query commands exempt), and (2) "action pending" detection that appends a strong stop signal telling the LLM to end its turn or use query commands instead.
- **Cooldown blocking query commands on MCP v2** -- MCP v2 prefixes commands (e.g. `spacemolt_get_system`), but `QUERY_COMMANDS` set had bare names (`get_system`). Cooldown now strips the `spacemolt_` prefix before lookup.
- **Agents receiving degraded data from MCP v2** -- `executeTool` passed `resp.result` (text summary like "Captain's log entry 0 of 20:") to the LLM instead of `resp.structuredContent` (actual JSON data). All agents were effectively blind to structured game data. Now prefers `structuredContent` when available.

### Changed
- **Log filter: separate Call checkbox** -- Split `llm_call` (model/token metadata) out of the LLM filter group into its own "Call" checkbox so it can be toggled independently.

## [0.3.4] - 2026-03-13

### Fixed
- **Local provider API key resolution** -- `resolveApiKey()` returned `undefined` for Ollama and other local/custom providers (lmstudio, vllm, etc.), causing pi-ai to fall through to `process.env.OPENAI_API_KEY` and throw "OpenAI API key is required". The per-turn key resolver now returns `'local'` for providers in `CUSTOM_BASE_URLS` or with a custom `base_url` in the DB, matching the behavior `resolveModel()` already had.
- **OpenAPI spec 429 rate-limiting on multi-agent startup** -- `fetchOpenApiSpec()` always hit the server first, then fell back to cache on failure. When multiple agents started simultaneously they all hammered the endpoint and got rate-limited. Now checks the fresh cache first (1h TTL) and only fetches from the server when the cache is stale or missing.
- **Captain's log not displaying in SidePane** -- MCP v2 now returns `structuredContent` (JSON) separately from `result` (text summary). SidePane was reading `data.result` which is now a string like `"Captain's log entry 0 of 20:"`, not the actual log data. Fixed to prefer `data.structuredContent` for parsing.
- **Captain's log spam in activity logs** -- Every captain's log fetch (20 per profile) was logged as `manual: captains_log_list()` / `RESULT Captain's log entry 0 of 20:` in the LogPane. Added `silent` option to `executeCommand()` so UI-initiated queries no longer pollute the activity log.

## [0.3.3] - 2026-03-10

### Fixed
- **Player stats missing for inactive profiles** -- The 5-second poll loop only synced connection statuses but not gameState, so only the actively-selected profile showed player stats (credits, location, faction). Now all profiles sync gameState on every poll cycle.

### Changed
- **Synced with upstream v0.3.0** -- Merged SpaceMolt/admiral v0.3.0 into fork. Picked up: server-rendered v2 text (structuredContent kept separate from result), poll no longer overwrites full player data, model picker placeholder, select theme fix, OpenAPI spec docs, and connection protocol alignment. Resolved 22 merge conflicts preserving our features (gameState refresh sync, memory prop, v1Fallback, HTTP log fetch, session expiry guard, drag-and-drop, faction grouping, improved batch buttons).
- **Adopted upstream structuredContent fix** -- v2 API result text now goes to the LLM unchanged; structured JSON kept separately for game state caching and display. Previously our code overwrote result with structuredContent JSON.
- **Closed mega-PR #8** -- Core bug fixes were backported by upstream into v0.3.0 (credited as "Brainstem2000 PR"). Remaining features (galaxy map, analytics, fleet automation) kept in fork. Will submit smaller focused PRs for universally useful features.

## [0.3.2] - 2026-03-09

### Added
- **Empire Nebula Glow** -- Ambient colored glow around empire territory clusters using additive-blended transparent spheres. Cluster density computation weights neighboring systems for brighter cores in dense empire regions.
- **Security Heatmap Overlay** -- Togglable overlay showing safe empire zones (green) and threatened/lawless areas (red). Uses fleet intel threat data polled every 30 seconds. Toggle button in bottom bar.
- **Agent Heading Indicators** -- Directional cones on the galaxy map showing each agent's last travel direction, inferred from position history between poll cycles.
- **Player Activity Density** -- Star systems with more online players appear slightly larger and brighter on the galaxy map. Zero additional draw calls.
- **Enhanced Starfield** -- Second ambient particle layer with warm gold and cool blue tinted stars for richer background depth.

### Fixed
- **Faction Group Persistence** -- Live faction name is now written back to the `group_name` database column, so agents remain grouped correctly (e.g. "Stellar Alliance") even when disconnected. Previously fell back to empty string ("Independent").
- **Batch Connect Buttons** -- "▶ All" and "■ Stop" buttons in the Profiles header now have text labels and hover backgrounds for better discoverability. Previously were nearly invisible 10px icon-only buttons.

## [0.3.1] - 2026-03-09

### Fixed
- **OAuth Token Refresh** -- Tokens are now re-resolved every turn instead of being cached at session start. Agents survive the 8-hour token expiry window without 401 errors. Concurrent refresh requests are deduplicated to avoid consuming single-use refresh tokens.
- **Disconnect Button UI** -- `refreshProfiles()` now syncs the `statuses` state map immediately after a disconnect, so the button updates without waiting for the next 5-second poll cycle.
- **Storage Credit Parser** -- Rewritten to handle all agents' memory formats: `###` sub-headings no longer reset section tracking, 3+ column tables are accepted, and new heading patterns (wallet/credits, asset inventory) are recognized. Bare `N credits` list items are now parsed.
- **Timeline Invalid Date** -- Fixed `formatTime()` double-appending `Z` to ISO timestamps from live SSE entries, causing "Invalid Date" display on all live timeline rows.
- **Scheduler JSDoc** -- Fixed `*/5` in a JSDoc comment prematurely closing the comment block.
- **Analytics Operator Precedence** -- Fixed `??` vs `&&` precedence issue in cargo state extraction.

## [0.3.0] - 2026-03-06

### Added
- **Cross-Agent Intelligence Sharing** — Agents passively collect intel from game command results (market prices, system discoveries, threats) and store it in shared SQLite tables. Fleet Intelligence Briefings are auto-injected into agent system prompts so all agents benefit from each other's discoveries.
- **Fleet Intel Panel** — New dashboard panel (visible in Fleet Map view) with Market, Systems, and Threats tabs showing aggregated fleet intelligence.
- **Fleet Intel REST API** — `GET /api/fleet-intel` endpoint returns all collected market, system, and threat data.

## [0.2.1] - 2026-03-06

### Added
- **3D Galaxy Map** — Replaced 2D canvas galaxy map with immersive Three.js + React Three Fiber visualization. Orbit, zoom, pan freely. InstancedMesh rendering for 505 systems in a single draw call. Agent diamond markers with pulse animations. System popup with details on click. Background starfield.
- **Fleet Legend** — Overlay panel showing agent positions. Click an agent to fly the camera to their system.

## [0.2.0] - 2026-03-05

### Added
- **Fleet Command Center** — Galaxy map visualization showing all star systems, connections, and agent positions. Camera controls for orbit/zoom/pan. System selection popup with details.
- **Galaxy Map API** — `GET /api/galaxy` and `POST /api/galaxy/refresh` endpoints for cached galaxy data.
- **Persistent Agent Memory** — `read_memory()` and `update_memory()` local tools. Memory field in profiles table. SidePane editor in UI.
- **Profile Reordering** — Drag-and-drop profile sorting with `sort_order` field. Group sections (e.g., "Stellar Alliance" vs Independent).
- **Group Names** — `group_name` field on profiles for organizing agents into factions/teams.

## [0.1.0] - 2026-03-04

### Added
- **Multi-Agent Manager** — Create, configure, and run multiple autonomous AI agents simultaneously.
- **Claude MAX OAuth Integration** — Authenticate via Claude MAX subscription for API access.
- **Multi-Provider Support** — Anthropic, OpenAI, Google, Groq, xAI, Mistral, OpenRouter, Ollama, LM Studio, and custom providers.
- **Game Connection Modes** — HTTP, HTTP v2, WebSocket, MCP, and MCP v2 connection modes to the SpaceMolt game server.
- **Agent TODO System** — `read_todo()` and `update_todo()` local tools for agent self-management.
- **Real-time Log Viewer** — Live streaming of agent actions, tool calls, LLM thoughts, and errors.
- **Context Budget Control** — Per-agent context window budget slider to control token usage.
- **Agent Directives** — Custom directives per agent defining personality and mission.
- **Dark/Light Theme** — Toggle between dark and light themes with full UI support.
- **Auto-connect** — Agents can auto-connect on server startup.
- **Settings Panel** — Registration code, game server URL, default provider/model, max turns, LLM timeout configuration.
