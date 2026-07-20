import { Type, StringEnum } from '@mariozechner/pi-ai'
import type { Tool } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import { updateProfile, createFleetOrder, getFleetOrders, getFleetOrdersByChain, updateFleetOrder, listProfiles, getPreference } from './db'
import { FleetIntelCollector } from './fleet-intel'
import { LedgerCollector } from './ledger'
import { agentManager } from './agent-manager'
import { invalidateBriefingCache } from './briefing'
import { safeTruncate } from './text-safe'

// Extended query result cache: keyed by "profileId:command:argsJSON"
const queryCache = new Map<string, { result: string; timestamp: number }>()

// --- Tool Definitions ---

export const allTools: Tool[] = [
  {
    name: 'game',
    description: 'Execute a SpaceMolt game command. See the system prompt for available commands.',
    parameters: Type.Object({
      command: Type.String({ description: 'The game command name (e.g. mine, travel, get_status)' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Command arguments as key-value pairs' })),
    }),
  },
  {
    name: 'mine_until_full',
    description: 'MACRO: mine repeatedly until the cargo hold is full (or the resource depletes). Runs as one bounded code loop — vastly cheaper than calling mine one turn at a time. Requires being at a mineable POI. Returns how much was mined and why it stopped.',
    parameters: Type.Object({
      max_mines: Type.Optional(Type.Number({ description: 'Max mine actions before stopping (default 30, cap 60)' })),
      stop_at_pct: Type.Optional(Type.Number({ description: 'Stop when cargo reaches this % full (default 100)' })),
    }),
  },
  {
    name: 'goto_system',
    description: 'MACRO: plot a route with find_route and jump every hop to the target system in one bounded code loop — instead of one jump per turn. Optionally docks at a POI on arrival. Verifies fuel first. Returns arrival status, hops taken, fuel remaining.',
    parameters: Type.Object({
      target_system: Type.String({ description: 'Destination system id (snake_case, e.g. "iron_reach")' }),
      dock_at_poi: Type.Optional(Type.String({ description: 'POI id to travel to and dock at after arriving (e.g. "war_citadel")' })),
    }),
  },
  {
    name: 'sell_cargo',
    description: 'MACRO: sell every cargo item at the current docked station in one bounded code loop (skips items you list in exclude). Items with no buyers are reported, not errors. Returns per-item results and total credits gained. You MUST pass exclude for anything your directive forbids selling (e.g. BoM-locked items).',
    parameters: Type.Object({
      exclude: Type.Optional(Type.Array(Type.String(), { description: 'item_ids to NOT sell (BoM-locked / mission cargo)' })),
    }),
  },
  {
    name: 'save_credentials',
    description: 'Save your login credentials locally. Do this IMMEDIATELY after registering!',
    parameters: Type.Object({
      username: Type.String({ description: 'Your username' }),
      password: Type.String({ description: 'Your password (256-bit hex)' }),
      empire: Type.String({ description: 'Your empire' }),
      player_id: Type.String({ description: 'Your player ID' }),
    }),
  },
  {
    name: 'update_todo',
    description: 'Update your local TODO list to track goals and progress.',
    parameters: Type.Object({
      content: Type.String({ description: 'Full TODO list content (replaces existing)' }),
    }),
  },
  {
    name: 'read_todo',
    description: 'Read your current TODO list.',
    parameters: Type.Object({}),
  },
  {
    name: 'read_memory',
    description: 'Read your persistent memory - accumulated knowledge, routes, market intel, storage inventories, lessons learned, strategic plans. Persists across all sessions.',
    parameters: Type.Object({}),
  },
  {
    name: 'update_memory',
    description: 'Update your persistent memory. Save important discoveries, routes, market intel, storage inventories, combat data, lessons. Replaces entire memory - include everything you want to keep.',
    parameters: Type.Object({
      content: Type.String({ description: 'Full memory content (replaces existing). Use markdown.' }),
    }),
  },
  {
    name: 'status_log',
    description: 'Log a status message visible to the human watching.',
    parameters: Type.Object({
      category: StringEnum(['mining', 'travel', 'combat', 'trade', 'chat', 'info', 'craft', 'faction', 'mission', 'setup'], {
        description: 'Message category',
      }),
      message: Type.String({ description: 'Status message' }),
    }),
  },
  {
    name: 'fleet_order',
    description: 'Send an order to another fleet agent. Use this to delegate tasks like delivery, crafting, or buying. The target agent will see the order in their next turn. Use chain_id + next_orders to create dependency chains that auto-trigger on completion.',
    parameters: Type.Object({
      target_agent: Type.String({ description: 'Name of the target agent (e.g. "Bob Comet", "CyberSapper")' }),
      type: StringEnum(['deliver', 'buy', 'sell', 'craft', 'travel', 'mine', 'custom'], {
        description: 'Order type',
      }),
      description: Type.String({ description: 'What the target should do. Be specific: item, quantity, destination.' }),
      params: Type.Optional(Type.String({ description: 'JSON params (item_id, quantity, destination, etc.)' })),
      chain_id: Type.Optional(Type.String({ description: 'Chain name to group related orders (e.g. "iron-pipeline"). Orders in the same chain are tracked together.' })),
      next_orders: Type.Optional(Type.String({ description: 'JSON array of follow-up orders to auto-create when THIS order completes. Format: [{"target_agent":"Bob","type":"deliver","description":"Haul ore to hub"}]. Supports nesting.' })),
    }),
  },
  {
    name: 'read_fleet_orders',
    description: 'Read orders assigned to you by other fleet agents, and orders you have issued. Update order status when completing tasks. Use action="chain" to view all orders in a dependency chain.',
    parameters: Type.Object({
      action: StringEnum(['inbox', 'sent', 'accept', 'complete', 'reject', 'chain'], {
        description: 'inbox = orders for you, sent = orders you issued, accept/complete/reject = update order status, chain = view all orders in a chain',
      }),
      order_id: Type.Optional(Type.String({ description: 'Order ID (required for accept/complete/reject)' })),
      chain_id: Type.Optional(Type.String({ description: 'Chain ID (required for action=chain)' })),
      progress: Type.Optional(Type.String({ description: 'Progress note when accepting or completing' })),
    }),
  },
]

const LOCAL_TOOLS = new Set(['save_credentials', 'update_todo', 'read_todo', 'update_memory', 'read_memory', 'status_log', 'fleet_order', 'read_fleet_orders'])
// Macro tools: bounded code loops over game commands — one LLM call replaces
// dozens of per-step calls. They pace themselves (lib_v2 mutations await the
// tick; other modes sleep between steps), so they bypass the single-action
// cooldown gate and re-arm it when they finish.
const MACRO_TOOLS = new Set(['mine_until_full', 'goto_system', 'sell_cargo'])

const MAX_RESULT_CHARS = 4000

// Cooldown tracking for action commands to prevent spam loops (e.g. mine → "Action pending" → mine → ...)
// Maps profileId → last action timestamp + whether it was pending
const actionCooldowns = new Map<string, { timestamp: number; wasPending: boolean }>()
const COOLDOWN_AFTER_SUCCESS = 4000   // 4s between actions when last succeeded (allows fast successive actions)
const COOLDOWN_AFTER_PENDING = 10000  // 10s when last action was pending (match game tick cadence)

// Track when memory is updated so system prompt caching can skip rebuilds
export const memoryDirtyFlags = new Map<string, boolean>()

/**
 * Drop all per-profile state held in module-level maps when an agent stops.
 * Without this these maps only ever grow, leaking memory across the lifetime of
 * the process as profiles connect/disconnect.
 */
export function cleanupProfileToolState(profileId: string): void {
  actionCooldowns.delete(profileId)
  memoryDirtyFlags.delete(profileId)
  const prefix = `${profileId}:`
  for (const key of queryCache.keys()) {
    if (key.startsWith(prefix)) queryCache.delete(key)
  }
}

// Sentinel prefix for action pending results — loop.ts detects this to exit the turn early
export const ACTION_PENDING_SENTINEL = '⚠️ ACTION_PENDING: '
// Prefix of the cooldown-gate rejection. The loop watches for this to end the turn early instead
// of letting the model re-fire into the gate for the rest of its round budget.
export const COOLDOWN_BLOCKED_SENTINEL = '⏳ ACTION BLOCKED'

// Commands that are free queries (no tick cost) — exempt from cooldown.
// Includes both v1 bare names AND v2 grouped names (e.g. market_view_market, storage_view).
const QUERY_COMMANDS = new Set([
  // v1 bare names
  'get_status', 'get_location', 'get_ship', 'get_cargo', 'get_system', 'get_poi', 'get_base',
  'get_map', 'get_skills', 'get_nearby', 'get_wrecks', 'get_trades', 'get_player', 'get_queue',
  'get_missions', 'get_active_missions', 'get_notifications', 'get_chat_history',
  'get_battle_status', 'get_commands', 'get_guide', 'get_version', 'get_notes',
  'get_insurance_quote', 'get_action_log', 'view_market', 'view_orders',
  'view_storage', 'view_faction_storage', 'view_completed_mission',
  'estimate_purchase', 'analyze_market', 'find_route', 'search_systems',
  'scan', 'help', 'catalog', 'browse_ships', 'commission_quote', 'commission_status',
  'completed_missions', 'read_note', 'get_notes', 'captains_log_list', 'captains_log_get',
  'faction_info', 'faction_list', 'faction_get_invites', 'faction_rooms',
  'faction_visit_room', 'faction_intel_status', 'faction_query_intel',
  'faction_query_trade_intel', 'faction_trade_intel_status', 'faction_list_missions',
  'forum_list', 'forum_get_thread', 'read_fleet_orders', 'claim_insurance',
  // v2 grouped names (tool_action format from MCP v2 / HTTP v2)
  'market_view_market', 'market_view_orders', 'market_analyze_market', 'market_estimate_purchase',
  'storage_view', 'storage_view_faction',
  'social_captains_log_list', 'social_captains_log_get', 'social_get_notes', 'social_read_note',
  'social_get_chat_history', 'social_forum_list', 'social_forum_get_thread',
  'intel_query_intel', 'intel_query_trade_intel', 'intel_intel_status', 'intel_trade_intel_status',
  'faction_info', 'faction_list', 'faction_get_invites', 'faction_rooms', 'faction_visit_room',
  'faction_list_missions',
  'faction_admin_list_roles',
  'salvage_wrecks', 'salvage_policies',
  'catalog_catalog', 'catalog_browse_ships',
  'ship_get_ship', 'ship_get_cargo',
  'battle_get_battle_status',
])

export type LogFn = (type: string, summary: string, detail?: string) => void

interface ToolContext {
  connection: GameConnection
  profileId: string
  profileName: string
  log: LogFn
  todo: string
  memory: string
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reason?: string,
): Promise<string> {
  if (LOCAL_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    return executeLocalTool(name, args, ctx)
  }

  if (MACRO_TOOLS.has(name)) {
    ctx.log('tool_call', `${name}(${formatArgs(args)})`)
    const summary = await executeMacroTool(name, args, ctx)
    // A macro just performed real game actions: refresh passive awareness and
    // arm the normal cooldown so the next direct action is properly paced.
    actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: false })
    invalidateBriefingCache(ctx.profileId, ctx.connection)
    ctx.log('tool_result', truncate(summary, 200), summary)
    return summary
  }

  let command: string
  let commandArgs: Record<string, unknown> | undefined
  if (name === 'game') {
    command = String(args.command || '')
    commandArgs = args.args as Record<string, unknown> | undefined
    if (!command) return 'Error: missing \'command\' argument'
    // Models sometimes flatten command args to the top level — game({command:'deposit',
    // item_id:'x'}) instead of game({command:'deposit', args:{item_id:'x'}}). Those keys
    // were silently dropped (observed live: 10 consecutive argless deposit calls).
    // Fold any extra top-level keys into the command args; explicit args.args wins.
    const extras: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k !== 'command' && k !== 'args' && v !== undefined) extras[k] = v
    }
    if (Object.keys(extras).length > 0) commandArgs = { ...extras, ...(commandArgs ?? {}) }
  } else {
    command = name
    commandArgs = Object.keys(args).length > 0 ? args : undefined
  }

  // Auto-correct common parameter mistakes to reduce wasted API calls
  if (commandArgs) {
    const bare = command.replace(/^spacemolt_/, '')
    // travel uses target_poi, not destination/target_system/target
    if ((bare === 'travel' || bare.endsWith('_travel')) && !commandArgs.target_poi) {
      if (commandArgs.destination) { commandArgs.target_poi = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_poi = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.target_system) { commandArgs.target_poi = commandArgs.target_system; delete commandArgs.target_system }
    }
    // travel/dock: auto-fix POI names to snake_case (e.g. "Cargo Station" → "cargo_station")
    if (bare === 'travel' || bare.endsWith('_travel') || bare === 'dock' || bare.endsWith('_dock')) {
      const poi = String(commandArgs.target_poi || '')
      if (poi && poi !== poi.toLowerCase().replace(/\s+/g, '_')) {
        commandArgs.target_poi = poi.toLowerCase().replace(/\s+/g, '_')
      }
    }
    // jump uses target_system, not destination/target/target_poi
    if ((bare === 'jump' || bare.endsWith('_jump')) && !commandArgs.target_system) {
      if (commandArgs.destination) { commandArgs.target_system = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_system = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.target_poi) { commandArgs.target_system = commandArgs.target_poi; delete commandArgs.target_poi }
    }
    // find_route uses target_system, not destination/text/target
    if ((bare === 'find_route' || bare.endsWith('_find_route')) && !commandArgs.target_system) {
      if (commandArgs.destination) { commandArgs.target_system = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target) { commandArgs.target_system = commandArgs.target; delete commandArgs.target }
      else if (commandArgs.text) { commandArgs.target_system = commandArgs.text; delete commandArgs.text }
    }
    // find_route / jump: auto-fix station names passed as system names
    // e.g. "Grand Exchange Station" → "haven", "Starfall Salvage Station" → "starfall"
    if (bare === 'find_route' || bare.endsWith('_find_route') || bare === 'jump' || bare.endsWith('_jump')) {
      const ts = String(commandArgs.target_system || '')
      if (ts && /station|exchange|colony|outpost|hub|depot|citadel|nexus|resort/i.test(ts)) {
        // Strip common station suffixes to extract likely system name
        const cleaned = ts.replace(/\s*(station|exchange|colony|outpost|hub|depot|citadel|nexus|resort|salvage|mining|industrial|colonial|processing|freight|research)\s*/gi, ' ').trim().replace(/\s+/g, '_').toLowerCase()
        commandArgs.target_system = cleaned
      }
    }
    // search_systems uses query, not text
    if ((bare === 'search_systems' || bare.endsWith('_search_systems')) && !commandArgs.query && commandArgs.text) {
      commandArgs.query = commandArgs.text; delete commandArgs.text
    }
    // catalog uses type, not category; also fix singular→plural and default to 'items' if missing
    if (bare === 'catalog' || bare.endsWith('_catalog')) {
      if (!commandArgs.type && commandArgs.category) { commandArgs.type = commandArgs.category; delete commandArgs.category }
      if (!commandArgs.type && commandArgs.search) { commandArgs.type = 'items' } // default to items search
      const SINGULAR_FIX: Record<string, string> = { recipe: 'recipes', skill: 'skills', ship: 'ships', item: 'items' }
      if (commandArgs.type && SINGULAR_FIX[commandArgs.type]) { commandArgs.type = SINGULAR_FIX[commandArgs.type] }
    }
    // view_market: strip unknown params — only item_id and category are valid
    if (bare === 'view_market' || bare === 'market_view_market' || bare.endsWith('_view_market')) {
      if (commandArgs.search && !commandArgs.item_id) { commandArgs.item_id = commandArgs.search; delete commandArgs.search }
      if (commandArgs.item && !commandArgs.item_id) { commandArgs.item_id = commandArgs.item; delete commandArgs.item }
    }
    // analyze_market: needs search param, not item_id
    if (bare === 'analyze_market' || bare === 'market_analyze_market' || bare.endsWith('_analyze_market')) {
      if (commandArgs.item_id && !commandArgs.search) { commandArgs.search = commandArgs.item_id; delete commandArgs.item_id }
      if (commandArgs.item && !commandArgs.search) { commandArgs.search = commandArgs.item; delete commandArgs.item }
    }
    // send_chat: fix common channel names
    if (bare === 'send_chat' || bare === 'social_send_chat' || bare.endsWith('_send_chat')) {
      const ch = String(commandArgs.channel || '').toLowerCase()
      const CHANNEL_FIX: Record<string, string> = { 'global': 'system', 'general': 'system', 'local': 'system', 'faction': 'faction', 'trade': 'trading', 'help': 'system' }
      if (ch && CHANNEL_FIX[ch]) { commandArgs.channel = CHANNEL_FIX[ch] }
      // Truncate over-long messages before send — the game rejects them with [message_too_long]
      // (232 wasted calls in 36h), usually from agents pasting multi-paragraph SITREPs into chat.
      const CHAT_MAX = 480
      for (const k of ['content', 'message', 'text']) {
        const v = commandArgs[k]
        if (typeof v === 'string' && v.length > CHAT_MAX) commandArgs[k] = safeTruncate(v, CHAT_MAX - 1, '…')
      }
    }
    // scan/attack: the game API expects `target_id`. Normalize id/target -> target_id.
    // (Do NOT rename target_id away — an earlier version mapped target_id -> id, which the
    //  current API rejects with [invalid_payload] Unknown parameter(s): id, making all
    //  combat impossible while gaslighting the agent into thinking it wrote the wrong key.)
    if (bare === 'scan' || bare.endsWith('_scan') || bare === 'attack' || bare.endsWith('_attack')) {
      if (commandArgs.id && !commandArgs.target_id) { commandArgs.target_id = commandArgs.id; delete commandArgs.id }
      if (commandArgs.target && !commandArgs.target_id) { commandArgs.target_id = commandArgs.target; delete commandArgs.target }
    }
    // items passed as a JSON string instead of an array (bulk deposit/withdraw) —
    // parse it so the server sees a real array (observed live: "Parameter 'items'
    // must be an array, but received a string").
    if (typeof commandArgs.items === 'string') {
      try {
        const parsed = JSON.parse(commandArgs.items as string)
        if (Array.isArray(parsed)) commandArgs.items = parsed
      } catch { /* leave as-is; server error will surface it */ }
    }
    // Strip empty-string values from args — they cause invalid_target/invalid_payload errors
    for (const key of Object.keys(commandArgs)) {
      if (commandArgs[key] === '' || commandArgs[key] === null || commandArgs[key] === undefined) {
        delete commandArgs[key]
      }
    }
  }

  // Normalize: strip spacemolt_ prefix from direct command names so http_v2 route map finds them.
  // e.g. "spacemolt_browse_ships" → "browse_ships", "spacemolt_catalog" → "catalog"
  // Grouped v2 names like "spacemolt_market_view_market" are already handled by the route map.
  if (command.startsWith('spacemolt_')) {
    command = command.slice('spacemolt_'.length)
  }

  // scan() with no target = agent wants to see nearby entities → redirect to get_nearby
  // scan REQUIRES a target_id/id; there is no "area scan" mode
  if ((command === 'scan' || command.endsWith('_scan')) && !commandArgs) {
    command = 'get_nearby'
  }

  // Redirect deprecated commands
  const bareFinal = command
  if (bareFinal === 'get_ships' || bareFinal.endsWith('_get_ships')) {
    command = command.replace('get_ships', 'browse_ships')
  }

  const fmtArgs = commandArgs ? formatArgs(commandArgs) : ''
  ctx.log('tool_call', `game(${command}${fmtArgs ? ', ' + fmtArgs : ''})`)

  // Cooldown check for action commands to prevent spam loops
  // Strip MCP v2 prefix (e.g. "spacemolt_get_system" → "get_system") for lookup
  const bareCommand = command.replace(/^spacemolt_/, '')
  // Also strip v2 tool group prefix (e.g. "market_view_market" → "view_market")
  const deepBare = bareCommand.replace(/^(?:market|storage|social|intel|faction|faction_admin|salvage|catalog|ship|battle|transfer|facility|auth)_/, '')
  const isQuery = QUERY_COMMANDS.has(command) || QUERY_COMMANDS.has(bareCommand) || QUERY_COMMANDS.has(deepBare)
    // Heuristic: commands starting with get_/view_/list_/query_/browse_/search_/find_/estimate_ are queries
    || /^(?:get_|view_|list_|query_|browse_|search_|find_|estimate_|help|scan|catalog)/.test(deepBare)
  if (!isQuery) {
    const lastAction = actionCooldowns.get(ctx.profileId)
    if (lastAction) {
      const cooldownMs = lastAction.wasPending ? COOLDOWN_AFTER_PENDING : COOLDOWN_AFTER_SUCCESS
      const elapsed = Date.now() - lastAction.timestamp
      if (elapsed < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - elapsed) / 1000)
        ctx.log('tool_result', `Cooldown: ${command} blocked (${waitSec}s remaining)`)
        return `${COOLDOWN_BLOCKED_SENTINEL} — cooldown active (${waitSec}s remaining). Game actions cost 1 tick (~10s). You just performed an action. Use query commands (get_status, get_cargo, view_market, read_todo, etc.) while waiting, or STOP calling tools and end your turn.`
      }
    }
    actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: false })
  }

  // Extended query cache only. The situational briefing is NO LONGER used to short-circuit an
  // agent's explicit query calls. When an agent deliberately runs get_status / get_system /
  // get_active_missions / get_cargo / get_nearby, it must always receive LIVE ground-truth — never a
  // lossy or stale briefing snapshot. Intercepting these caused agents to (a) get a summary-only
  // get_system with no POI ids/types (breaking pirate-belt hunting), (b) act on the wrong system
  // after a jump, and (c) loop "the cache is stale, force a fresh query", burning turns. The briefing
  // still provides zero-token passive awareness via the system prompt; it just never overrides an
  // explicit query. In-game queries are free (no tick), so this costs only a round-trip.
  if (isQuery && getPreference('situational_briefing') !== 'off') {
    // Extended query cache: catalog (static, 1h TTL) and market queries (60s TTL)
    const cacheKey = `${ctx.profileId}:${deepBare}:${JSON.stringify(commandArgs ?? {})}`
    const cached = queryCache.get(cacheKey)
    const CATALOG_COMMANDS = new Set(['catalog', 'browse_ships', 'commission_quote'])
    const MARKET_COMMANDS = new Set(['view_market', 'analyze_market', 'view_orders', 'estimate_purchase'])
    const isCatalog = CATALOG_COMMANDS.has(deepBare)
    const isMarket = MARKET_COMMANDS.has(deepBare)
    if (cached && (isCatalog || isMarket)) {
      const ttl = isCatalog ? 3600_000 : 60_000 // 1h for catalog, 60s for market
      if (Date.now() - cached.timestamp < ttl) {
        const hint = `[Cached ${isCatalog ? 'catalog' : 'market'} data, ${Math.round((Date.now() - cached.timestamp) / 1000)}s old]\n${cached.result}`
        ctx.log('tool_result', `(cached) ${truncate(cached.result, 150)}`)
        return hint
      }
    }
  }

  try {
    const resp = await ctx.connection.execute(command, commandArgs && Object.keys(commandArgs).length > 0 ? commandArgs : undefined)

    if (resp.error) {
      let errMsg = `Error: [${resp.error.code}] ${resp.error.message}`

      // Augment common errors with actionable hints to reduce wasted turns
      const errCode = resp.error.code
      if (errCode === 'invalid_poi') {
        const target = commandArgs?.target_poi || commandArgs?.target || ''
        const snaked = String(target).toLowerCase().replace(/\s+/g, '_')
        const snakeHint = target !== snaked ? ` POI names use snake_case format (e.g. "${snaked}").` : ''
        errMsg += `\n\n💡 HINT: "${target}" was not found as a POI at your current location.${snakeHint} Use get_poi() to see available POIs here. If "${target}" is a star system (not a POI), use jump(target_system="${snaked}") instead of travel().`
      }
      if (errCode === 'not_connected') {
        // Agent tried to jump to a non-adjacent system — suggest find_route
        const target = commandArgs?.target_system || commandArgs?.target || ''
        errMsg += `\n\n💡 HINT: "${target}" is not adjacent to your current system. Use find_route(target_system="${target}") first to get a step-by-step route, then jump along each hop.`
      }
      if (errCode === 'unknown_command') {
        errMsg += `\n\n💡 HINT: Use help() to see all available commands, or catalog() to browse game data.`
      }
      if (errCode === 'not_docked') {
        errMsg += `\n\n💡 HINT: You must be docked at a station for this action. Use get_poi() to check if your current location has a base, then dock() to dock. If there's no base here, travel(target_poi="...") to a station POI first.`
      }
      if (errCode === 'invalid_channel') {
        errMsg += `\n\n💡 HINT: Valid chat channels are: "system" (all players in system), "local" (players at your POI), "faction" (faction members), "private" (DM — requires target_id). There is no "global", "general", or "trade" channel.`
      }
      if (errCode === 'system_not_found') {
        const target = commandArgs?.target_system || commandArgs?.target || ''
        errMsg += `\n\n💡 HINT: "${target}" was not found as a system name. If you used a station name (e.g. "Grand Exchange Station"), use the system name instead (e.g. "haven"). Use search_systems(query="...") to find the correct system name.`
      }
      if (errCode === 'invalid_target') {
        const target = commandArgs?.target_id || commandArgs?.target || ''
        if (!target && (deepBare === 'scan' || deepBare === 'attack')) {
          errMsg += `\n\n💡 HINT: ${deepBare}() requires a target_id. Use get_nearby() first to see players/NPCs at your location, then ${deepBare}(target_id="their_id").`
        } else {
          errMsg += `\n\n💡 HINT: Target "${target}" is not at your current location. Use get_nearby() to see who is here. The target may have left or you may have the wrong ID.`
        }
      }
      if (errCode === 'invalid_type') {
        errMsg += `\n\n💡 HINT: Valid catalog types are: "ships", "skills", "recipes", "items". Use catalog(type="items") for materials/resources, catalog(type="recipes") for crafting recipes.`
      }
      if (errCode === 'invalid_payload') {
        if (deepBare === 'view_market' || deepBare === 'market_view_market') {
          errMsg += `\n\n💡 HINT: view_market accepts only "item_id" and "category" parameters. There is no "scope" or "search" parameter. Use catalog(search="...", type="items") to search items first, then view_market(item_id="exact_id") to see market data. For galaxy-wide trade intel, use intel_query_trade_intel(item_id="...").`
        }
      }

      ctx.log('tool_result', errMsg)
      return errMsg
    }

    // MCP v2 returns structuredContent (JSON) separately from result (text summary).
    // Prefer structuredContent for the LLM — it has the actual data.
    const resultData = resp.structuredContent ?? resp.result
    const result = formatToolResult(command, resultData, resp.notifications)
    ctx.log('tool_result', truncate(result, 200), result)

    // Detect "action pending" responses — enforce extended cooldown and signal turn exit
    const resultLower = result.toLowerCase()
    if (resultLower.includes('action pending') || resultLower.includes('resolves next tick') || resultLower.includes('already pending')) {
      ctx.log('tool_result', `Action pending detected for ${command} — extended cooldown enforced`)
      // Mark cooldown as pending so next action waits full tick duration
      actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: true })
      // Sentinel prefix triggers early turn exit in loop.ts
      const pendingResult = ACTION_PENDING_SENTINEL + result + '\n\n⚠️ STOP — Your action is QUEUED and will resolve on the next game tick (~10 seconds). Do NOT call this command again. Either use query commands (get_status, get_cargo, read_todo, view_market) to check on things, or end your turn and wait.'
      // Passively collect fleet intel
      try {
        FleetIntelCollector.processCommandResult(command, resp.result, ctx.profileName)
        if (resp.notifications) FleetIntelCollector.processNotifications(resp.notifications, ctx.profileName)
      } catch { /* never break game execution */ }
      // Invalidate briefing cache — action changed game state; trigger async refresh
      invalidateBriefingCache(ctx.profileId, ctx.connection)
      return truncateResult(pendingResult)
    }

    // Passively collect fleet intel from game results
    try {
      FleetIntelCollector.processCommandResult(command, resp.result, ctx.profileName)
      if (resp.notifications) FleetIntelCollector.processNotifications(resp.notifications, ctx.profileName)
    } catch { /* never break game execution */ }

    // Book credit movements from the resolved result — ONLY here, on the resolved success
    // path of action commands. The action-pending sentinel path above must NOT book: the
    // resolved result echoes the same trade payload again, so booking both would
    // double-count every trade. Notification-borne credits (bounties, fills, mission
    // rewards) are NOT booked here: they attach to whatever response comes next (usually
    // a query) and are booked once in the Agent's onNotification handler — the chokepoint
    // every connection and command path funnels notifications through.
    if (!isQuery) {
      try {
        LedgerCollector.processCommandResult(command, resultData, ctx.profileId, ctx.profileName)
      } catch { /* never break game execution */ }
    }

    // After a successful action, invalidate caches so the next
    // query fetches live data instead of returning stale pre-action state.
    if (!isQuery) {
      invalidateBriefingCache(ctx.profileId, ctx.connection)
      // Also purge market query cache entries for this profile (catalog stays — it's static)
      for (const [key] of queryCache) {
        if (key.startsWith(ctx.profileId + ':') && !key.includes(':catalog:') && !key.includes(':browse_ships:') && !key.includes(':commission_quote:')) {
          queryCache.delete(key)
        }
      }
    }

    // Store cacheable query results for future intercept
    if (isQuery && getPreference('situational_briefing') !== 'off') {
      const CACHEABLE = new Set(['catalog', 'browse_ships', 'commission_quote', 'view_market', 'analyze_market', 'view_orders', 'estimate_purchase'])
      if (CACHEABLE.has(deepBare)) {
        const cacheKey = `${ctx.profileId}:${deepBare}:${JSON.stringify(commandArgs ?? {})}`
        queryCache.set(cacheKey, { result, timestamp: Date.now() })
        // Prune cache if it grows too large (max 200 entries)
        if (queryCache.size > 200) {
          const oldest = [...queryCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
          for (let i = 0; i < 50; i++) queryCache.delete(oldest[i][0])
        }
      }
    }

    return truncateResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errMsg = `Error executing ${command}: ${msg}`
    ctx.log('error', errMsg)
    return errMsg
  }
}

function executeLocalTool(name: string, args: Record<string, unknown>, ctx: ToolContext): string {
  switch (name) {
    case 'save_credentials': {
      const creds = {
        username: String(args.username),
        password: String(args.password),
        empire: String(args.empire),
        player_id: String(args.player_id),
      }
      updateProfile(ctx.profileId, {
        username: creds.username,
        password: creds.password,
        empire: creds.empire,
        player_id: creds.player_id,
      })
      ctx.log('system', `Credentials saved for ${creds.username}`)
      return `Credentials saved successfully for ${creds.username}.`
    }
    case 'update_todo': {
      ctx.todo = String(args.content)
      updateProfile(ctx.profileId, { todo: ctx.todo })
      ctx.log('system', 'TODO list updated')
      return 'TODO list updated.'
    }
    case 'read_todo': {
      return ctx.todo || '(empty TODO list)'
    }
    case 'update_memory': {
      ctx.memory = String(args.content)
      updateProfile(ctx.profileId, { memory: ctx.memory })
      memoryDirtyFlags.set(ctx.profileId, true)
      ctx.log('system', 'Memory updated')
      return 'Memory updated.'
    }
    case 'read_memory': {
      return ctx.memory || '(empty memory)'
    }
    case 'status_log': {
      ctx.log('system', `[${args.category}] ${args.message}`)
      return 'Logged.'
    }
    case 'fleet_order': {
      const targetName = String(args.target_agent)
      const profiles = listProfiles()
      const target = profiles.find(p => p.name.toLowerCase() === targetName.toLowerCase())
      if (!target) return `Error: No agent named "${targetName}". Available: ${profiles.map(p => p.name).join(', ')}`

      const orderId = crypto.randomUUID()
      const chainId = args.chain_id ? String(args.chain_id) : null
      const nextOrders = args.next_orders ? String(args.next_orders) : null
      createFleetOrder({
        id: orderId,
        from_profile_id: ctx.profileId,
        to_profile_id: target.id,
        type: String(args.type),
        description: String(args.description),
        params: args.params ? String(args.params) : null,
        chain_id: chainId,
        next_orders: nextOrders,
      })

      // Nudge the target agent if they're running
      const chainTag = chainId ? ` (chain: ${chainId})` : ''
      const orderMsg = `Fleet order from ${ctx.profileName}: [${args.type}] ${args.description}${chainTag}`
      agentManager.nudge(target.id, `## Fleet Order Received\n${orderMsg}\nUse read_fleet_orders(action="inbox") to see details and accept/complete orders.`)

      ctx.log('system', `Fleet order sent to ${target.name}: [${args.type}] ${args.description}${chainTag}`)
      const chainInfo = nextOrders ? ` Chain continues with ${JSON.parse(nextOrders).length} follow-up order(s).` : ''
      return `Order sent to ${target.name} (id: ${orderId.slice(0, 8)}).${chainInfo} They will be notified.`
    }
    case 'read_fleet_orders': {
      const action = String(args.action)
      const profiles = listProfiles()
      const nameOf = (id: string) => profiles.find(p => p.id === id)?.name || id.slice(0, 8)

      if (action === 'inbox') {
        const orders = getFleetOrders({ toProfileId: ctx.profileId })
        if (orders.length === 0) return 'No orders in your inbox.'
        return orders.map(o =>
          `[${o.id.slice(0, 8)}] ${o.status.toUpperCase()} | From: ${nameOf(o.from_profile_id)} | Type: ${o.type}\n  ${o.description}${o.progress ? `\n  Progress: ${o.progress}` : ''}`
        ).join('\n\n')
      }
      if (action === 'sent') {
        const orders = getFleetOrders({ fromProfileId: ctx.profileId })
        if (orders.length === 0) return 'No orders sent.'
        return orders.map(o =>
          `[${o.id.slice(0, 8)}] ${o.status.toUpperCase()} | To: ${nameOf(o.to_profile_id)} | Type: ${o.type}\n  ${o.description}${o.progress ? `\n  Progress: ${o.progress}` : ''}`
        ).join('\n\n')
      }
      if (action === 'chain') {
        const chainId = String(args.chain_id || '')
        if (!chainId) return 'Error: chain_id is required for action=chain'
        const chainOrders = getFleetOrdersByChain(chainId)
        if (chainOrders.length === 0) return `No orders found in chain "${chainId}".`
        const statusIcon = (s: string) => s === 'completed' ? '✅' : s === 'accepted' ? '🔄' : s === 'rejected' ? '❌' : '⏳'
        return `Chain: ${chainId}\n` + chainOrders.map((o, i) =>
          `  [${i + 1}] ${statusIcon(o.status)} ${o.status.toUpperCase()} | ${nameOf(o.to_profile_id)}: ${o.description}${o.next_orders ? ' → (has follow-ups)' : ''}`
        ).join('\n')
      }
      if (['accept', 'complete', 'reject'].includes(action)) {
        const orderId = String(args.order_id || '')
        if (!orderId) return 'Error: order_id is required'
        // Support short IDs
        const allOrders = getFleetOrders({ toProfileId: ctx.profileId })
        const order = allOrders.find(o => o.id === orderId || o.id.startsWith(orderId))
        if (!order) return `Error: Order "${orderId}" not found in your inbox.`

        const newStatus = action === 'accept' ? 'accepted' : action === 'complete' ? 'completed' : 'rejected'
        updateFleetOrder(order.id, { status: newStatus, progress: args.progress ? String(args.progress) : undefined })

        // Notify the sender
        const statusMsg = `Order [${order.id.slice(0, 8)}] ${newStatus} by ${ctx.profileName}${args.progress ? `: ${args.progress}` : ''}`
        agentManager.nudge(order.from_profile_id, `## Fleet Order Update\n${statusMsg}`)

        // Chain completion hook: auto-create next orders when this one completes
        let chainInfo = ''
        if (newStatus === 'completed' && order.next_orders) {
          try {
            const children = JSON.parse(order.next_orders) as Array<{ target_agent: string; type: string; description: string; params?: string; next_orders?: string }>
            const created: string[] = []
            for (const child of children) {
              const childTarget = profiles.find(p => p.name.toLowerCase() === child.target_agent.toLowerCase())
              if (!childTarget) {
                ctx.log('error', `Chain: could not find agent "${child.target_agent}" for follow-up order`)
                continue
              }
              const childId = crypto.randomUUID()
              createFleetOrder({
                id: childId,
                from_profile_id: order.from_profile_id,
                to_profile_id: childTarget.id,
                type: child.type,
                description: child.description,
                params: child.params || null,
                chain_id: order.chain_id,
                next_orders: child.next_orders ? JSON.stringify(child.next_orders) : null,
              })
              const chainTag = order.chain_id ? ` (chain: ${order.chain_id})` : ''
              agentManager.nudge(childTarget.id, `## Fleet Order Received${chainTag}\nChain follow-up from ${nameOf(order.from_profile_id)}: [${child.type}] ${child.description}\nUse read_fleet_orders(action="inbox") to see details and accept/complete orders.`)
              created.push(`${childTarget.name}: [${child.type}] ${child.description}`)
              ctx.log('system', `Chain: auto-created follow-up order for ${childTarget.name}: [${child.type}] ${child.description}`)
            }
            if (created.length > 0) {
              chainInfo = `\nChain: ${created.length} follow-up order(s) auto-created:\n` + created.map(c => `  → ${c}`).join('\n')
            }
          } catch (e) {
            ctx.log('error', `Chain: failed to parse next_orders: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        ctx.log('system', `Fleet order ${order.id.slice(0, 8)} → ${newStatus}`)
        return `Order ${order.id.slice(0, 8)} marked as ${newStatus}.${chainInfo}`
      }
      return `Error: Unknown action "${action}". Use inbox, sent, accept, complete, reject, or chain.`
    }
    default:
      return `Unknown local tool: ${name}`
  }
}

// ─── Macro tools: bounded deterministic loops over game commands ───────────

const macroSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Per-step pause: lib_v2 mutations already await the game tick; other modes need real pacing. */
function macroStepDelayMs(conn: GameConnection): number {
  return conn.mode === 'lib_v2' ? 500 : 8000
}

/** Errors that mean "wait and retry this same step", not "the step failed". */
const MACRO_RETRYABLE = new Set(['action_pending', 'cooldown', 'in_transit', 'rate_limited', 'action_in_progress'])

/** Read {credits, cargoUsed, cargoCapacity, systemId, docked} — local cache when available, else a get_status query. */
async function macroReadState(conn: GameConnection): Promise<{
  credits: number | null; cargoUsed: number | null; cargoCapacity: number | null
  systemId: string | null; docked: boolean; cargo: Array<{ item_id: string; quantity: number }>
}> {
  let gs: Record<string, unknown> | null = conn.getLocalState?.() ?? null
  if (!gs) {
    try {
      const resp = await conn.execute('get_status')
      const data = resp.structuredContent ?? resp.result
      if (data && typeof data === 'object') gs = data as Record<string, unknown>
    } catch { /* fall through with null */ }
  }
  const player = (gs?.player ?? {}) as Record<string, unknown>
  const ship = (gs?.ship ?? {}) as Record<string, unknown>
  const location = (gs?.location ?? {}) as Record<string, unknown>
  const cargoRaw = gs?.cargo
  const cargo: Array<{ item_id: string; quantity: number }> = Array.isArray(cargoRaw)
    ? (cargoRaw as Array<Record<string, unknown>>)
        .filter((c) => typeof c.item_id === 'string' || typeof c.item === 'string')
        .map((c) => ({ item_id: String(c.item_id ?? c.item), quantity: Number(c.quantity ?? 1) }))
    : []
  // cargo_used/capacity: numeric fields, or the "10/60" string some shapes use
  let used = typeof ship.cargo_used === 'number' ? ship.cargo_used : null
  let cap = typeof ship.cargo_capacity === 'number' ? ship.cargo_capacity : (typeof ship.max_cargo === 'number' ? ship.max_cargo : null)
  if ((used === null || cap === null) && typeof ship.cargo === 'string') {
    const m = /^(\d+)\/(\d+)/.exec(ship.cargo)
    if (m) { used = used ?? Number(m[1]); cap = cap ?? Number(m[2]) }
  }
  const systemId = (location.system_id ?? player.current_system ?? null) as string | null
  const docked = Boolean(location.docked_at) || player.docked === true || player.is_docked === true
  return {
    credits: typeof player.credits === 'number' ? player.credits : null,
    cargoUsed: used, cargoCapacity: cap, systemId: systemId ? String(systemId) : null, docked, cargo,
  }
}

/** Execute one game action inside a macro, retrying transient pacing errors a bounded number of times. */
async function macroAction(
  conn: GameConnection,
  command: string,
  args: Record<string, unknown> | undefined,
  maxRetries = 6,
): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> {
  for (let attempt = 0; ; attempt++) {
    const resp = await conn.execute(command, args)
    if (!resp.error) return { ok: true }
    if (MACRO_RETRYABLE.has(resp.error.code) && attempt < maxRetries) {
      await macroSleep(Math.max((resp.error.retry_after ?? 10) * 1000, 5000))
      continue
    }
    return { ok: false, errorCode: resp.error.code, errorMessage: resp.error.message }
  }
}

async function executeMacroTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    switch (name) {
      case 'mine_until_full': return await macroMineUntilFull(args, ctx)
      case 'goto_system': return await macroGotoSystem(args, ctx)
      case 'sell_cargo': return await macroSellCargo(args, ctx)
      default: return `Error: unknown macro tool ${name}`
    }
  } catch (err) {
    return `MACRO ERROR (${name}): ${err instanceof Error ? err.message : String(err)}. State may have partially changed — verify with get_status.`
  }
}

async function macroMineUntilFull(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const conn = ctx.connection
  // Bounds sized to fill a typical hold in ONE call: ~1 unit per ~10s tick means
  // a 70-slot hold needs ~70 mines / ~12 min (observed live: 30 mines stopped at 60/70).
  const maxMines = Math.min(Number(args.max_mines) || 80, 120)
  const stopPct = Math.min(Math.max(Number(args.stop_at_pct) || 100, 10), 100)
  const deadline = Date.now() + 15 * 60_000
  const start = await macroReadState(conn)
  if (start.cargoCapacity === null) return 'MACRO ABORT: could not read cargo capacity — run get_status and retry.'

  let mines = 0
  let noYieldStrikes = 0
  let stopReason = 'max_mines'
  let lastUsed = start.cargoUsed ?? 0

  while (mines < maxMines) {
    if (!conn.isConnected()) { stopReason = 'disconnected'; break }
    if (Date.now() > deadline) { stopReason = 'deadline (5min)'; break }
    const st = await macroReadState(conn)
    const used = st.cargoUsed ?? lastUsed
    if (st.cargoCapacity && used >= (st.cargoCapacity * stopPct) / 100) { stopReason = used >= st.cargoCapacity ? 'full' : `reached ${stopPct}%`; break }

    const act = await macroAction(conn, 'mine', undefined)
    mines++
    if (!act.ok) {
      stopReason = `error [${act.errorCode}] ${act.errorMessage ?? ''}`.trim()
      break
    }
    const after = await macroReadState(conn)
    const afterUsed = after.cargoUsed ?? used
    if (afterUsed <= used) {
      noYieldStrikes++
      if (noYieldStrikes >= 3) { stopReason = 'no yield 3x (depleted?)'; break }
    } else {
      noYieldStrikes = 0
    }
    lastUsed = afterUsed
    ctx.log('system', `mine_until_full: ${mines} mines, cargo ${afterUsed}/${after.cargoCapacity ?? '?'}`)
    await macroSleep(macroStepDelayMs(conn))
  }

  const end = await macroReadState(conn)
  const minedUnits = (end.cargoUsed ?? lastUsed) - (start.cargoUsed ?? 0)
  return `mine_until_full DONE: ${mines} mine actions, +${minedUnits} cargo units, cargo now ${end.cargoUsed ?? '?'}/${end.cargoCapacity ?? '?'}. Stopped: ${stopReason}.`
}

async function macroGotoSystem(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const conn = ctx.connection
  const target = String(args.target_system || '').toLowerCase().replace(/\s+/g, '_')
  if (!target) return 'MACRO ABORT: target_system is required.'
  const dockPoi = args.dock_at_poi ? String(args.dock_at_poi).toLowerCase().replace(/\s+/g, '_') : null
  // Hops take ~65s of game time each; 12 min covers the fleet's standard 8-10 hop
  // commutes in one call (observed live: 8 min split a 9-hop route into PARTIAL+resume).
  const deadline = Date.now() + 12 * 60_000

  const start = await macroReadState(conn)
  if (start.systemId === target) {
    if (!dockPoi) return `goto_system DONE: already in ${target}.`
  } else {
    // Plot the route
    const routeResp = await conn.execute('find_route', { target_system: target })
    const rc = (routeResp.structuredContent ?? routeResp.result) as Record<string, unknown> | undefined
    if (routeResp.error || !rc) return `MACRO ABORT: find_route failed${routeResp.error ? ` [${routeResp.error.code}]` : ''}. Check the system name with search_systems.`
    if (rc.found === false) return `MACRO ABORT: no route to ${target}: ${rc.message ?? 'unreachable'}.`
    const route = Array.isArray(rc.route) ? (rc.route as Array<Record<string, unknown>>) : []
    const hopIds = route
      .map((h) => String(h.system_id ?? h.id ?? h.system ?? ''))
      .filter((id) => id && id !== start.systemId)
    if (hopIds.length === 0) return `MACRO ABORT: route to ${target} had no parseable hops — jump manually.`
    if (hopIds.length > 25) return `MACRO ABORT: route is ${hopIds.length} hops (cap 25) — too far for one macro; refuel/plan waypoints.`
    const estFuel = Number(rc.estimated_fuel ?? hopIds.length)
    const fuelAvail = Number(rc.fuel_available ?? NaN)
    if (!Number.isNaN(fuelAvail) && estFuel > fuelAvail) {
      return `MACRO ABORT: route needs ~${estFuel} fuel but only ${fuelAvail} available. Refuel first (fuel exemption applies).`
    }

    // Undock if needed, then jump each hop
    if (start.docked) await macroAction(conn, 'undock', undefined)
    let hops = 0
    for (const hop of hopIds) {
      if (!conn.isConnected()) return `goto_system PARTIAL: disconnected after ${hops}/${hopIds.length} hops. Verify position with get_status.`
      if (Date.now() > deadline) return `goto_system PARTIAL: deadline (8min) after ${hops}/${hopIds.length} hops — re-run goto_system(target_system="${target}") to continue.`
      const act = await macroAction(conn, 'jump', { target_system: hop }, 12)
      if (!act.ok) {
        return `goto_system PARTIAL: jump to ${hop} failed [${act.errorCode}] ${act.errorMessage ?? ''} after ${hops}/${hopIds.length} hops. Verify position with get_status.`
      }
      hops++
      ctx.log('system', `goto_system: hop ${hops}/${hopIds.length} → ${hop}`)
      await macroSleep(macroStepDelayMs(conn))
    }
  }

  let dockNote = ''
  if (dockPoi) {
    const t = await macroAction(conn, 'travel', { target_poi: dockPoi }, 12)
    if (t.ok) {
      await macroSleep(macroStepDelayMs(conn))
      const d = await macroAction(conn, 'dock', undefined, 6)
      dockNote = d.ok
        ? ` Docked at ${dockPoi}.`
        : ` You are AT ${dockPoi} (travel complete — no further travel needed); dock skipped [${d.errorCode}]${d.errorCode === 'no_base' ? ' — this POI has no station, e.g. a belt: just start working it' : ''}.`
    } else {
      dockNote = ` Arrived but travel to ${dockPoi} failed [${t.errorCode}] ${t.errorMessage ?? ''}.`
    }
  }
  const end = await macroReadState(conn)
  return `goto_system DONE: now in ${end.systemId ?? '?'}.${dockNote} Credits ${end.credits ?? '?'}.`
}

// Devastator BoM lock list — sell_cargo refuses to sell these regardless of the
// caller's exclude list. Observed live: an agent passed exclude=[] with iron_ore
// aboard and the macro sold a locked item. Doctrine must not depend on LLM diligence.
const SELL_CARGO_ALWAYS_EXCLUDE = new Set([
  'shield_emitter', 'station_reactor_core', 'neutronium_ingot', 'hull_plating', 'fury_alloy',
  'targeting_computer', 'weapon_housing', 'durasteel_plate', 'weapon_core', 'weapon_battery',
  'capital_ship_frame', 'armor_plate', 'power_distribution_grid', 'reinforced_bulkhead',
  'crimson_siege_plating', 'crimson_ordnance_bay', 'railgun_capacitor', 'fury_crystal',
  'iron_ore', 'titanium_ore', 'titanium_alloy', 'steel_plate', 'fury_cannon',
  'piercing_railgun_ii', 'railgun_ii', 'mass_driver', 'crimson_berserker_plating', 'darksteel_armor',
  'reactive_armor_hardener', // required x1 by the live commission quote (2026-07-19) — was missing from the original 28
])

async function macroSellCargo(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const conn = ctx.connection
  const exclude = new Set(
    (Array.isArray(args.exclude) ? args.exclude : []).map((x) => String(x).toLowerCase()),
  )
  for (const locked of SELL_CARGO_ALWAYS_EXCLUDE) exclude.add(locked)
  const deadline = Date.now() + 3 * 60_000
  const start = await macroReadState(conn)
  if (!start.docked) return 'MACRO ABORT: not docked — dock at a station first.'
  if (start.cargo.length === 0) return 'sell_cargo DONE: cargo is empty, nothing to sell.'

  const sold: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  let prevCredits = start.credits
  for (const item of start.cargo.slice(0, 20)) {
    if (Date.now() > deadline) { failed.push('(deadline hit — remaining items not attempted)'); break }
    if (exclude.has(item.item_id.toLowerCase())) {
      const isBom = SELL_CARGO_ALWAYS_EXCLUDE.has(item.item_id.toLowerCase())
      skipped.push(`${item.item_id} x${item.quantity} (${isBom ? 'BoM-locked — never sellable via this macro' : 'excluded'})`)
      continue
    }
    const act = await macroAction(conn, 'sell', { item_id: item.item_id, quantity: item.quantity }, 3)
    if (!act.ok) {
      failed.push(`${item.item_id} x${item.quantity} [${act.errorCode}]`)
    } else {
      // A no-error response is NOT proof of a fill (observed live: "sold" with
      // zero buyers and unchanged cargo). Verify the units actually left.
      const after = await macroReadState(conn)
      const remaining = after.cargo.find((c) => c.item_id === item.item_id)?.quantity ?? 0
      if (remaining < item.quantity) {
        const soldQty = item.quantity - remaining
        sold.push(`${item.item_id} x${soldQty}${remaining > 0 ? ` (${remaining} unsold)` : ''}`)
        // Book the sale in the financial ledger — macro sells bypass the normal
        // per-command booking path in executeTool (observed: a +35K macro sale
        // left no cashflow/transaction rows). Amount = verified credit delta.
        const delta = after.credits !== null && prevCredits !== null ? after.credits - prevCredits : null
        if (delta !== null && delta > 0) {
          try {
            LedgerCollector.processCommandResult('sell', {
              action: 'sell', item_id: item.item_id, quantity_sold: soldQty,
              total_earned: delta, credits: after.credits,
            }, ctx.profileId, ctx.profileName)
          } catch { /* ledger must never break the macro */ }
        }
        prevCredits = after.credits ?? prevCredits
      } else {
        failed.push(`${item.item_id} x${item.quantity} [no buyers — cargo unchanged]`)
      }
    }
    await macroSleep(macroStepDelayMs(conn))
  }
  const end = await macroReadState(conn)
  const gained = end.credits !== null && start.credits !== null ? end.credits - start.credits : null
  return [
    `sell_cargo DONE${gained !== null ? `: +${gained.toLocaleString()} cr` : ''}. Wallet ${end.credits?.toLocaleString() ?? '?'} cr.`,
    sold.length ? `Sold: ${sold.join(', ')}` : 'Sold: nothing',
    skipped.length ? `Skipped (excluded): ${skipped.join(', ')}` : '',
    failed.length ? `Not sold: ${failed.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

function truncateResult(text: string): string {
  return safeTruncate(text, MAX_RESULT_CHARS, '\n\n... (truncated)')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return safeTruncate(text, max - 3, '...')
}

const REDACTED_KEYS = new Set(['password', 'token', 'secret', 'api_key'])

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (REDACTED_KEYS.has(key)) { parts.push(`${key}=XXX`); continue }
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    const t = str.length > 60 ? str.slice(0, 57) + '...' : str
    parts.push(`${key}=${t}`)
  }
  return parts.join(' ')
}

function formatToolResult(name: string, result: unknown, notifications?: unknown[]): string {
  const parts: string[] = []
  if (notifications && Array.isArray(notifications) && notifications.length > 0) {
    parts.push('Notifications:')
    for (const n of notifications) {
      const parsed = parseNotification(n)
      if (parsed) parts.push(`  > [${parsed.tag}] ${parsed.text}`)
    }
    parts.push('')
  }
  if (typeof result === 'string') {
    parts.push(result)
  } else {
    parts.push(jsonToYaml(result))
  }
  return parts.join('\n')
}

function parseNotification(n: unknown): { tag: string; text: string } | null {
  if (typeof n === 'string') return { tag: 'EVENT', text: n }
  if (typeof n !== 'object' || n === null) return null

  const notif = n as Record<string, unknown>
  const type = notif.type as string | undefined
  const msgType = notif.msg_type as string | undefined
  let data = notif.data as Record<string, unknown> | string | undefined

  if (typeof data === 'string') {
    try { data = JSON.parse(data) as Record<string, unknown> } catch { /* leave as string */ }
  }

  if (msgType === 'chat_message' && data && typeof data === 'object') {
    const channel = (data.channel as string) || '?'
    const sender = (data.sender as string) || 'Unknown'
    const content = (data.content as string) || ''
    if (sender === '[ADMIN]') return { tag: 'BROADCAST', text: content }
    if (channel === 'private') return { tag: `DM from ${sender}`, text: content }
    return { tag: `CHAT ${channel.toUpperCase()}`, text: `${sender}: ${content}` }
  }

  const tag = (type || msgType || 'EVENT').toUpperCase()
  let message: string
  if (data && typeof data === 'object') {
    message = (data.message as string) || (data.content as string) || JSON.stringify(data)
  } else if (typeof data === 'string') {
    message = data
  } else {
    message = (notif.message as string) || JSON.stringify(n)
  }
  return { tag, text: message }
}

function jsonToYaml(value: unknown, indent: number = 0): string {
  const pad = '  '.repeat(indent)

  if (value === null || value === undefined) return `${pad}~`
  if (typeof value === 'boolean') return `${pad}${value}`
  if (typeof value === 'number') return `${pad}${value}`
  if (typeof value === 'string') {
    if (
      value === '' || value === 'true' || value === 'false' ||
      value === 'null' || value === '~' ||
      value.includes('\n') || value.includes(': ') ||
      value.startsWith('{') || value.startsWith('[') ||
      value.startsWith("'") || value.startsWith('"') ||
      value.startsWith('#') || /^[\d.e+-]+$/i.test(value)
    ) {
      return `${pad}"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    }
    return `${pad}${value}`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    if (value.every(v => v === null || typeof v !== 'object')) {
      const items = value.map(v => {
        if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`
        return String(v ?? '~')
      })
      const oneLine = `${pad}[${items.join(', ')}]`
      if (oneLine.length < 120) return oneLine
    }
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      } else {
        lines.push(`${pad}- ${jsonToYaml(item, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return `${pad}{}`
    const lines: string[] = []
    for (const [key, val] of entries) {
      if (val !== null && typeof val === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(jsonToYaml(val, indent + 1))
      } else {
        lines.push(`${pad}${key}: ${jsonToYaml(val, 0).trimStart()}`)
      }
    }
    return lines.join('\n')
  }

  return `${pad}${String(value)}`
}
