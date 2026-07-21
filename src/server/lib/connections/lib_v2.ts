import { Account, ACTIONS, ClerkSource, GENERATED_SPEC_VERSION, SpacemoltError } from '@spacemolt/lib'
import type { AuthCredentials } from '@spacemolt/lib'
import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'

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

  constructor(serverUrl: string) {
    this.httpBaseUrl = serverUrl.replace(/\/$/, '')
    this.wsUrl = this.httpBaseUrl.replace(/^http/, 'ws') + '/ws/v2'
  }

  async connect(): Promise<void> {
    this.account = new Account({
      url: this.wsUrl,
      reconnect: true,
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
        return { error: { code: err.code, message: err.message } }
      }
      return { error: { code: 'connection_failed', message: err instanceof Error ? err.message : String(err) } }
    }
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
    if (this.queryCredits !== null) out.credits = this.queryCredits
    return out
  }

  /**
   * Command list for the system prompt, straight from the lib's generated
   * catalog (278 commands, spec-synced) — no OpenAPI fetch round-trip.
   * Same shape as schema.ts formatCommandList: one line per command.
   */
  getCommandList(): string {
    const lines: string[] = []
    for (const def of Object.values(ACTIONS)) {
      if (def.tool === 'spacemolt_auth') continue // login/register handled by the harness
      const params = (def.params ?? [])
        .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
        .join(', ')
      const kind = def.kind === 'mutation' ? 'action' : 'query'
      lines.push(`- ${def.action}(${params}) [${kind}] — ${def.summary}`)
    }
    return lines.join('\n')
  }

  get commandCount(): number {
    return Object.keys(ACTIONS).length
  }
}
