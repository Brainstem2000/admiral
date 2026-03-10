import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'
import { fetchOpenApiSpec, type SpecLogFn } from '../schema'

const MAX_RECONNECT_ATTEMPTS = 6
const RECONNECT_BASE_DELAY = 5_000

interface ApiSession {
  id: string
  playerId?: string
  createdAt: string
  expiresAt: string
}

/**
 * HTTP API v2 connection. Uses consolidated REST endpoints at /api/v2/{tool}/{action}.
 * Same session management as v1 but with grouped command structure.
 */
export class HttpV2Connection implements GameConnection {
  readonly mode = 'http_v2' as const
  private baseUrl: string
  private session: ApiSession | null = null
  private credentials: { username: string; password: string } | null = null
  private notificationHandlers: NotificationHandler[] = []
  private connected = false
  // Maps command name (v1 or v2) -> URL path segment after /api/v2/
  private commandRouteMap: Map<string, string> = new Map()
  private specLog: SpecLogFn | undefined
  private v1FallbackLogged = false
  private ensureSessionPromise: Promise<void> | null = null
  // Parallel v1 session for commands missing from the v2 route map
  private v1Session: ApiSession | null = null
  private v1SessionPromise: Promise<void> | null = null

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl.replace(/\/$/, '') + '/api/v2'
  }

  /** Set a log function to surface spec fetch errors/warnings. */
  setSpecLog(log: SpecLogFn): void {
    this.specLog = log
  }

  async connect(): Promise<void> {
    await this.fetchToolMapping()
    if (this.commandRouteMap.size > 0) {
      this.v1FallbackLogged = false
    }
    await this.ensureSession()
    this.connected = true
  }

  private async fetchToolMapping(): Promise<void> {
    const spec = await fetchOpenApiSpec(`${this.baseUrl}/openapi.json`, this.specLog)
    if (!spec) return

    const allPaths = Object.keys(spec.paths || {})
    const toolPrefixes = new Set<string>()

    for (const p of allPaths) {
      const seg = p.replace('/api/v2/', '')
      const parts = seg.split('/')
      const op = ((spec.paths as Record<string, Record<string, unknown>>)[p]?.post ?? {}) as Record<string, unknown>
      const operationId = op.operationId as string | undefined

      if (parts.length === 2) {
        const [tool, action] = parts
        toolPrefixes.add(tool)
        const route = `${tool}/${action}`
        // v1-style short name (action) -> route
        if (!this.commandRouteMap.has(action)) {
          this.commandRouteMap.set(action, route)
        }
        // v2 operationId -> route
        if (operationId) {
          this.commandRouteMap.set(operationId, route)
        }
        // v1-style aliases: strip "spacemolt_" prefix, register both orderings
        // e.g. spacemolt_faction/join → "join_faction" AND "faction_join"
        const toolShort = tool.startsWith('spacemolt_') ? tool.slice('spacemolt_'.length) : tool
        if (toolShort !== tool) {
          const alias1 = `${action}_${toolShort}`
          const alias2 = `${toolShort}_${action}`
          if (!this.commandRouteMap.has(alias1)) {
            this.commandRouteMap.set(alias1, route)
          }
          if (!this.commandRouteMap.has(alias2)) {
            this.commandRouteMap.set(alias2, route)
          }
        }
      } else if (parts.length === 1 && seg !== 'session' && seg !== 'notifications') {
        // 1-part path: tool IS the command (e.g. spacemolt_catalog)
        this.commandRouteMap.set(seg, seg)
        if (operationId && operationId !== seg) {
          this.commandRouteMap.set(operationId, seg)
        }
      }
    }

    // For 1-part command paths, derive v1 short names by stripping known tool prefixes
    for (const p of allPaths) {
      const seg = p.replace('/api/v2/', '')
      if (seg.split('/').length !== 1 || seg === 'session' || seg === 'notifications') continue
      // Try stripping each known tool prefix + underscore (longest first)
      const sortedPrefixes = [...toolPrefixes].sort((a, b) => b.length - a.length)
      for (const prefix of sortedPrefixes) {
        if (seg.startsWith(prefix + '_') && seg.length > prefix.length + 1) {
          const shortName = seg.slice(prefix.length + 1)
          if (!this.commandRouteMap.has(shortName)) {
            this.commandRouteMap.set(shortName, seg)
          }
          break
        }
      }
    }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.credentials = { username, password }
    const resp = await this.execute('login', { username, password })
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = resp.result as Record<string, unknown> | undefined
    return {
      success: true,
      player_id: (result?.player as Record<string, unknown> | undefined)?.id as string | undefined,
      session: result as Record<string, unknown> | undefined,
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const args: Record<string, unknown> = { username, empire }
    if (code) args.registration_code = code
    const resp = await this.execute('register', args)
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = resp.result as Record<string, unknown> | undefined
    if (result) {
      this.credentials = {
        username: (result.username as string) || username,
        password: result.password as string,
      }
    }
    return {
      success: true,
      username: result?.username as string,
      password: result?.password as string,
      player_id: result?.player_id as string,
      empire: result?.empire as string,
    }
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    try {
      await this.ensureSession()
    } catch {
      return { error: { code: 'connection_failed', message: 'Could not connect to server' } }
    }

    let resp: CommandResult
    try {
      resp = await this.doRequest(command, args)
    } catch {
      this.session = null
      try {
        await this.ensureSession()
        resp = await this.doRequest(command, args)
      } catch {
        return { error: { code: 'connection_failed', message: 'Could not reconnect to server' } }
      }
    }

    if (resp.error) {
      const code = resp.error.code
      if (code === 'rate_limited') {
        const secs = resp.error.retry_after || 10
        await sleep(Math.ceil(secs * 1000))
        return this.execute(command, args)
      }
      if (code === 'session_invalid' || code === 'session_expired' || code === 'not_authenticated') {
        this.session = null
        await this.ensureSession()
        return this.doRequest(command, args)
      }
    }

    if (resp.notifications && Array.isArray(resp.notifications)) {
      for (const n of resp.notifications) {
        for (const handler of this.notificationHandlers) {
          handler(n)
        }
      }
    }

    return resp
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  async disconnect(): Promise<void> {
    this.session = null
    this.v1Session = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  private get v1BaseUrl(): string {
    return this.baseUrl.replace(/\/api\/v2$/, '/api/v1')
  }

  /** Returns the v1 base URL when the v2 route map is unavailable. */
  private get effectiveBaseUrl(): string {
    if (this.commandRouteMap.size === 0) {
      return this.v1BaseUrl
    }
    return this.baseUrl
  }

  /**
   * Lazily create a parallel v1 session for fallback commands.
   * Only needed when the v2 route map is populated but a specific command is missing.
   */
  private async ensureV1Session(): Promise<void> {
    if (this.v1Session && !this.isSessionExpiringSoon(this.v1Session)) return
    if (!this.v1SessionPromise) {
      this.v1SessionPromise = this.createV1Session().finally(() => {
        this.v1SessionPromise = null
      })
    }
    return this.v1SessionPromise
  }

  private async createV1Session(): Promise<void> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${this.v1BaseUrl}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        })
        if (!resp.ok) throw new Error(`Failed to create v1 session: ${resp.status}`)
        const data = await resp.json()
        if (data.session) {
          this.v1Session = data.session
        } else {
          throw new Error('No session in v1 response')
        }
        if (this.credentials) {
          const loginResp = await fetch(`${this.v1BaseUrl}/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              'X-Session-Id': this.v1Session!.id,
            },
            body: JSON.stringify({
              username: this.credentials.username,
              password: this.credentials.password,
            }),
          })
          if (!loginResp.ok) throw new Error(`v1 login failed: ${loginResp.status}`)
        }
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
    throw lastError || new Error('Failed to create v1 fallback session')
  }

  private isSessionExpiringSoon(session: ApiSession): boolean {
    const expiresAt = new Date(session.expiresAt).getTime()
    return expiresAt - Date.now() < 60_000
  }

  private async ensureSession(): Promise<void> {
    if (this.session && !this.isSessionExpiring()) return

    // Coalesce concurrent callers onto a single in-flight attempt rather than
    // each starting their own retry loop (which would multiply session creation
    // requests against the server's rate limit).
    if (!this.ensureSessionPromise) {
      this.ensureSessionPromise = this.createSession().finally(() => {
        this.ensureSessionPromise = null
      })
    }
    return this.ensureSessionPromise
  }

  private async createSession(): Promise<void> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${this.effectiveBaseUrl}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        })
        if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`)

        const data = await resp.json()
        if (data.session) {
          this.session = data.session
        } else {
          throw new Error('No session in response')
        }

        if (this.credentials) {
          await this.doRequest('login', {
            username: this.credentials.username,
            password: this.credentials.password,
          })
        }
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
    throw lastError || new Error('Failed to connect to server')
  }

  private isSessionExpiring(): boolean {
    if (!this.session) return true
    return this.isSessionExpiringSoon(this.session)
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<CommandResult> {
    const base = this.effectiveBaseUrl
    let route = this.commandRouteMap.get(command)

    // Fallback: try spacemolt_ prefix (e.g. "catalog" → "spacemolt_catalog")
    if (!route) {
      route = this.commandRouteMap.get(`spacemolt_${command}`)
    }

    let url: string
    let useV1Fallback = false
    if (route) {
      url = `${base}/${route}`
    } else if (this.commandRouteMap.size === 0) {
      // No route map at all — fall back to v1 entirely (session is already v1)
      url = `${this.v1BaseUrl}/${command}`
      if (!this.v1FallbackLogged) {
        this.specLog?.('warn', 'v2 route map unavailable, falling back to v1 API endpoints')
        this.v1FallbackLogged = true
      }
    } else {
      // Route map exists but command not found — use v1 with a separate v1 session
      url = `${this.v1BaseUrl}/${command}`
      useV1Fallback = true
      this.specLog?.('warn', `Command "${command}" not in v2 route map, using v1 fallback`)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }
    if (useV1Fallback) {
      await this.ensureV1Session()
      if (this.v1Session) headers['X-Session-Id'] = this.v1Session.id
    } else {
      if (this.session) headers['X-Session-Id'] = this.session.id
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    })

    if (resp.status === 401) {
      // If v1 fallback got a 401, try refreshing the v1 session once
      if (useV1Fallback) {
        this.v1Session = null
        try {
          await this.ensureV1Session()
        } catch {
          return { error: { code: 'session_invalid', message: 'v1 fallback session failed' } }
        }
        if (this.v1Session) {
          const retryResp = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'X-Session-Id': this.v1Session.id },
            body: payload ? JSON.stringify(payload) : undefined,
          })
          if (retryResp.status === 401) {
            return { error: { code: 'session_invalid', message: 'Unauthorized (v1 fallback)' } }
          }
          try {
            const data = await retryResp.json()
            if (data.session) this.v1Session = data.session
            if (data.structuredContent !== undefined && data.structuredContent !== null) {
              data.result = data.structuredContent
            }
            return data as CommandResult
          } catch {
            return { error: { code: 'http_error', message: `HTTP ${retryResp.status}` } }
          }
        }
      }
      return { error: { code: 'session_invalid', message: 'Unauthorized' } }
    }

    try {
      const data = await resp.json()
      if (data.session) {
        if (useV1Fallback) {
          this.v1Session = data.session
        } else {
          this.session = data.session
        }
      }
      // v2 returns { result: <rendered text>, structuredContent: <JSON> }
      // Keep both: result (text) goes to the LLM, structuredContent is used
      // for cacheGameState and player data display.
      return data as CommandResult
    } catch {
      return { error: { code: 'http_error', message: `HTTP ${resp.status}` } }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
