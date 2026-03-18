import type { Context, Message } from '@mariozechner/pi-ai'
import type { GameConnection, CommandResult } from './connections/interface'
import type { LogFn } from './tools'
import type { Profile } from '../../shared/types'
import { HttpConnection } from './connections/http'
import { HttpV2Connection } from './connections/http_v2'
import { WebSocketConnection } from './connections/websocket'
import { McpConnection } from './connections/mcp'
import { McpV2Connection } from './connections/mcp_v2'
import { resolveModel, resolveApiKey } from './model'
import { fetchGameCommands, formatCommandList } from './schema'
import { allTools, memoryDirtyFlags, ACTION_PENDING_SENTINEL } from './tools'
import { runAgentTurn, type CompactionState } from './loop'
import { addLogEntry, getProfile, updateProfile, getPreference, getFleetOrders, listProfiles } from './db'
import { FleetIntelCollector } from './fleet-intel'
import { startBriefingCollector, stopBriefingCollector, clearBriefingCache, buildSituationalBriefing } from './briefing'
import { checkEventTriggers } from './event-watcher'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'

const TURN_INTERVAL = 2000
const PROMPT_PATH = path.join(process.cwd(), 'prompt.md')

let _promptMd: string | null = null
function getPromptMd(): string {
  if (_promptMd) return _promptMd
  try {
    _promptMd = fs.readFileSync(PROMPT_PATH, 'utf-8')
  } catch {
    _promptMd = '(No prompt.md found)'
  }
  return _promptMd
}

export class Agent {
  readonly profileId: string
  readonly events = new EventEmitter()
  private connection: GameConnection | null = null
  private running = false
  private abortController: AbortController | null = null
  private restartRequested = false
  private pendingNudges: string[] = []
  private _activity: string = 'idle'
  private _gameState: Record<string, unknown> | null = null
  private _sessionExpired = false

  constructor(profileId: string) {
    this.profileId = profileId
  }

  get isConnected(): boolean {
    return this.connection?.isConnected() ?? false
  }

  get isRunning(): boolean {
    return this.running
  }

  get activity(): string {
    return this._activity
  }

  get gameState(): Record<string, unknown> | null {
    return this._gameState
  }

  get sessionExpired(): boolean {
    return this._sessionExpired
  }

  private setActivity(activity: string) {
    this._activity = activity
    this.events.emit('activity', activity)
  }

  private _cachedFactionId: string | null = null

  private cacheGameState(result: CommandResult): void {
    const data = result.structuredContent ?? result.result
    if (data && typeof data === 'object' && ('player' in data || 'ship' in data || 'location' in data)) {
      this._gameState = data as Record<string, unknown>
      this.enrichFactionInfo()
    }
  }

  private enrichFactionInfo(): void {
    const player = this._gameState?.player as Record<string, unknown> | undefined
    if (!player) return
    const factionId = player.faction_id as string | undefined
    if (!factionId) {
      this._cachedFactionId = null
      return
    }
    // Already enriched for this faction
    if (factionId === this._cachedFactionId && player._faction_name) return
    // Fetch faction_info in background to get name/tag
    this.connection?.execute('faction_info').then(resp => {
      const info = resp.structuredContent ?? resp.result
      if (info && typeof info === 'object') {
        const fi = info as Record<string, unknown>
        // Inject into cached player data
        const p = this._gameState?.player as Record<string, unknown> | undefined
        if (p) {
          p._faction_name = fi.name || null
          p._faction_tag = fi.tag || null
          this._cachedFactionId = factionId
        }
      }
    }).catch(() => {})
  }

  private log: LogFn = (type, summary, detail?) => {
    const id = addLogEntry(this.profileId, type, summary, detail)
    this.events.emit('log', { id, profile_id: this.profileId, type, summary, detail, timestamp: new Date().toISOString() })
  }

  async connect(): Promise<void> {
    const profile = getProfile(this.profileId)
    if (!profile) throw new Error('Profile not found')

    this.setActivity('Connecting...')
    this.log('connection', `Connecting via ${profile.connection_mode}...`)

    this.connection = createConnection(profile)

    // Wire up spec log for connections that fetch OpenAPI specs
    if (this.connection instanceof HttpV2Connection) {
      this.connection.setSpecLog((type, msg) => {
        this.log(type === 'error' ? 'error' : 'system', msg)
      })
    }

    try {
      await this.connection.connect()
      this.setActivity('idle')
      this.log('connection', `Connected via ${profile.connection_mode}`)
    } catch (err) {
      this.setActivity('idle')
      this.log('error', `Connection failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }

    // Set up notification handler
    this.connection.onNotification((n) => {
      this.log('notification', formatNotificationSummary(n), JSON.stringify(n, null, 2))
      // Check event triggers (fire-and-forget)
      checkEventTriggers(this.profileId, n as Record<string, unknown>).catch(() => {})
    })

    // Login if credentials exist
    if (profile.username && profile.password) {
      this.log('connection', `Logging in as ${profile.username}...`)
      const result = await this.connection.login(profile.username, profile.password)
      if (result.success) {
        this.log('connection', `Logged in as ${profile.username}`)
      } else {
        this.log('error', `Login failed: ${result.error}`)
      }
    }

    // Fetch initial game state (best-effort)
    try {
      const statusResp = await this.connection.execute('get_status')
      this.cacheGameState(statusResp)
    } catch { /* ignore */ }

    // Start background briefing data collector (zero-token game state caching)
    startBriefingCollector(this.profileId, this.connection)
  }

  async startLLMLoop(): Promise<void> {
    const profile = getProfile(this.profileId)
    if (!profile) throw new Error('Profile not found')
    if (!profile.provider || !profile.model) throw new Error('No LLM provider/model configured')
    if (!this.connection) throw new Error('Not connected')

    this.running = true
    this._sessionExpired = false
    this.abortController = new AbortController()

    this.log('system', `Starting LLM loop with ${profile.provider}/${profile.model}`)

    const { model } = await resolveModel(`${profile.provider}/${profile.model}`)

    // Resolve planner model if dual-model is configured
    let plannerResolved: { model: typeof model } | null = null
    const hasDualModel = !!(profile.planner_model)
    if (hasDualModel) {
      const pp = profile.planner_provider || profile.provider
      plannerResolved = await resolveModel(`${pp}/${profile.planner_model}`)
      this.log('system', `Dual-model: planner=${pp}/${profile.planner_model}, executor=${profile.provider}/${profile.model}, every ${profile.planning_interval ?? 5} turns`)
    }

    // Fetch game commands - MCP v2 uses tool discovery, others use OpenAPI
    const specLog = (type: 'info' | 'warn' | 'error', msg: string) => {
      this.log(type === 'error' ? 'error' : 'system', msg)
    }
    let commandList: string
    if (profile.connection_mode === 'mcp_v2' && this.connection instanceof McpV2Connection) {
      commandList = this.connection.getCommandList()
      this.log('system', `Discovered ${this.connection.toolCount} v2 commands`)
    } else {
      const serverUrl = profile.server_url.replace(/\/$/, '')
      const apiVersion = profile.connection_mode === 'http_v2' ? 'v2' : 'v1'
      const commands = await fetchGameCommands(`${serverUrl}/api/${apiVersion}`, specLog)
      commandList = formatCommandList(commands)
      this.log('system', `Loaded ${commands.length} game commands`)
    }

    // Build initial context
    const initialPhase = hasDualModel ? 'planning' as const : undefined
    const systemPrompt = buildSystemPrompt(profile, commandList, initialPhase, this.profileId)
    const context: Context = {
      systemPrompt,
      messages: [{
        role: 'user' as const,
        content: `Begin your mission: ${profile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'}`,
        timestamp: Date.now(),
      }],
      tools: allTools,
    }

    const compaction: CompactionState = { summary: '' }
    const todo = { value: profile.todo || '' }
    const memory = { value: profile.memory || '' }
    const planningInterval = profile.planning_interval ?? 5
    let turnCounter = 0
    const sessionStartedAt = Date.now()

    // System prompt cache — avoid rebuilding every turn when inputs haven't changed
    let cachedPrompt = systemPrompt
    let cachedPromptPhase: 'planning' | 'executing' | undefined = initialPhase
    let cachedPromptDirective = profile.directive || ''
    let cachedPromptMemory = profile.memory || ''

    while (this.running) {
      // Check session duration limit
      const maxSessionStr = getPreference('max_session_hours')
      if (maxSessionStr) {
        const maxHours = parseFloat(maxSessionStr)
        if (maxHours > 0 && (Date.now() - sessionStartedAt) > maxHours * 3600_000) {
          this.log('system', `Session duration limit reached (${maxHours}h). Stopping agent.`)
          this._sessionExpired = true
          break
        }
      }
      // Reset abort controller if it was used (e.g. by a nudge wakeup)
      if (this.abortController.signal.aborted) {
        this.abortController = new AbortController()
      }

      // Handle restart request (directive changed)
      if (this.restartRequested) {
        this.restartRequested = false
        this.abortController = new AbortController()

        const freshProfile = getProfile(this.profileId)
        if (freshProfile) {
          context.systemPrompt = buildSystemPrompt(freshProfile, commandList, undefined, this.profileId)
          const directive = freshProfile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'
          context.messages.push({
            role: 'user' as const,
            content: `## Directive Updated\nYour mission has changed. New directive: ${directive}\n\nAdjust your strategy and actions to follow this new directive immediately.`,
            timestamp: Date.now(),
          })
          this.log('system', `Directive updated, restarting turn: ${directive}`)
        }
      }

      try {
        const maxTurnsStr = getPreference('max_turns')
        const maxToolRounds = maxTurnsStr ? parseInt(maxTurnsStr, 10) || undefined : undefined
        const llmTimeoutStr = getPreference('llm_timeout')
        const llmTimeoutMs = llmTimeoutStr ? parseInt(llmTimeoutStr, 10) * 1000 || undefined : undefined
        const freshForBudget = getProfile(this.profileId)
        const contextBudgetRatio = freshForBudget?.context_budget ?? undefined

        // Dual-model phase selection
        const isPlanningTurn = hasDualModel && plannerResolved && (turnCounter % planningInterval === 0)
        const turnModel = isPlanningTurn ? plannerResolved!.model : model
        // Re-resolve API key each turn for OAuth providers (tokens expire)
        const turnProvider = isPlanningTurn ? (profile.planner_provider || profile.provider) : profile.provider
        const turnApiKey = await resolveApiKey(turnProvider!)
        const phasePrefix = isPlanningTurn ? '[Planning] ' : (hasDualModel ? '[Executing] ' : '')

        // Planning turns get fewer tool rounds — Opus should set strategy, not do exhaustive research
        const PLANNING_MAX_TOOL_ROUNDS = 10
        const turnMaxToolRounds = isPlanningTurn
          ? Math.min(maxToolRounds ?? PLANNING_MAX_TOOL_ROUNDS, PLANNING_MAX_TOOL_ROUNDS)
          : maxToolRounds

        this.setActivity(`${phasePrefix}Waiting for LLM response...`)
        await runAgentTurn(
          turnModel, context, this.connection, this.profileId, profile.name,
          this.log, todo, memory,
          {
            signal: this.abortController.signal, apiKey: turnApiKey, maxToolRounds: turnMaxToolRounds, llmTimeoutMs,
            maxTokens: isPlanningTurn ? 4096 : 2048,
            contextBudgetRatio,
            onActivity: (a) => this.setActivity(`${phasePrefix}${a}`),
            compactionModel: hasDualModel ? model : undefined,  // Always use executor for compaction
          },
          compaction,
        )
        turnCounter++
      } catch (err) {
        if (!this.running) break
        if (this.restartRequested) continue
        this.log('error', `Turn error: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (!this.running) break
      if (this.restartRequested) continue
      this.setActivity('Sleeping between turns...')
      await abortableSleep(TURN_INTERVAL, this.abortController.signal)
      if (!this.running) break
      if (this.restartRequested) continue

      // Poll for events between turns (skip for push-capable connections — they get notifications via onNotification)
      let pendingEvents = ''
      if (!this.connection.supportsNotifications()) {
        this.setActivity('Polling for events...')
        try {
          const pollResp = await this.connection.execute('get_status')
          this.cacheGameState(pollResp)
          if (pollResp.notifications && Array.isArray(pollResp.notifications) && pollResp.notifications.length > 0) {
            pendingEvents = pollResp.notifications
              .map(n => {
                const s = formatNotificationSummary(n)
                return `  > ${s}`
              })
              .join('\n')
          }
        } catch {
          // Best-effort
        }
      }

      const nudgeParts: string[] = []
      if (pendingEvents) nudgeParts.push('## Events Since Last Action\n' + pendingEvents + '\n')

      // Drain any human nudges
      if (this.pendingNudges.length > 0) {
        const nudges = this.pendingNudges.splice(0)
        for (const n of nudges) {
          nudgeParts.push(`## Human Nudge\nYour human operator has sent you guidance: ${n}\nTake this into account for your next actions.\n`)
          this.log('system', `Nudge delivered: ${n.slice(0, 100)}`)
        }
      }

      nudgeParts.push('Continue your mission.')

      context.messages.push({
        role: 'user' as const,
        content: nudgeParts.join('\n'),
        timestamp: Date.now(),
      })

      // Refresh system prompt only when inputs have changed (memory, phase, directive)
      const freshProfile = getProfile(this.profileId)
      if (freshProfile) {
        const nextIsPlanningTurn = hasDualModel && plannerResolved && (turnCounter % planningInterval === 0)
        const phase = hasDualModel ? (nextIsPlanningTurn ? 'planning' as const : 'executing' as const) : undefined
        const currentDirective = freshProfile.directive || ''
        const currentMemory = freshProfile.memory || ''
        const memoryDirty = memoryDirtyFlags.get(this.profileId) ?? false

        const briefingEnabled = getPreference('situational_briefing') !== 'off'
        if (briefingEnabled || phase !== cachedPromptPhase || currentDirective !== cachedPromptDirective || memoryDirty || currentMemory !== cachedPromptMemory) {
          cachedPrompt = buildSystemPrompt(freshProfile, commandList, phase, this.profileId)
          cachedPromptPhase = phase
          cachedPromptDirective = currentDirective
          cachedPromptMemory = currentMemory
          memoryDirtyFlags.delete(this.profileId)
        }
        context.systemPrompt = cachedPrompt
      }
    }

    this.running = false
    this.setActivity('idle')
    this.log('system', 'Agent loop stopped')
  }

  async executeCommand(command: string, args?: Record<string, unknown>, options?: { silent?: boolean }): Promise<CommandResult> {
    if (!this.connection) {
      return { error: { code: 'not_connected', message: 'Not connected' } }
    }

    if (!options?.silent) {
      this.log('tool_call', `manual: ${command}(${args ? JSON.stringify(args) : ''})`)
    }
    const result = await this.connection.execute(command, args)

    if (command === 'get_status') this.cacheGameState(result)

    if (!options?.silent) {
      if (result.error) {
        this.log('tool_result', `Error: ${result.error.message}`, JSON.stringify(result, null, 2))
      } else {
        const summary = typeof result.result === 'string'
          ? result.result.slice(0, 200)
          : JSON.stringify(result.result).slice(0, 200)
        this.log('tool_result', summary, JSON.stringify(result, null, 2))
      }
    }

    return result
  }

  /** Abort current turn and restart the loop with the updated directive. */
  restartTurn(): void {
    if (!this.running) return
    this.restartRequested = true
    this.abortController?.abort()
  }

  /** Inject a nudge message into the agent's context for the next turn. */
  injectNudge(message: string): void {
    this.pendingNudges.push(message)
    // Wake the agent from sleep so it picks up the nudge quickly
    this.abortController?.abort()
  }

  async stop(): Promise<void> {
    this.running = false
    this.abortController?.abort()
    clearBriefingCache(this.profileId)
    if (this.connection) {
      this.log('connection', 'Disconnecting...')
      await this.connection.disconnect()
      this.connection = null
      this.log('connection', 'Disconnected')
    }
  }
}

function createConnection(profile: Profile): GameConnection {
  switch (profile.connection_mode) {
    case 'websocket':
      return new WebSocketConnection(profile.server_url)
    case 'mcp':
      return new McpConnection(profile.server_url)
    case 'mcp_v2':
      return new McpV2Connection(profile.server_url)
    case 'http_v2':
      return new HttpV2Connection(profile.server_url)
    case 'http':
    default:
      return new HttpConnection(profile.server_url)
  }
}

function buildSystemPrompt(profile: Profile, commandList: string, phase?: 'planning' | 'executing', profileId?: string): string {
  const promptMd = getPromptMd()
  const directive = profile.directive || 'Play the game. Mine ore, sell it, and grow stronger.'
  const connectionMode = profile.connection_mode
  const apiVersion = connectionMode === 'http_v2' || connectionMode === 'mcp_v2' ? 'v2'
    : connectionMode === 'http' ? 'v1'
    : connectionMode === 'websocket' ? 'ws'
    : connectionMode === 'mcp' ? 'mcp-v1'
    : 'unknown'

  let credentials: string
  if (profile.username && profile.password) {
    credentials = [
      `- Username: ${profile.username}`,
      `- Password: ${profile.password}`,
      `- Empire: ${profile.empire}`,
      `- Player ID: ${profile.player_id}`,
      '',
      'You are already logged in. Start playing immediately.',
    ].join('\n')
  } else {
    const regCode = getPreference('registration_code')
    const regCodeLine = regCode ? `\nUse registration code: ${regCode} when registering.` : ''
    credentials = `New player -- you need to register first. Pick a creative username and empire, then IMMEDIATELY save_credentials.${regCodeLine}`
  }

  return `You are an autonomous AI agent playing SpaceMolt, a text-based space MMO.

## Your Mission
${directive}

## Game Knowledge
${promptMd}

## Your Credentials
${credentials}

## Active Connection
- Mode: ${connectionMode}
- API/Protocol: ${apiVersion}
- Use command names exactly as shown in "Available Game Commands" for this profile.

## Agent Memory
${profile.memory || '(No memory stored yet. Use update_memory to save important information.)'}

${(() => {
  try {
    const briefing = FleetIntelCollector.buildBriefing(profile.username || undefined)
    return briefing ? `## Fleet Intelligence Briefing\nShared intel from all Admiral agents:\n${briefing}\n` : ''
  } catch { return '' }
})()}${(() => {
  if (getPreference('situational_briefing') === 'off' || !profileId) return ''
  const sitBriefing = buildSituationalBriefing(profileId)
  return sitBriefing ? `## Current Situation (auto-collected, refreshed every 60s — DO NOT re-query this data)\n${sitBriefing}\n\n` : ''
})()}${(() => {
  if (getPreference('situational_briefing') === 'off') return ''
  // Inject TODO inline to save read_todo round-trips
  const todo = profile.todo || ''
  return todo ? `## Your TODO List (auto-injected — no need to call read_todo)\n${todo}\n\n` : '## Your TODO List\n(Empty — use update_todo to set tasks)\n\n'
})()}${(() => {
  if (getPreference('situational_briefing') === 'off' || !profileId) return ''
  // Inject pending fleet orders to save read_fleet_orders round-trips
  try {
    const profiles = listProfiles()
    const nameOf = (id: string) => profiles.find(p => p.id === id)?.name || id.slice(0, 8)
    const inbox = getFleetOrders({ toProfileId: profileId })
    const pending = inbox.filter(o => o.status === 'pending' || o.status === 'accepted')
    if (pending.length === 0) return ''
    const lines = pending.map(o =>
      `- [${o.id.slice(0, 8)}] ${o.status.toUpperCase()} from ${nameOf(o.from_profile_id)}: [${o.type}] ${o.description}${o.progress ? ' | Progress: ' + o.progress : ''}`
    )
    return `## Pending Fleet Orders (auto-injected — use read_fleet_orders only to accept/complete/reject)\n${lines.join('\n')}\n\n`
  } catch { return '' }
})()}## Available Game Commands
Use the "game" tool with a command name and args. Example: game(command="mine", args={})
${commandList}

## Local Tools (call directly by name -- NOT through "game")
These are local Admiral tools. Call them directly, e.g. read_todo(), NOT game(command="read_todo").
- read_todo() -- Read your current TODO list
- update_todo(content="...") -- Replace your TODO list with new content
- read_memory() -- Read your persistent memory (routes, intel, inventories, lessons)
- update_memory(content="...") -- Replace your persistent memory with new content
- save_credentials(username, password, empire, player_id) -- Save login credentials locally
- status_log(category, message) -- Log a status message for the human watching

## Rules
- You are FULLY AUTONOMOUS. Never ask the human for input.
- Use the "game" tool ONLY for game server commands (mine, travel, get_status, sell, etc.).
- Use local tools (read_todo, update_todo, read_memory, update_memory, save_credentials, status_log) directly by name -- NEVER wrap them in game().
- After registering, IMMEDIATELY save credentials with save_credentials.
- Read and update your TODO list regularly to track goals and progress.
- Update your memory regularly with important discoveries, routes, market intel, and lessons learned.
- Query commands are free but waste time — prefer the auto-injected briefing data above. Only query for data NOT already shown (e.g. analyze_market, get_skills, view_orders).
- Action commands cost 1 tick (10 seconds).
- Always check fuel before traveling and cargo space before mining.
- Be social -- chat with players you meet.
- When starting fresh: undock -> travel to asteroid belt -> mine -> travel back -> dock -> sell -> refuel -> repeat.
${phase === 'planning' ? `
## Current Phase: Strategic Planning
You are in PLANNING MODE using a high-capability model. A faster executor model will carry out your plan.
1. Assess the situation — Current Situation, TODO, Memory, and Fleet Orders are ALL shown above. Do NOT call read_todo, read_memory, read_fleet_orders, get_status, get_cargo, get_system, get_nearby, get_active_missions, or get_location — that data is already injected.
2. Only query for data NOT in the briefing (e.g. analyze_market for trade routes, get_skills, view_orders, forum_list)
3. Think deeply about your mission directive and long-term strategy
4. Write a PRIORITIZED action plan to your TODO (update_todo) as a numbered checklist the executor can follow step-by-step
5. Update your memory with strategic observations (update_memory)
6. Do NOT execute action commands (mine, travel, sell, buy, dock, undock, jump, craft, attack) — save those for execution turns
` : phase === 'executing' ? `
## Current Phase: Execution
You are in EXECUTION MODE — act quickly and decisively. A strategic planner periodically updates your TODO with the plan.
- Your TODO is shown above — follow it step-by-step. Do NOT call read_todo (it's already injected).
- Your memory is shown above — do NOT call read_memory (it's already injected).
- Your situation (location, wallet, cargo, missions) is shown above — do NOT call get_status, get_cargo, get_system, get_nearby, get_active_missions, or get_location (already injected, refreshed every 60s).
- Fleet orders are shown above if any — use read_fleet_orders ONLY to accept/complete/reject, not to check inbox.
- Execute the next unchecked action, then update the TODO to mark it done (update_todo)
- If the TODO is empty or fully complete, take sensible default actions aligned with your directive
- Don't overthink — the planner will handle strategy next cycle
` : ''}`
}

function formatNotificationSummary(n: unknown): string {
  if (typeof n === 'string') return n
  if (typeof n !== 'object' || n === null) return JSON.stringify(n)

  const notif = n as Record<string, unknown>
  const type = (notif.type as string) || (notif.msg_type as string) || 'event'
  let data = notif.data as Record<string, unknown> | string | undefined
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { /* leave as string */ }
  }

  if (data && typeof data === 'object') {
    const msg = (data.message as string) || (data.content as string)
    if (msg) return `[${type.toUpperCase()}] ${msg}`
  }

  return `[${type.toUpperCase()}] ${JSON.stringify(n).slice(0, 200)}`
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
