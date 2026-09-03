import { Account, ACTIONS, ClerkSource, GENERATED_SPEC_VERSION, SpacemoltError } from '@spacemolt/lib'
import type { AuthCredentials, WebSocketLike } from '@spacemolt/lib'
import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'
import { isCommandForRole, type AgentRole } from '../role'

/**
 * Connection backed by the official @spacemolt/lib WebSocket-v2 client.
 *
 * What the lib gives us over the hand-rolled modes:
 * - Auto-reconnect + re-auth on drops (login credentials re-used per reconnect),
 *   so the ~4h session-expiry mass-disconnects stop needing manual recovery.
 * - Mutations serialized one-in-flight per account with bounded rate_limited
 *   retries (default 5 — matches our bounded-retry invariant).
 * - A local state cache updated by every mutation delta and server push.
 * - Typed push events delivered without get_notifications polling.
 *
 * Command names: Admiral's tools layer speaks flat names (`get_status`,
 * `view_market`, `spacemolt_market_view_market`, ...). The lib speaks
 * (tool, action) pairs. We build a reverse index over the lib's ACTIONS
 * catalog using the same alias rules as HttpV2Connection so existing
 * directives/prompts keep working unchanged.
 */

/** Frame types that are internal protocol plumbing, not game notifications. */
const INTERNAL_FRAME_TYPES = new Set([
  'welcome', 'logged_in', 'registered', 'action_result', 'action_queued', 'error', 'pong',
])

/** Cap on remembered raw error frames — error frames are rare, so this only
 *  guards against a pathological stream of uncorrelated ones. */
const MAX_RAW_ERROR_FRAMES = 32

function truncateRaw(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

interface Route { tool: string; action: string; defaultArgs?: Record<string, unknown> }

/**
 * Collision priority for bare action names shared by several tools (e.g.
 * `withdraw` exists on storage AND citizenship — an agent saying `withdraw`
 * always means storage; a citizenship withdrawal must be called by its
 * qualified name). Lower index wins; unlisted tools come after, in catalog order.
 */
const TOOL_PRIORITY = ['spacemolt', 'spacemolt_storage', 'spacemolt_market', 'spacemolt_ship', 'spacemolt_battle', 'spacemolt_social']

/** v1 command names that no longer exist in the v2 catalog, mapped to their v2 form.
 *  NOTE: no target/source defaults — target="faction" requires a faction-BUILT storage
 *  facility, which Stellar Alliance owns nowhere (server rejects with no_faction_storage).
 *  The fleet's "Fleet Munitions Vault" convention is plain PERSONAL storage at
 *  Krynn/war_citadel — exactly what a bare deposit does. */
const LEGACY_ALIASES: Record<string, Route> = {
  deposit_items: { tool: 'spacemolt_storage', action: 'deposit' },
  withdraw_items: { tool: 'spacemolt_storage', action: 'withdraw' },
  faction_deposit_items: { tool: 'spacemolt_storage', action: 'deposit' },
  faction_withdraw_items: { tool: 'spacemolt_storage', action: 'withdraw' },
}

/**
 * Commands that exist on the live REST v1 server but have NO route in the lib's
 * generated WS catalog. They reach the game through executeViaRest(), so they
 * must also be advertised in getCommandList() — otherwise the LLM never learns
 * they exist and the fallback is dead code.
 *
 * Keep this list minimal and re-check it whenever @spacemolt/lib is upgraded: an
 * entry that gains a real WS route should be deleted (the route index wins, and
 * a stale line here would just duplicate it in the prompt).
 */
const REST_ONLY_COMMANDS: Array<{ name: string; params: string; summary: string }> = [
  {
    name: 'send_gift',
    params: 'recipient: string, item_id?: string, quantity?: number, credits?: number, ship_id?: string, source?: string, message?: string',
    summary:
      'Gift credits, items, or a ship to another player/empire/faction. recipient = username, player id, empire alias, or "faction:TAG". ' +
      'Provide EXACTLY ONE of item_id+quantity / credits / ship_id. source="storage" gifts items straight from your station storage (default "cargo"). ' +
      'Item and credit gifts require YOU to be docked at a base with storage service, but the recipient does NOT need to be online, docked, or anywhere near you — delivery is async. Ships transfer remotely from wherever they are parked.',
  },
]

/** Reverse index: flat command name -> (tool, action). Built once per process. */
let routeIndex: Map<string, Route> | null = null

function buildRouteIndex(): Map<string, Route> {
  if (routeIndex) return routeIndex
  const index = new Map<string, Route>()
  const set = (name: string, route: Route) => {
    if (!index.has(name)) index.set(name, route)
  }
  const rank = (tool: string) => {
    const i = TOOL_PRIORITY.indexOf(tool)
    return i === -1 ? TOOL_PRIORITY.length : i
  }
  const entries = Object.values(ACTIONS).sort((a, b) => rank(a.tool) - rank(b.tool))
  for (const def of entries) {
    const route: Route = { tool: def.tool, action: def.action }
    set(def.action, route)                       // v1-style short name (priority order wins collisions)
    set(`${def.tool}_${def.action}`, route)      // fully-qualified v2 name
    const toolShort = def.tool.startsWith('spacemolt_') ? def.tool.slice('spacemolt_'.length) : def.tool
    if (toolShort !== def.tool) {
      set(`${def.action}_${toolShort}`, route)   // e.g. join_faction
      set(`${toolShort}_${def.action}`, route)   // e.g. faction_join
    }
  }
  for (const [name, route] of Object.entries(LEGACY_ALIASES)) set(name, route)
  routeIndex = index
  return index
}

/**
 * True when a flat command name resolves to a real lib_v2 route.
 *
 * Callers rewriting a v2 GROUP form (`shipping` + {action}) to its flat name
 * must check this first: not every action has one. `shipping(action=accept)`
 * and `shipping(action=deliver)` both flatten to real routes, but
 * `shipping(action=active)` flattens to `shipping_active`, which does not
 * exist — and the group form it replaced worked fine.
 */
export function hasLibV2Route(name: string): boolean {
  return buildRouteIndex().has(name)
}

export class LibV2Connection implements GameConnection {
  readonly mode = 'lib_v2' as const
  private account: Account | null = null
  private wsUrl: string
  private httpBaseUrl: string
  private notificationHandlers: NotificationHandler[] = []
  /** Durable re-auth credentials: clerk (preferred — re-mints a fresh single-use
   *  WS token per reconnect, no password held) or raw login as fallback. */
  private authCreds: AuthCredentials | null = null
  /** Credits seen in the latest QUERY response (get_player/get_status). The lib's
   *  state cache only updates from the player's OWN mutation deltas, so credits
   *  received from another player (gifts, order fills) stay stale until the next
   *  own-mutation — which can be never for a docked crafter. Cleared whenever a
   *  mutation delta arrives, since that is authoritative and newer. */
  private queryCredits: number | null = null
  private connected = false
  private offAny: (() => void) | null = null
  /** Password-backed REST session for the v1 fallback (see executeViaRest).
   *  Clerk auth is WS-only — the REST API accepts an X-Session-Id obtained from
   *  POST /session + POST /login, so the fallback keeps its own session. */
  private restCreds: { username: string; password: string } | null = null
  private restSession: { id: string; expires_at?: string } | null = null
  private restSessionPromise: Promise<void> | null = null
  /** Raw error frames teed off the wire, keyed by request_id — see recoverMaskedError(). */
  private rawErrorFrames = new Map<string, string>()

  constructor(serverUrl: string) {
    this.httpBaseUrl = serverUrl.replace(/\/$/, '')
    this.wsUrl = this.httpBaseUrl.replace(/^http/, 'ws') + '/ws/v2'
  }

  async connect(): Promise<void> {
    this.account = new Account({
      url: this.wsUrl,
      reconnect: true,
      // Snooping transport: the lib's frame validator DISCARDS the payload of any
      // error frame that deviates from its pinned spec, leaving only "Malformed
      // action_error frame" — see recoverMaskedError() for the recovery path.
      webSocketFactory: (url) => this.snoopWebSocket(url),
      // Re-auth on reconnect with whatever credential login() established.
      credentials: () => {
        if (!this.authCreds) throw new Error('no credentials for re-auth')
        return this.authCreds
      },
    })
    await this.account.connect()
    this.offAny = this.account.onAny((frame) => {
      if (INTERNAL_FRAME_TYPES.has(frame.type)) return
      for (const handler of this.notificationHandlers) handler(frame)
    })
    this.connected = true
  }

  async login(username: string, password: string): Promise<LoginResult> {
    if (!this.account) return { success: false, error: 'not connected' }

    // Keep the password for the REST v1 fallback even when clerk auth wins below
    // — the fallback cannot use clerk credentials (WS-only).
    if (password) this.restCreds = { username, password }

    // Preferred path: a Clerk API key in the environment. The key mints a fresh
    // single-use WS token per (re)connect — no game password is used or stored
    // in memory. Falls back to raw login when the key is absent, the player
    // isn't owned by the key, or the clerk exchange fails.
    const apiKey = process.env.SPACEMOLT_CLERK_API_KEY
    if (apiKey) {
      try {
        const source = new ClerkSource({ httpBaseUrl: this.httpBaseUrl, apiKey })
        const { players } = await source.fetchRegistration()
        const match = players.find((p) => p.username.toLowerCase() === username.toLowerCase())
        if (match) {
          const creds: AuthCredentials = { kind: 'clerk', apiKey, playerId: match.id, httpBaseUrl: this.httpBaseUrl }
          await this.account.authenticate(creds)
          this.authCreds = creds
          return {
            success: true,
            player_id: match.id,
            session: (this.account.loginPayload ?? undefined) as unknown as Record<string, unknown>,
          }
        }
      } catch {
        // fall through to password login
      }
    }

    if (!password) return { success: false, error: 'clerk auth unavailable and no password set' }
    try {
      const payload = await this.account.login({ username, password })
      this.authCreds = { kind: 'login', username, password }
      const player = (payload as Record<string, unknown> | null)?.player as Record<string, unknown> | undefined
      return {
        success: true,
        player_id: (player?.id as string | undefined) ?? undefined,
        session: payload as unknown as Record<string, unknown>,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    if (!this.account) return { success: false, error: 'not connected' }
    try {
      const result = await this.account.register({ username, empire, registration_code: code })
      this.authCreds = { kind: 'login', username, password: result.password }
      this.restCreds = { username, password: result.password }
      // register() alone never sets the lib's `authenticated` flag, which gates
      // isConnected() and getLocalState() — a freshly registered agent played
      // fine but showed disconnected with no credits on the dashboard (Cass
      // Margin, 2026-07-21). Establish a real authenticated session now.
      try {
        await this.account.authenticate(this.authCreds)
      } catch { /* fall back to next reconnect's login path */ }
      return {
        success: true,
        username,
        password: result.password,
        player_id: result.player_id,
        empire,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    if (!this.account) {
      return { error: { code: 'connection_failed', message: 'Not connected' } }
    }
    const route = buildRouteIndex().get(command)
    if (!route) {
      // The lib's catalog is generated against a pinned spec that can lag the
      // live server (v0.547.0 lib vs v0.549.1 server as of 2026-07-31), so real
      // server commands can have no WS route at all — `send_gift` is the one
      // that matters: its absence took cross-agent credit/material transfer
      // down fleet-wide, since trade_offer needs both players at the same POI.
      // Fall back to the REST v1 endpoint before declaring the command unknown.
      if (this.restCreds) {
        const viaRest = await this.executeViaRest(command, args)
        if (viaRest) return viaRest
      }
      return {
        error: {
          code: 'unknown_command',
          message: `Unknown command "${command}" (lib spec ${GENERATED_SPEC_VERSION}). Use a command from the command list.`,
        },
      }
    }
    try {
      // send() routes query vs mutation from the catalog. Mutations are
      // serialized per account and rate_limited retries are bounded (5) inside
      // the lib; the await resolves when the action actually executes.
      const merged = route.defaultArgs ? { ...route.defaultArgs, ...(args ?? {}) } : args
      const resp = await this.account.send(route.tool, route.action, merged)
      if (resp && typeof resp === 'object' && 'delta' in resp) {
        // Own-mutation delta: the lib folds this into its state cache, which is
        // now fresher than any query-derived credits override.
        this.queryCredits = null
        // MutationResult: surface the tick + typed details to the LLM, and the
        // full state delta as structuredContent.
        const m = resp as { command: string; tick: number; delta: Record<string, unknown>; autoDocked?: boolean; autoUndocked?: boolean }
        const details = m.delta?.details
        return {
          result: {
            command: m.command,
            tick: m.tick,
            ...(details !== undefined ? { details } : {}),
            ...(m.autoDocked ? { autoDocked: true } : {}),
            ...(m.autoUndocked ? { autoUndocked: true } : {}),
          },
          structuredContent: m.delta,
        }
      }
      const q = resp as { result: unknown; structuredContent?: unknown }
      // Harvest credits from query responses (get_player, get_status, get_ship,
      // get_cargo all include them) so incoming transfers become visible.
      const scObj = q.structuredContent as Record<string, unknown> | undefined
      const credits =
        (scObj?.credits as number | undefined) ??
        ((scObj?.player as Record<string, unknown> | undefined)?.credits as number | undefined)
      if (typeof credits === 'number') this.queryCredits = credits
      return { result: q.result, structuredContent: q.structuredContent }
    } catch (err) {
      if (err instanceof SpacemoltError) {
        if (err.code === 'invalid_response') {
          const recovered = this.recoverMaskedError(err.message)
          if (recovered) return recovered
        }
        return { error: { code: err.code, message: err.message } }
      }
      return { error: { code: 'connection_failed', message: err instanceof Error ? err.message : String(err) } }
    }
  }

  /**
   * Minimal WebSocketLike over the runtime's native WebSocket that tees inbound
   * error frames into rawErrorFrames before the lib parses (and potentially
   * discards) them. Behavior is otherwise identical to the lib's own default
   * adapter; frames arrive as newline-delimited JSON lines.
   */
  private snoopWebSocket(url: string): WebSocketLike {
    const ws = new WebSocket(url)
    const record = (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data)
      if (!text.includes('error')) return // cheap pre-filter; error frames are rare
      for (const line of text.split('\n')) {
        if (!line || !line.includes('error')) continue
        try {
          const parsed = JSON.parse(line) as { type?: unknown; request_id?: unknown }
          if ((parsed.type === 'action_error' || parsed.type === 'error') && typeof parsed.request_id === 'string') {
            this.rawErrorFrames.set(parsed.request_id, line)
            while (this.rawErrorFrames.size > MAX_RAW_ERROR_FRAMES) {
              const oldest = this.rawErrorFrames.keys().next().value
              if (oldest === undefined) break
              this.rawErrorFrames.delete(oldest)
            }
          }
        } catch { /* unparseable line — the socket layer logs and drops it */ }
      }
    }
    return {
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      addEventListener: ((type: string, listener: (event?: unknown) => void) => {
        switch (type) {
          case 'open':
            ws.addEventListener('open', () => listener())
            break
          case 'message':
            ws.addEventListener('message', (event: MessageEvent) => {
              try { record(event.data) } catch { /* snooping must never break the transport */ }
              listener({ data: event.data })
            })
            break
          case 'close':
            ws.addEventListener('close', (event: CloseEvent) => listener({ code: event.code, reason: event.reason }))
            break
          case 'error':
            ws.addEventListener('error', (event: Event) => listener(event))
            break
        }
      }) as WebSocketLike['addEventListener'],
    }
  }

  /**
   * The lib's isActionErrorFrame/isErrorFrame validators reject any error frame
   * whose payload deviates from the pinned spec (e.g. commission_ship's
   * missing-materials refusal, whose `details` is not a plain object), throwing
   * away the game's real code/message in favor of
   * `invalid_response: "Malformed action_error frame for request rN"`. That
   * masked a plain missing-materials refusal as a "systemic server bug"
   * (CassMargin, 2026-08-29) and burned turns retrying at multiple yards.
   * Rebuild the real error from the raw frame teed off the wire; if even that
   * fails, surface the raw text — no error is ever fully masked.
   */
  private recoverMaskedError(libMessage: string): CommandResult | null {
    const m = /^Malformed \S+ frame for request (\S+)$/.exec(libMessage)
    if (!m) return null
    const requestId = m[1]
    const raw = this.rawErrorFrames.get(requestId)
    if (!raw) {
      // Frame never seen (pre-snoop connect, or dropped at the socket layer).
      // Still reframe it so the agent doesn't read a client parse gap as a
      // server outage and retry the mutation blindly.
      return {
        error: {
          code: 'invalid_response',
          message: `${libMessage} — the server DID answer (likely refusing the action); the client could not parse its error frame. Treat as a refusal, not an outage; do not retry blindly.`,
        },
      }
    }
    this.rawErrorFrames.delete(requestId)
    try {
      const frame = JSON.parse(raw) as { payload?: unknown }
      const p = frame.payload
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const payload = p as Record<string, unknown>
        const code = typeof payload.code === 'string' ? payload.code : 'action_error'
        let message = [payload.message, payload.error, payload.reason]
          .find((v): v is string => typeof v === 'string') ?? ''
        if (payload.details !== undefined && payload.details !== null) {
          const details = JSON.stringify(payload.details)
          if (details && details !== '{}' && details !== '[]') {
            message = message ? `${message} — details: ${truncateRaw(details)}` : `details: ${truncateRaw(details)}`
          }
        }
        if (message) return { error: { code, message } }
      }
    } catch { /* fall through to the raw-text fallback */ }
    console.warn(`[lib_v2] unparsed error frame for request ${requestId}: ${truncateRaw(raw)}`)
    return { error: { code: 'action_error', message: `unparsed error frame: ${truncateRaw(raw)}` } }
  }

  /**
   * Establish (or reuse) a REST v1 session: POST /session for a session id, then
   * POST /login to bind this player to it. Concurrent callers coalesce onto one
   * in-flight attempt so a burst of fallback commands can't open N sessions.
   */
  private async ensureRestSession(): Promise<void> {
    // Sessions last ~30 min; re-mint just before expiry so a long-idle agent's
    // first gift doesn't have to burn a 401 round-trip to discover it lapsed.
    if (this.restSession && !this.isRestSessionExpiring()) return
    if (this.restSession) this.restSession = null
    if (!this.restSessionPromise) {
      this.restSessionPromise = this.createRestSession().finally(() => {
        this.restSessionPromise = null
      })
    }
    return this.restSessionPromise
  }

  private isRestSessionExpiring(): boolean {
    const exp = this.restSession?.expires_at
    if (!exp) return false // server didn't say; rely on the 401 retry path
    const t = new Date(exp).getTime()
    return Number.isNaN(t) || t - Date.now() < 60_000
  }

  private async createRestSession(): Promise<void> {
    if (!this.restCreds) throw new Error('no REST credentials')
    const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }
    const sResp = await fetch(`${this.httpBaseUrl}/api/v1/session`, { method: 'POST', headers })
    if (!sResp.ok) throw new Error(`session ${sResp.status}`)
    const sData = await sResp.json() as { session?: { id: string; expires_at?: string } }
    if (!sData.session?.id) throw new Error('no session in response')

    const lResp = await fetch(`${this.httpBaseUrl}/api/v1/login`, {
      method: 'POST',
      headers: { ...headers, 'X-Session-Id': sData.session.id },
      body: JSON.stringify(this.restCreds),
    })
    const lData = await lResp.json().catch(() => ({})) as { error?: { message?: string } }
    if (!lResp.ok || lData.error) {
      throw new Error(`login failed: ${lData.error?.message ?? lResp.status}`)
    }
    this.restSession = sData.session
  }

  /**
   * Run one command against the REST v1 API. Returns null when the server has no
   * such endpoint (404) so the caller can report `unknown_command` truthfully.
   *
   * Retry policy mirrors the bounded-retry invariant: a session that is rejected
   * up front (401 / session_invalid) is re-minted and the call retried EXACTLY
   * once. Any other failure is surfaced as-is — a mutation that may already have
   * executed is never replayed.
   */
  private async executeViaRest(
    command: string,
    args?: Record<string, unknown>,
    isRetry = false,
  ): Promise<CommandResult | null> {
    try {
      await this.ensureRestSession()
    } catch (err) {
      return { error: { code: 'connection_failed', message: `REST fallback auth failed: ${err instanceof Error ? err.message : String(err)}` } }
    }

    let resp: Response
    try {
      resp = await fetch(`${this.httpBaseUrl}/api/v1/${command}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Session-Id': this.restSession!.id,
        },
        body: JSON.stringify(args ?? {}),
      })
    } catch (err) {
      return { error: { code: 'connection_failed', message: err instanceof Error ? err.message : String(err) } }
    }

    if (resp.status === 404) return null // not a server command either

    if (resp.status === 401 && !isRetry) {
      this.restSession = null
      return this.executeViaRest(command, args, true)
    }

    const data = await resp.json().catch(() => null) as (CommandResult & { session?: { id: string; expires_at?: string } }) | null
    if (!data) return { error: { code: 'http_error', message: `HTTP ${resp.status}` } }
    // Responses carry a refreshed session — keep the newer expiry.
    if (data.session?.id) this.restSession = data.session

    if (data.error && (data.error.code === 'session_invalid' || data.error.code === 'not_authenticated') && !isRetry) {
      this.restSession = null
      return this.executeViaRest(command, args, true)
    }

    // A REST mutation changed server-side state the WS state cache knows nothing
    // about (credits sent, items moved). Drop the query-credits override so the
    // next query re-reads truth rather than serving a pre-gift number.
    if (!data.error) this.queryCredits = null

    if (Array.isArray(data.notifications)) {
      for (const n of data.notifications) {
        for (const handler of this.notificationHandlers) handler(n)
      }
    }
    return data
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  async disconnect(): Promise<void> {
    this.offAny?.()
    this.offAny = null
    this.notificationHandlers = []
    this.account?.close()
    this.account = null
    this.connected = false
    this.restSession = null
    this.restCreds = null
    this.rawErrorFrames.clear()
  }

  isConnected(): boolean {
    return this.connected && (this.account?.authenticated ?? false)
  }

  supportsNotifications(): boolean {
    return true
  }

  /**
   * Zero-round-trip state snapshot from the lib's local cache (seeded at auth,
   * updated by every mutation delta and server push). Shaped like a get_status
   * response, so briefing.ts and agent.ts consume it unchanged.
   */
  getLocalState(): Record<string, unknown> | null {
    if (!this.account?.authenticated) return null
    const snap = this.account.state as Record<string, unknown>
    if (!snap || (!snap.player && !snap.ship)) return null
    const out: Record<string, unknown> = { ...snap, has_pending_action: this.account.hasPendingAction }
    // Query-derived credits are fresher than the cache when the last credit
    // change was INCOMING (gift/order fill) — see queryCredits doc comment.
    // Stamp BOTH the top-level field and player.credits: the dashboard reads
    // player.credits first, so overriding only the top level left one payload
    // carrying two different wallets (the UI flickered between them).
    if (this.queryCredits !== null) {
      out.credits = this.queryCredits
      const p = out.player as Record<string, unknown> | undefined
      if (p && typeof p === 'object') out.player = { ...p, credits: this.queryCredits }
    }
    return out
  }

  /**
   * Command list for the system prompt, straight from the lib's generated
   * catalog (278 commands, spec-synced) — no OpenAPI fetch round-trip.
   * Same shape as schema.ts formatCommandList: one line per command.
   */
  getCommandList(role: AgentRole = 'default'): string {
    return formatLibCommandList(role)
  }

  get commandCount(): number {
    const routes = buildRouteIndex()
    const extra = REST_ONLY_COMMANDS.filter((c) => !routes.has(c.name)).length
    return Object.keys(ACTIONS).length + extra
  }
}

/**
 * The lib's `reload` takes `target` for the ammo, and its catalog text leaves the
 * agent to guess what `target` means. Morg'Thar burned ~11 tool rounds on
 * 2026-09-01 guessing weapon ids and calling help(reload). The wire parameter is
 * still `target` (execute forwards args by name, so the signature has to say so);
 * the summary spells out that it IS the ammo item id — reload(id, ammo_item_id).
 */
const RELOAD_LINE =
  '- reload(id: string, target: string) [action] — Reload a fitted weapon from ammo in cargo — reload(id, ammo_item_id): ' +
  'id = the weapon instance id (from get_ship or your Weapons briefing, NOT the weapon type); ' +
  'target = the AMMO item id to load, e.g. target="ferrous_slug_case" — it must match that weapon\'s ammo type. Pass both.'

/**
 * Command list for the system prompt, straight from the lib's generated catalog
 * (spec-synced) — no OpenAPI fetch round-trip. Same shape as schema.ts
 * formatCommandList: one line per command. Scoped by role: a hunter is not
 * shown mining/crafting/facility-build/commission/faction-admin commands
 * (see isCommandForRole in role.ts). Module-level so buildSystemPrompt can
 * re-derive the list for a role without a connection in hand.
 */
export function formatLibCommandList(role: AgentRole = 'default'): string {
  const lines: string[] = []
  for (const def of Object.values(ACTIONS)) {
    if (def.tool === 'spacemolt_auth') continue // login/register handled by the harness
    if (!isCommandForRole(def.tool, def.action, role)) continue
    if (def.tool === 'spacemolt_battle' && def.action === 'reload') {
      lines.push(RELOAD_LINE)
      continue
    }
    const params = (def.params ?? [])
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
      .join(', ')
    const kind = def.kind === 'mutation' ? 'action' : 'query'
    lines.push(`- ${def.action}(${params}) [${kind}] — ${def.summary}`)
  }
  // REST-v1-only commands (no WS route in this lib build) — see REST_ONLY_COMMANDS.
  const routes = buildRouteIndex()
  for (const c of REST_ONLY_COMMANDS) {
    if (routes.has(c.name)) continue // lib caught up; the real route already listed it
    lines.push(`- ${c.name}(${c.params}) [action] — ${c.summary}`)
  }
  return lines.join('\n')
}
