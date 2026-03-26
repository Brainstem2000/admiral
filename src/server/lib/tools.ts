import { Type, StringEnum } from '@mariozechner/pi-ai'
import type { Tool } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import { updateProfile, createFleetOrder, getFleetOrders, getFleetOrdersByChain, updateFleetOrder, listProfiles, getPreference } from './db'
import { FleetIntelCollector } from './fleet-intel'
import { agentManager } from './agent-manager'
import { buildSituationalBriefing, invalidateBriefingCache } from './briefing'

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

const MAX_RESULT_CHARS = 4000

// Cooldown tracking for action commands to prevent spam loops (e.g. mine → "Action pending" → mine → ...)
// Maps profileId → last action timestamp + whether it was pending
const actionCooldowns = new Map<string, { timestamp: number; wasPending: boolean }>()
const COOLDOWN_AFTER_SUCCESS = 4000   // 4s between actions when last succeeded (allows fast successive actions)
const COOLDOWN_AFTER_PENDING = 10000  // 10s when last action was pending (match game tick cadence)

// Track when memory is updated so system prompt caching can skip rebuilds
export const memoryDirtyFlags = new Map<string, boolean>()

// Sentinel prefix for action pending results — loop.ts detects this to exit the turn early
export const ACTION_PENDING_SENTINEL = '⚠️ ACTION_PENDING: '

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

  let command: string
  let commandArgs: Record<string, unknown> | undefined
  if (name === 'game') {
    command = String(args.command || '')
    commandArgs = args.args as Record<string, unknown> | undefined
    if (!command) return 'Error: missing \'command\' argument'
  } else {
    command = name
    commandArgs = Object.keys(args).length > 0 ? args : undefined
  }

  // Auto-correct common parameter mistakes to reduce wasted API calls
  if (commandArgs) {
    const bare = command.replace(/^spacemolt_/, '')
    // travel uses target_poi, not destination/target_system
    if ((bare === 'travel' || bare.endsWith('_travel')) && !commandArgs.target_poi) {
      if (commandArgs.destination) { commandArgs.target_poi = commandArgs.destination; delete commandArgs.destination }
      else if (commandArgs.target_system) { commandArgs.target_poi = commandArgs.target_system; delete commandArgs.target_system }
    }
    // jump uses target_system, not destination/target_poi
    if ((bare === 'jump' || bare.endsWith('_jump')) && !commandArgs.target_system) {
      if (commandArgs.destination) { commandArgs.target_system = commandArgs.destination; delete commandArgs.destination }
    }
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
        return `⏳ ACTION BLOCKED — cooldown active (${waitSec}s remaining). Game actions cost 1 tick (~10s). You just performed an action. Use query commands (get_status, get_cargo, view_market, read_todo, etc.) while waiting, or STOP calling tools and end your turn.`
      }
    }
    actionCooldowns.set(ctx.profileId, { timestamp: Date.now(), wasPending: false })
  }

  // Cache intercept: if briefing is enabled and this is a query already covered by the briefing,
  // return cached data instead of hitting the game server. Saves network round-trip + output tokens.
  // Feature flag: disabled when situational_briefing = 'off'
  if (isQuery && getPreference('situational_briefing') !== 'off') {
    const BRIEFING_COVERED_QUERIES = new Set(['get_status', 'get_cargo', 'get_nearby', 'get_system', 'get_active_missions', 'get_ship', 'get_location'])
    if (BRIEFING_COVERED_QUERIES.has(deepBare)) {
      const briefing = buildSituationalBriefing(ctx.profileId)
      if (briefing) {
        ctx.log('tool_result', `(cached) ${truncate(briefing, 150)}`)
        return `(cached) ${briefing}`
      }
    }

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
      const errMsg = `Error: [${resp.error.code}] ${resp.error.message}`
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
      // Invalidate briefing cache — action changed game state
      invalidateBriefingCache(ctx.profileId)
      return truncateResult(pendingResult)
    }

    // Passively collect fleet intel from game results
    try {
      FleetIntelCollector.processCommandResult(command, resp.result, ctx.profileName)
      if (resp.notifications) FleetIntelCollector.processNotifications(resp.notifications, ctx.profileName)
    } catch { /* never break game execution */ }

    // After a successful action, invalidate the briefing cache so the next
    // query fetches live data instead of returning stale pre-action state.
    if (!isQuery) {
      invalidateBriefingCache(ctx.profileId)
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

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return text.slice(0, MAX_RESULT_CHARS) + '\n\n... (truncated)'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + '...'
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
