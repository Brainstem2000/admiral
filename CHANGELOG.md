# Changelog

All notable changes to Admiral are documented here.

## [0.3.2] - 2026-03-09

### Added
- **Empire Nebula Glow** -- Ambient colored glow around empire territory clusters using additive-blended transparent spheres. Cluster density computation weights neighboring systems for brighter cores in dense empire regions.
- **Security Heatmap Overlay** -- Togglable overlay showing safe empire zones (green) and threatened/lawless areas (red). Uses fleet intel threat data polled every 30 seconds. Toggle button in bottom bar.
- **Agent Heading Indicators** -- Directional cones on the galaxy map showing each agent's last travel direction, inferred from position history between poll cycles.
- **Player Activity Density** -- Star systems with more online players appear slightly larger and brighter on the galaxy map. Zero additional draw calls.
- **Enhanced Starfield** -- Second ambient particle layer with warm gold and cool blue tinted stars for richer background depth.

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
