import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import type { LogFn, ToolContext } from './tools'
import {
  allTools,
  executeTool,
  isMacroTool,
  ACTION_PENDING_SENTINEL,
  COOLDOWN_BLOCKED_SENTINEL,
} from './tools'
import type { TurnOutcome } from './loop'
import {
  deleteCodexSession,
  getCodexSession,
  upsertCodexSession,
  type CodexSession,
} from './db'
import { safeTruncate } from './text-safe'

const DEFAULT_MAX_TOOL_CALLS = 12
// Admiral macros can legitimately run for up to 12 minutes. Keep enough room
// for the model to reason before/after the macro and for the app-server to
// deliver the terminal turn notification.
export const MIN_CODEX_TURN_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_CONCURRENCY = 2
const RATE_LIMIT_THRESHOLD = 95
const CODEX_CONFIG = `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
apps = false
multi_agent = false
`

type JsonRpcId = number | string
type CodexRole = CodexSession['role']

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: Error) => void
}

interface ActiveTurn {
  threadId: string
  turnId?: string
  connection: GameConnection
  profileId: string
  profileName: string
  log: LogFn
  todo: { value: string }
  memory: { value: string }
  toolContext: ToolContext
  maxToolCalls: number
  toolCalls: number
  /**
   * Tool calls the model issued that we refused to run (turn already ending:
   * macro in flight, action pending, cooldown, abort, budget spent). These
   * prove the model WANTED to act, so the turn must not be scored as idle.
   */
  skippedToolCalls: number
  actionPending: boolean
  cooldownBlocked: boolean
  connectionFailures: number
  agentMessages: string[]
  abortRequested: boolean
  macroStarted: boolean
  resolve: (outcome: TurnOutcome) => void
  reject: (reason: Error) => void
  settled: boolean
  inFlightTools: Set<Promise<unknown>>
  onActivity?: (activity: string) => void
  isConnectionDown?: () => boolean
}

export interface CodexTurnOptions {
  signal?: AbortSignal
  maxToolRounds?: number
  llmTimeoutMs?: number
  onActivity?: (activity: string) => void
  isConnectionDown?: () => boolean
}

export interface RunCodexTurnParams {
  role: CodexRole
  model: string
  context: Context
  connection: GameConnection
  profileId: string
  profileName: string
  log: LogFn
  todo: { value: string }
  memory: { value: string }
  options?: CodexTurnOptions
}

export interface CodexDynamicTool {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export function resolveCodexTurnTimeoutMs(
  requestedMs?: number,
  configuredSeconds?: string,
): number {
  const configuredMs = Number(configuredSeconds) * 1000
  const requested = Number.isFinite(requestedMs) && Number(requestedMs) > 0
    ? Number(requestedMs)
    : undefined
  const configured = Number.isFinite(configuredMs) && configuredMs > 0
    ? configuredMs
    : undefined
  return Math.max(configured ?? requested ?? MIN_CODEX_TURN_TIMEOUT_MS, MIN_CODEX_TURN_TIMEOUT_MS)
}

export function shouldEndCodexTurnAfterTool(toolName: string): boolean {
  return isMacroTool(toolName)
}

export function buildCodexDynamicTools(): CodexDynamicTool[] {
  return allTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || `Run Admiral tool ${tool.name}`,
    inputSchema: JSON.parse(JSON.stringify(tool.parameters || { type: 'object' })) as Record<string, unknown>,
  }))
}

export function buildCodexThreadParams(
  model: string,
  systemPrompt: string,
  codexHome: string,
  dynamicTools: CodexDynamicTool[],
): Record<string, unknown> {
  return {
    model,
    cwd: codexHome,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    personality: 'none',
    serviceName: 'admiral',
    baseInstructions: systemPrompt,
    developerInstructions: [
      'You are controlling one Admiral game agent, not editing software.',
      'Admiral is the authority for the current directive, TODO, memory, permissions, and game state.',
      'Use only the dynamic tools supplied by Admiral. Do not use shell, filesystem, web, apps, MCP, or multi-agent tools.',
      'Do not modify authentication, provider settings, directives, TODO, or memory except through an explicitly supplied Admiral tool.',
      'Stop after a game action is queued, a cooldown is reported, or the requested turn is otherwise complete.',
    ].join(' '),
    dynamicTools,
    ephemeral: false,
  }
}

function toolSchemaHash(tools: CodexDynamicTool[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}

function extractLatestUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
      if (text) return text
    }
  }
  return 'Continue the current Admiral turn using the authoritative instructions and available tools.'
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('Codex turn aborted before start')

    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Codex turn aborted while waiting for capacity'))
        }
        this.waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }

    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private stdoutBuffer = ''
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private lastRateLimitCheck = 0

  private get codexHome(): string {
    return path.join(process.cwd(), 'data', 'codex-home')
  }

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  private async start(): Promise<void> {
    const accessToken = process.env.CODEX_ACCESS_TOKEN?.trim()
    if (!accessToken) {
      throw new Error('ChatGPT Business/Codex is not configured: CODEX_ACCESS_TOKEN is missing')
    }

    fs.mkdirSync(this.codexHome, { recursive: true })
    fs.writeFileSync(path.join(this.codexHome, 'config.toml'), CODEX_CONFIG, { encoding: 'utf8', mode: 0o600 })

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.codexHome,
      CODEX_ACCESS_TOKEN: accessToken,
    }
    // This runtime is intentionally subscription/access-token only. Never let
    // an inherited Platform API key silently change the billing/auth route.
    delete childEnv.OPENAI_API_KEY

    const binary = process.env.ADMIRAL_CODEX_BIN?.trim() || 'codex'
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd: this.codexHome,
      env: childEnv,
      shell: false,
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => this.handleStdout(String(chunk)))
    child.stderr.on('data', chunk => {
      const message = String(chunk).trim()
      if (message) console.warn(`[codex app-server] ${message}`)
    })
    child.on('error', error => {
      if (this.child !== child) return
      this.failAll(new Error(`Could not start Codex app-server: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.failAll(new Error(`Codex app-server exited (${signal || code || 'unknown'})`))
    })

    try {
      await this.request('initialize', {
        clientInfo: { name: 'admiral', title: 'Admiral', version: '0.3.8' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['item/agentMessage/delta'],
        },
      })
      this.notify('initialized', {})

      const accountResult = await this.request('account/read', { refreshToken: false })
      const account = accountResult?.account ?? accountResult
      if (!account || (account.type && account.type !== 'chatgpt')) {
        throw new Error('Codex app-server did not authenticate as a ChatGPT account')
      }
    } catch (error) {
      this.child = null
      child.kill()
      throw error
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.child || this.child.killed) throw new Error('Codex app-server is not running')
    const id = this.nextId++
    const result = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send({ method, id, ...(params === undefined ? {} : { params }) })
    return result
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }

  registerTurn(active: ActiveTurn): void {
    if (this.activeTurns.has(active.threadId)) {
      throw new Error(`Codex thread ${active.threadId} already has an active turn`)
    }
    this.activeTurns.set(active.threadId, active)
  }

  unregisterTurn(threadId: string): void {
    this.activeTurns.delete(threadId)
  }

  async checkRateLimits(): Promise<void> {
    if (Date.now() - this.lastRateLimitCheck < 30_000) return
    const result = await this.request('account/rateLimits/read')
    // Only cache a successful read. A failed check must fail closed again on
    // the next turn rather than creating a temporary unchecked window.
    this.lastRateLimitCheck = Date.now()
    const limits = result?.rateLimits ?? result
    const thresholdRaw = Number(process.env.ADMIRAL_CODEX_RATE_LIMIT_THRESHOLD)
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 100
      ? thresholdRaw
      : RATE_LIMIT_THRESHOLD
    const buckets = result?.rateLimitsByLimitId
      ? Object.values(result.rateLimitsByLimitId)
      : [limits]
    const exhausted = buckets.some((bucket: any) => {
      const windows = [bucket?.primary, bucket?.secondary].filter(Boolean)
      return bucket?.rateLimitReachedType ||
        windows.some((window: any) => Number(window?.usedPercent) >= threshold)
    })
    if (exhausted) {
      throw new Error(`ChatGPT Business/Codex usage is at or above the ${threshold}% safety threshold`)
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    if (!turnId || !this.child) return
    try {
      await this.request('turn/interrupt', { threadId, turnId })
    } catch {
      // The turn may have completed between the stop condition and interrupt.
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server stdin is unavailable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      try {
        this.handleMessage(JSON.parse(line))
      } catch (error) {
        console.warn(`[codex app-server] Invalid JSONL: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private handleMessage(message: any): void {
    if (message?.method && message?.id !== undefined) {
      void this.handleServerRequest(message)
      return
    }
    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message?.method) this.handleNotification(message.method, message.params || {})
  }

  private async handleServerRequest(message: any): Promise<void> {
    if (message.method !== 'item/tool/call') {
      // Approval requests should not appear with approvalPolicy=never, but if a
      // future server asks anyway, fail closed rather than authorizing it.
      if (/requestApproval|requestPermissions/i.test(message.method)) {
        this.send({ id: message.id, result: { decision: 'decline' } })
      } else {
        this.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } })
      }
      return
    }

    const params = message.params || {}
    const active = this.activeTurns.get(params.threadId)
    if (!active) {
      this.send({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: 'Error: no active Admiral turn owns this thread' }],
          success: false,
        },
      })
      return
    }

    const toolName = String(params.tool || '')
    let result: string
    if (
      active.abortRequested ||
      active.settled ||
      active.macroStarted ||
      active.actionPending ||
      active.cooldownBlocked ||
      active.toolCalls >= active.maxToolCalls
    ) {
      result = 'Skipped — this Admiral turn is ending. Reissue the call on a later turn if it is still needed.'
      active.skippedToolCalls++
    } else {
      active.toolCalls++
      if (shouldEndCodexTurnAfterTool(toolName)) active.macroStarted = true
      active.onActivity?.(`Executing tool: ${params.tool}`)
      const toolExecution = Promise.resolve().then(() => executeTool(
        toolName,
        (params.arguments || {}) as Record<string, unknown>,
        active.toolContext,
      ))
      active.inFlightTools.add(toolExecution)
      try {
        result = await toolExecution
      } catch (error) {
        result = `Error executing ${params.tool}: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        active.inFlightTools.delete(toolExecution)
      }

      active.todo.value = active.toolContext.todo
      active.memory.value = active.toolContext.memory
      if (result.startsWith(ACTION_PENDING_SENTINEL)) active.actionPending = true
      if (result.startsWith(COOLDOWN_BLOCKED_SENTINEL)) active.cooldownBlocked = true
      if (result.startsWith('Error: [connection_failed]')) active.connectionFailures++
    }

    this.send({
      id: message.id,
      result: {
        contentItems: [{ type: 'inputText', text: result }],
        success: !result.startsWith('Error'),
      },
    })

    const connectionLost = active.connectionFailures >= 3 || (active.connectionFailures > 0 && active.isConnectionDown?.())
    if (
      active.macroStarted ||
      active.actionPending ||
      active.cooldownBlocked ||
      active.toolCalls >= active.maxToolCalls ||
      connectionLost
    ) {
      setTimeout(() => void this.interrupt(active.threadId, active.turnId), 0)
    }
  }

  private handleNotification(method: string, params: any): void {
    const threadId = params?.threadId
    if (!threadId) return
    const active = this.activeTurns.get(threadId)
    if (!active) return

    if (method === 'turn/started') {
      active.turnId = params?.turn?.id || active.turnId
      if (active.abortRequested) setTimeout(() => void this.interrupt(active.threadId, active.turnId), 0)
      return
    }

    if (method === 'item/completed') {
      const item = params?.item
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        active.agentMessages.push(item.text.trim())
      }
      return
    }

    if (method === 'turn/completed' && !active.settled) {
      active.settled = true
      const status = String(params?.turn?.status || 'completed')
      if (status === 'failed') {
        const error = params?.turn?.error
        active.reject(new Error(error?.message || error || 'Codex turn failed'))
        return
      }
      const connectionLost = active.connectionFailures >= 3 ||
        (active.connectionFailures > 0 && active.isConnectionDown?.())
      // 'idle' means the model CHOSE to do nothing — it drives the harness
      // idle backoff (5/10/15min sleeps). A turn that was cut short still did
      // work or wanted to, so only score idle when the model executed nothing,
      // requested nothing that we refused, and nothing was left in flight.
      const didNothing =
        active.toolCalls === 0 &&
        active.skippedToolCalls === 0 &&
        !active.abortRequested &&
        !active.macroStarted &&
        !active.actionPending &&
        active.inFlightTools.size === 0
      active.resolve(connectionLost ? 'connection_lost' : didNothing ? 'idle' : 'completed')
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const active of this.activeTurns.values()) {
      if (!active.settled) {
        active.settled = true
        active.reject(error)
      }
    }
    this.activeTurns.clear()
  }
}

const concurrencyRaw = Number(process.env.ADMIRAL_CODEX_MAX_CONCURRENCY)
const concurrency = Number.isInteger(concurrencyRaw) && concurrencyRaw > 0
  ? concurrencyRaw
  : DEFAULT_MAX_CONCURRENCY
const semaphore = new Semaphore(concurrency)
const appServer = new CodexAppServer()

async function loadOrCreateThread(
  role: CodexRole,
  model: string,
  context: Context,
  profileId: string,
): Promise<{ threadId: string; schemaHash: string }> {
  const dynamicTools = buildCodexDynamicTools()
  const schemaHash = toolSchemaHash(dynamicTools)
  const codexHome = path.join(process.cwd(), 'data', 'codex-home')
  const startParams = buildCodexThreadParams(model, context.systemPrompt || '', codexHome, dynamicTools)
  let session = getCodexSession(profileId, role)

  if (session && (session.model !== model || session.tool_schema_hash !== schemaHash)) {
    deleteCodexSession(profileId, role)
    session = undefined
  }

  if (session) {
    try {
      await appServer.request('thread/resume', {
        threadId: session.thread_id,
        model,
        cwd: codexHome,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: context.systemPrompt || '',
        developerInstructions: startParams.developerInstructions,
      })
      return { threadId: session.thread_id, schemaHash }
    } catch {
      deleteCodexSession(profileId, role)
    }
  }

  const result = await appServer.request('thread/start', startParams)
  const threadId = result?.thread?.id
  if (!threadId) throw new Error('Codex app-server did not return a thread id')
  upsertCodexSession(profileId, role, threadId, model, schemaHash)
  return { threadId, schemaHash }
}

export async function runCodexAgentTurn(params: RunCodexTurnParams): Promise<TurnOutcome> {
  const release = await semaphore.acquire(params.options?.signal)
  try {
    if (params.options?.isConnectionDown?.()) return 'connection_lost'
    await appServer.ensureStarted()
    await appServer.checkRateLimits()

    const { threadId } = await loadOrCreateThread(params.role, params.model, params.context, params.profileId)
    const maxToolCalls = params.options?.maxToolRounds ?? DEFAULT_MAX_TOOL_CALLS
    let active!: ActiveTurn
    const completion = new Promise<TurnOutcome>((resolve, reject) => {
      active = {
        threadId,
        connection: params.connection,
        profileId: params.profileId,
        profileName: params.profileName,
        log: params.log,
        todo: params.todo,
        memory: params.memory,
        toolContext: {
          connection: params.connection,
          profileId: params.profileId,
          profileName: params.profileName,
          log: params.log,
          todo: params.todo.value,
          memory: params.memory.value,
        },
        maxToolCalls,
        toolCalls: 0,
        skippedToolCalls: 0,
        actionPending: false,
        cooldownBlocked: false,
        connectionFailures: 0,
        agentMessages: [],
        abortRequested: false,
        macroStarted: false,
        resolve,
        reject,
        settled: false,
        inFlightTools: new Set(),
        onActivity: params.options?.onActivity,
        isConnectionDown: params.options?.isConnectionDown,
      }
    })
    appServer.registerTurn(active)

    const abortHandler = () => {
      active.abortRequested = true
      void appServer.interrupt(threadId, active.turnId)
    }
    params.options?.signal?.addEventListener('abort', abortHandler, { once: true })
    const timeoutMs = resolveCodexTurnTimeoutMs(
      params.options?.llmTimeoutMs,
      process.env.ADMIRAL_CODEX_TURN_TIMEOUT_SECONDS,
    )
    const timeout = setTimeout(() => {
      if (!active.settled) {
        active.abortRequested = true
        active.settled = true
        void appServer.interrupt(threadId, active.turnId)
        active.reject(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s`))
      }
    }, timeoutMs)

    try {
      params.options?.onActivity?.('Waiting for Codex response...')
      const turnResult = await appServer.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: extractLatestUserText(params.context) }],
        model: params.model,
      })
      active.turnId = turnResult?.turn?.id || active.turnId
      const outcome = await completion

      const thought = active.agentMessages.join('\n').trim()
      if (thought) params.log('llm_thought', safeTruncate(thought, 4000, '...'))
      params.log(
        'llm_call',
        `${params.model} | ChatGPT Business/Codex | ${active.toolCalls} tool call${active.toolCalls === 1 ? '' : 's'}`,
        JSON.stringify({
          provider: 'codex-business',
          model: params.model,
          role: params.role,
          threadId,
          toolCalls: active.toolCalls,
          outcome,
          billing: 'ChatGPT Business access token (not OpenAI Platform API)',
        }, null, 2),
      )
      return outcome
    } finally {
      clearTimeout(timeout)
      params.options?.signal?.removeEventListener('abort', abortHandler)
      // A Codex interrupt cannot cancel a local Admiral macro that is already
      // executing. Drain it before releasing the semaphore/unregistering the
      // thread so a replacement turn cannot overlap it and issue stale actions.
      await Promise.allSettled([...active.inFlightTools])
      appServer.unregisterTurn(threadId)
    }
  } catch (error) {
    params.log(
      'error',
      `Codex Business turn failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 'idle'
  } finally {
    release()
  }
}
