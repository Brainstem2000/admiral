import { complete } from '@mariozechner/pi-ai'
import type { Model, Context, AssistantMessage, ToolCall, Message } from '@mariozechner/pi-ai'
import type { GameConnection } from './connections/interface'
import type { LogFn } from './tools'
import { executeTool, ACTION_PENDING_SENTINEL, COOLDOWN_BLOCKED_SENTINEL, LOOP_FLUSH_SENTINEL } from './tools'
import { safeTruncate, scrubContextSurrogates } from './text-safe'
import { recordLlmSpend } from './db'

// Lowered from 30: the cap was being treated as a quota — turns ran to the ceiling firing queries
// and (pre-fix) re-firing into the cooldown gate. With the cooldown-block early-exit below, 12 is
// ample for any real turn (place an action → exit) and stops the per-turn over-deliberation.
const DEFAULT_MAX_TOOL_ROUNDS = 12
/** Extra rounds granted ONLY to persist state when a turn would otherwise be
 *  guillotined at the cap without writing anything. Not general-purpose
 *  budget — see the wrap-up reserve in runAgentTurn. */
const WRAPUP_RESERVE_ROUNDS = 2
/** The only tools available during the wrap-up reserve. */
const STATE_WRITE_TOOLS = new Set(['update_todo', 'update_memory'])
// The upstream occasionally answers with a non-JSON body ("JSON Parse error: Unable to
// parse JSON string") or an empty one. It is transient and self-heals, but 3 retries at a
// 5s base all land inside ~35s, so a blip lasting a minute burned the whole turn — Morg'Thar
// lost one that way on 2026-08-19 at ~1% of his calls. 5 retries at a 10s base spans ~310s.
const MAX_RETRIES = 5
/** Abort/timeout retries are capped far below MAX_RETRIES — see the rationale
 *  at the throw site. One retry, then the turn ends. */
const MAX_ABORT_RETRIES = 1
const RETRY_BASE_DELAY = 10_000
const DEFAULT_LLM_TIMEOUT_MS = 90_000

const CHARS_PER_TOKEN = 2  // Game JSON tokenizes at ~1.7 chars/token; 2 is a safe approximation
const CONTEXT_BUDGET_RATIO = 0.45  // Trigger compaction earlier to leave room
const MIN_RECENT_MESSAGES = 10
const SUMMARY_MAX_TOKENS = 1024

export interface LoopOptions {
  signal?: AbortSignal
  apiKey?: string
  /** Re-resolves the provider's API key mid-turn. OAuth access tokens (claude-max)
   *  are rotated on refresh and the *previous* token is revoked immediately, while
   *  its `expiresAt` is still hours away — so a turn holding the old token 401s on
   *  every retry until it exhausts them. Three agents burned all 5 attempts that way
   *  on 2026-08-20 03:48Z when the credentials file rotated mid-turn. */
  refreshApiKey?: () => Promise<string | undefined>
  maxToolRounds?: number
  maxTokens?: number  // Override LLM maxTokens (default: 4096)
  llmTimeoutMs?: number
  /** Probes for pending operator interrupts (nudge, turn restart, safe-dock).
   *  Long-running macro tools poll this between steps so a 24-hop goto_system
   *  can be redirected mid-route instead of finishing deaf (2026-08-29: one
   *  such macro made an agent uncommandable for ~25 minutes mid-convoy).
   *  Returns a short reason string, or null when nothing is pending. */
  interruptPending?: () => string | null
  contextBudgetRatio?: number
  onActivity?: (activity: string) => void
  compactionModel?: Model<any>  // Separate (cheaper) model for compaction summarization
  /** Returns true when the game connection is confirmed dead (was live once,
   *  now reports disconnected). Checked per round so a turn doesn't burn LLM
   *  calls driving a connection the harness has to reconnect anyway. */
  isConnectionDown?: () => boolean
}

/** How a turn ended. `connection_lost` means the game connection is dead or
 *  repeatedly failing — the caller (agent loop) decides whether to exit so
 *  agent-manager's bounded backoff can reconnect. */
export type TurnOutcome = 'completed' | 'connection_lost' | 'idle'

export interface CompactionState {
  summary: string
}

export async function runAgentTurn(
  model: Model<any>,
  context: Context,
  connection: GameConnection,
  profileId: string,
  profileName: string,
  log: LogFn,
  todo: { value: string },
  memory: { value: string },
  options?: LoopOptions,
  compaction?: CompactionState,
): Promise<TurnOutcome> {
  const maxRounds = options?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const summaryModel = options?.compactionModel || model
  let rounds = 0
  let connectionFailures = 0
  // Did the agent persist anything this turn? Progress that is never written
  // to todo/memory is progress the next turn cannot see — see the wrap-up
  // reserve below.
  let wroteState = false
  let wrapUpInjected = false
  // Original toolset, stashed while the wrap-up reserve narrows it. The
  // context object outlives the turn, so this must always be put back.
  let restoreTools: typeof context.tools | null = null

  try {
  while (rounds < maxRounds + WRAPUP_RESERVE_ROUNDS) {
    // The reserve is not general-purpose budget: once past maxRounds the turn
    // is over except for recording what happened. If the agent has already
    // persisted (or spent the reserve without doing so), stop here.
    if (rounds >= maxRounds && (wroteState || !wrapUpInjected)) break
    if (options?.signal?.aborted) return 'completed'

    // Dead-connection guard: don't spend an LLM call on a connection that is
    // already known to be down — reconnects are owned by the harness, and no
    // tool call (including game(login)) can revive a closed socket.
    if (options?.isConnectionDown?.()) {
      log('system', 'Game connection is down — ending turn')
      return 'connection_lost'
    }

    await compactContext(summaryModel, context, compaction, options)

    options?.onActivity?.('Waiting for LLM response...')
    let response: AssistantMessage
    try {
      response = await completeWithRetry(model, context, log, options, compaction)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // An empty or overloaded LLM response that survives the retry loop is transient, not a real
      // fault — the agent just takes another turn next cycle. Log those as a benign 'system' note so
      // they don't pollute the error stream (and skew error-rate monitoring); genuine failures stay 'error'.
      const benign = /empty response|overloaded/i.test(msg)
      log(benign ? 'system' : 'error', `${benign ? 'LLM transient (will retry next turn)' : 'LLM call failed'}: ${msg}`, JSON.stringify({
        model: { name: (model as any).name || 'unknown', contextWindow: model.contextWindow },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        error: msg,
      }, null, 2))
      return 'completed'
    }

    // Log rich LLM call metadata
    {
      const u = response.usage
      const costStr = u.cost.total < 0.001 ? '<$0.001' : `$${u.cost.total.toFixed(3)}`
      const inStr = u.input >= 1000 ? `${(u.input / 1000).toFixed(1)}k` : String(u.input)
      const outStr = u.output >= 1000 ? `${(u.output / 1000).toFixed(1)}k` : String(u.output)
      const summary = `${response.model} | ${inStr}/${outStr} tokens | ${costStr} | ${response.stopReason}`

      const textBlocks = response.content.filter(b => b.type === 'text').length
      const thinkingBlocks = response.content.filter(b => b.type === 'thinking').length
      const toolCallBlocks = response.content.filter(b => b.type === 'toolCall').length

      // We persist only lightweight per-call metadata (counts/tokens/cost). The full message
      // array used to be serialized here too — even truncated to a preview it dominated the
      // llm_call rows (~68% of detail bytes / tens of MB) and was never read by the UI, so the
      // transcript preview was dropped entirely.
      const detail = JSON.stringify({
        model: response.model,
        provider: response.provider,
        stopReason: response.stopReason,
        usage: {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          totalTokens: u.totalTokens,
          cost: u.cost,
        },
        context: {
          messageCount: context.messages.length,
          estimatedTokens: totalMessageTokens(context.messages),
          systemPromptTokens: context.systemPrompt ? estimateTokens(context.systemPrompt) : 0,
          omittedMessages: context.messages.length,
        },
        content: {
          text: textBlocks,
          thinking: thinkingBlocks,
          toolCalls: toolCallBlocks,
        },
      }, null, 2)

      log('llm_call', summary, detail)
      // Durable rollup: llm_call log rows prune at 14 days, and the fleet's core economic
      // question ($/day per agent vs revenue) kept being recomputed by hand from rows that
      // then evaporated. This survives pruning at one row per agent-day-model.
      try {
        recordLlmSpend(profileId, response.model, u.cost.total ?? 0,
          u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0)
      } catch { /* accounting must never break a turn */ }
    }

    context.messages.push(response)

    const toolCalls = response.content.filter((c): c is ToolCall => c.type === 'toolCall')

    const textParts = response.content
      .filter((b: any) => b.type === 'text' && b.text?.trim())
      .map((b: any) => b.text.trim())
    let reasoning = textParts.join(' ')
    if (!reasoning) {
      const thinking = response.content
        .filter((b: any) => 'thinking' in b && b.thinking?.trim())
        .map((b: any) => b.thinking.trim())
        .join(' ')
      if (thinking) {
        const sentences = thinking.split(/[.!?\n]/).filter((s: string) => s.trim().length > 10)
        reasoning = sentences.slice(-3).map((s: string) => s.trim()).join('. ')
      }
    }

    if (toolCalls.length === 0) {
      if (reasoning) log('llm_thought', reasoning)
      // A first-round response with zero tool calls means the whole turn did
      // nothing — surface that so the agent loop can back off instead of
      // re-burning a full-context LLM call every TURN_INTERVAL (observed:
      // idle vault-keeper logging a dozen "zero tool calls" turns in a row).
      return rounds === 0 ? 'idle' : 'completed'
    }

    const reason = reasoning
      ? reasoning.length > 180 ? reasoning.slice(0, 177) + '...' : reasoning
      : undefined

    if (reasoning) log('llm_thought', reasoning)

    const toolCtx = { connection, profileId, profileName, log, todo: todo.value, memory: memory.value, interruptPending: options?.interruptPending }

    let showedReason = false
    let actionPending = false
    let cooldownBlocked = false
    let loopFlush = false
    for (const toolCall of toolCalls) {
      if (options?.signal?.aborted) return 'completed'

      // Hard-stop: once a cooldown block (or a queued action) is seen, the turn is ending. Do NOT
      // execute the remaining queued tool calls in this assistant message — they would only re-fire
      // into the gate or stack a second action. But every toolCall MUST still get a matching
      // toolResult, or the next turn's complete() request is malformed (tool_use without
      // tool_result → API 400). So skipped calls get a synthetic result instead of executing.
      if (cooldownBlocked || actionPending || loopFlush) {
        context.messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: 'Skipped — turn is ending (cooldown active / action pending). This call was not executed; reissue it next turn if still needed.' }],
          isError: false,
          timestamp: Date.now(),
        })
        continue
      }

      options?.onActivity?.(`Executing tool: ${toolCall.name}`)
      const callReason = !showedReason ? reason : undefined
      showedReason = true
      const result = await executeTool(toolCall.name, toolCall.arguments, toolCtx, callReason)

      // If local tools changed todo/memory, sync back
      todo.value = toolCtx.todo
      memory.value = toolCtx.memory

      if (result.startsWith(ACTION_PENDING_SENTINEL)) actionPending = true
      if (result.startsWith(COOLDOWN_BLOCKED_SENTINEL)) cooldownBlocked = true
      if (result.startsWith(LOOP_FLUSH_SENTINEL)) loopFlush = true
      if (toolCall.name === 'update_todo' || toolCall.name === 'update_memory') wroteState = true
      if (result.startsWith('Error: [connection_failed]')) connectionFailures++
      const isError = result.startsWith('Error')
      const toolResultMessage: Message = {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: result }],
        isError,
        timestamp: Date.now(),
      }
      context.messages.push(toolResultMessage)
    }

    // Connection-failure escalation: end the turn once failures are confirmed —
    // either the connection now reports dead, or repeated rounds keep failing
    // (some transports keep claiming isConnected() while the socket is gone).
    // More rounds can't help; the harness owns reconnection.
    if (connectionFailures > 0 && (options?.isConnectionDown?.() || connectionFailures >= 3)) {
      log('system', 'Game connection failure — ending turn')
      return 'connection_lost'
    }

    // Early exit: loop escalation fired — the conversation context is about to be
    // wiped by the agent loop, so more rounds against it are pure waste.
    if (loopFlush) {
      log('system', 'Loop escalation — ending turn for automatic context flush')
      return 'completed'
    }

    // Early exit: if an action is pending, end the turn immediately instead of burning more rounds
    if (actionPending) {
      log('system', 'Action pending — ending turn early')
      return 'completed'
    }

    // Early exit: a cooldown-block means the agent just acted and must wait ~a tick before it can
    // act again. Continuing the turn only re-fires into the gate (the dominant source of burned
    // rounds and turn-exhaustion). Any queries in this round already executed; end now and let the
    // next turn proceed after the tick.
    if (cooldownBlocked) {
      log('system', 'Cooldown active — ending turn early')
      return 'completed'
    }

    rounds++

    // Wrap-up reserve. The prompt tells the agent to record progress AFTER
    // acting ("execute the next action, then update the TODO"), so a turn
    // guillotined at the round cap loses everything it learned — and the next
    // turn, reading the same stale todo/memory, re-derives it from scratch.
    // That is self-sustaining: re-derivation is what exhausts the budget in
    // the first place. Observed on Morg'Thar 2026-09-01: 47 tool calls across
    // 4 turns, 3 of them hitting the cap, ZERO state writes — his todo, his
    // memory and the live game disagreed on his location three ways.
    //
    // Two parts, and the second is why this is not merely a prompt tweak:
    //   1. the loop is allowed a bounded reserve past the cap, so the chance
    //      to persist EXISTS at all (at `maxRounds` the loop simply exited);
    //   2. during the reserve the toolset is REPLACED with the state-writing
    //      tools only, so persisting is the sole legal move. A note alone was
    //      measurably not enough — one turn took the reserve, read the note
    //      and still ended without writing.
    if (!wroteState && !wrapUpInjected && rounds >= maxRounds - 1) {
      wrapUpInjected = true
      restoreTools = context.tools
      context.tools = context.tools.filter(t => STATE_WRITE_TOOLS.has(t.name))
      context.messages.push({
        role: 'user',
        content:
          `⏳ TURN ENDING — you have not recorded anything this turn, so your remaining tool calls ` +
          `are restricted to update_todo and update_memory. Everything you just learned is about to ` +
          `be LOST: the next turn starts from the TODO and memory shown in your prompt, which are ` +
          `now out of date.\n\n` +
          `Write down what you verified, what you finished, and the single next action — so the next ` +
          `turn resumes instead of re-deriving all of this.`,
        timestamp: Date.now(),
      })
      log('system', `Wrap-up reserve: ${rounds}/${maxRounds} rounds used with no state write — restricting tools to update_todo/update_memory`)
    }
  }
  } finally {
    // Unconditional: the turn has nine exit paths and `context` is reused by
    // the next turn. Leaking the narrowed toolset would leave an agent able to
    // do nothing but rewrite its TODO, forever.
    if (restoreTools) context.tools = restoreTools
  }

  if (wroteState) {
    log('system', `Reached max tool rounds (${maxRounds}), ending turn`)
  } else {
    log('system', `Reached max tool rounds (${maxRounds}), ending turn — NO state write this turn; next turn resumes from unchanged TODO/memory`)
  }
  return 'completed'
}

// --- Context compaction ---

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content)
  if (Array.isArray(msg.content)) {
    let total = 0
    for (const block of msg.content) {
      if ('text' in block) total += estimateTokens((block as any).text)
      else if ('name' in block) total += estimateTokens((block as any).name + JSON.stringify((block as any).arguments))
      else if ('thinking' in block) total += estimateTokens((block as any).thinking)
    }
    return total
  }
  return 0
}

function totalMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) total += estimateMessageTokens(msg)
  return total
}

function findTurnBoundary(messages: Message[], idx: number): number {
  for (let i = idx; i < messages.length; i++) {
    if (messages[i].role === 'user') return i
  }
  for (let i = idx - 1; i >= 1; i--) {
    if (messages[i].role === 'user') return i
  }
  return idx
}

function formatMessagesForSummary(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '(complex)'
      lines.push(`[USER] ${text}`)
    } else if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if ('text' in block && (block as any).text?.trim()) {
          lines.push(`[AGENT] ${(block as any).text.trim()}`)
        } else if ('name' in block) {
          const b = block as any
          const args = Object.entries((b.arguments || {}) as Record<string, unknown>)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ')
          lines.push(`[TOOL CALL] ${b.name}(${args})`)
        }
      }
    } else if (msg.role === 'toolResult') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((b: any) => b.text || '').join('')
        : ''
      const trimmed = safeTruncate(text, 500, '...')
      const errorTag = msg.isError ? ' [ERROR]' : ''
      lines.push(`[RESULT${errorTag}] ${msg.toolName}: ${trimmed}`)
    }
  }
  return lines.join('\n')
}

async function compactContext(
  model: Model<any>,
  context: Context,
  compaction?: CompactionState,
  options?: LoopOptions,
): Promise<void> {
  // Proactively truncate oversized tool results to prevent token bloat
  for (const msg of context.messages) {
    if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) {
          const text = (block as any).text
          if (typeof text === 'string' && text.length > 4000) {
            (block as any).text = safeTruncate(text, 3000, '\n...(truncated)')
          }
        }
      }
    }
  }

  const ratio = options?.contextBudgetRatio ?? CONTEXT_BUDGET_RATIO
  const systemPromptTokens = context.systemPrompt ? estimateTokens(context.systemPrompt) : 0
  // Budget = fraction of the space REMAINING after the system prompt, not the full window.
  // The system prompt is large (~30-50k tokens) and fixed — only messages can be compacted.
  // Clamp the usable window to >= 0 and floor the budget: an oversized system
  // prompt (approaching/exceeding the window) would otherwise yield a zero or
  // negative budget, which makes the `messageTokens < messageBudget` guard below
  // always false and compaction thrash (summarize every single turn).
  const usableWindow = Math.max(0, model.contextWindow - systemPromptTokens)
  const minMessageBudget = Math.min(8000, Math.floor(model.contextWindow * 0.15))
  const messageBudget = Math.max(minMessageBudget, Math.floor(usableWindow * ratio))
  const messageTokens = totalMessageTokens(context.messages)

  if (messageTokens < messageBudget) return

  const recentBudget = Math.floor(messageBudget * 0.6)
  let recentTokens = 0
  let splitIdx = context.messages.length

  for (let i = context.messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateMessageTokens(context.messages[i])
    if (recentTokens + msgTokens > recentBudget && splitIdx < context.messages.length - MIN_RECENT_MESSAGES) {
      break
    }
    recentTokens += msgTokens
    splitIdx = i
  }

  splitIdx = findTurnBoundary(context.messages, splitIdx)
  if (splitIdx <= 1) return

  const oldMessages = context.messages.slice(1, splitIdx)
  const recentMessages = context.messages.slice(splitIdx)

  let summary: string
  try {
    summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, options)
  } catch {
    summary = compaction?.summary
      ? compaction.summary + '\n\n(Additional context was lost due to summarization failure.)'
      : '(Earlier session context was lost.)'
  }

  if (compaction) compaction.summary = summary

  const summaryMessage: Message = {
    role: 'user' as const,
    content: `## Session History Summary\n\n${summary}\n\n---\nNow continue your mission. Recent events follow.`,
    timestamp: Date.now(),
  }

  context.messages = [context.messages[0], summaryMessage, ...recentMessages]
}

async function summarizeViaLLM(
  model: Model<any>,
  oldMessages: Message[],
  previousSummary: string | undefined,
  options?: LoopOptions,
): Promise<string> {
  const transcript = formatMessagesForSummary(oldMessages)

  let prompt = 'Summarize this game session transcript. '
  prompt += 'Focus on: (1) what the agent was CURRENTLY DOING and what it planned to do next, '
  prompt += '(2) current location, credits, ship status, cargo, '
  prompt += '(3) active goals, key events, relationships. Be concise.\n\n'

  if (previousSummary) {
    prompt += 'Previous summary:\n' + previousSummary + '\n\n'
  }
  prompt += 'Transcript:\n' + transcript

  const summaryCtx: Context = {
    systemPrompt: 'You are a concise summarizer. Output only the summary, no preamble.',
    messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }],
  }

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), 30_000)
  const signal = options?.signal
    ? combineAbortSignals(options.signal, timeoutController.signal)
    : timeoutController.signal

  try {
    scrubContextSurrogates(summaryCtx)
    const resp = await complete(model, summaryCtx, {
      signal,
      apiKey: options?.apiKey,
      maxTokens: SUMMARY_MAX_TOKENS,
    })
    clearTimeout(timeout)

    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => 'text' in b)
      .map(b => b.text)
      .join('')

    if (!text.trim()) throw new Error('Empty summary')
    return text.trim()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

// --- LLM call with retry ---

/** Exported for tests: the abort/timeout handling here is the difference
 *  between a stalled local model retrying and the same model being silently
 *  scored as an idle agent. */
export async function completeWithRetry(
  model: Model<any>,
  context: Context,
  log: LogFn,
  options?: LoopOptions,
  compaction?: CompactionState,
): Promise<AssistantMessage> {
  let lastError: Error | null = null
  let abortAttempts = 0

  const timeoutMs = options?.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS
  // Mutable across attempts: an OAuth rotation mid-turn invalidates the key we
  // started with, and retrying with it can only ever 401 again.
  let apiKey = options?.apiKey

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)

      const signal = options?.signal
        ? combineAbortSignals(options.signal, timeoutController.signal)
        : timeoutController.signal

      try {
        scrubContextSurrogates(context)
        const result = await complete(model, context, {
          signal,
          apiKey,
          maxTokens: options?.maxTokens ?? 4096,
          cacheRetention: 'long',
        })
        clearTimeout(timeout)

        if (result.stopReason === 'error') {
          throw new Error(result.errorMessage || 'LLM returned an error response')
        }
        if (result.content.length === 0) {
          throw new Error('LLM returned empty response')
        }
        // A timed-out call can come back as a *successful-looking* result:
        // stopReason 'aborted' with a partial `thinking` block and 0/0 usage.
        // It clears both guards above, so it used to be returned as a real
        // response — which the turn loop then read as "zero tool calls", i.e.
        // a deliberate no-op, and scored as an idle turn (see the `rounds === 0`
        // branch below). Observed 2026-09-01: Morg'Thar on a local 27B dense
        // model aborted 6 of 8 calls at exactly 90s, each one starting a brand
        // new turn that re-ran read_todo/read_memory/get_status from scratch,
        // then tripped the idle backoff and sat unreachable until nudged.
        // Local reasoning models spend their whole budget thinking, so this is
        // their normal failure mode, not an edge case. Route it into the retry
        // path where it belongs.
        if (result.stopReason === 'aborted' && !options?.signal?.aborted) {
          throw new Error(
            `LLM call aborted after ${timeoutMs / 1000}s with no tool call ` +
            `(partial output discarded) — likely the generation budget, not a stall.`,
          )
        }

        return result
      } catch (err) {
        clearTimeout(timeout)
        if (timeoutController.signal.aborted && !options?.signal?.aborted) {
          throw new Error(`LLM call timed out after ${timeoutMs / 1000}s`)
        }
        throw err
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (options?.signal?.aborted) throw lastError

      // Tool-pairing repair: a connection drop mid-tool-call can leave the
      // message history with orphaned tool_use/tool_result blocks, which the
      // API rejects with a 400 on EVERY subsequent call — an unrecoverable
      // retry loop that resends the full context each time (observed: 5 agents
      // x ~100 failed calls overnight). Scrub the orphans and let the retry
      // proceed with a valid history.
      if (/tool_use_id|tool_use.*tool_result|tool_result.*tool_use/i.test(lastError.message)) {
        const removed = sanitizeToolPairing(context)
        if (removed > 0) {
          log('system', `Tool-pairing repair: removed ${removed} orphaned tool block(s)/message(s) from context; retrying.`)
        }
      }

      // Emergency compaction: if "prompt is too long", force-compact context
      const isOverflow = lastError.message.includes('prompt is too long') ||
        lastError.message.includes('too many tokens') ||
        lastError.message.includes('maximum context length')
      if (isOverflow && context.messages.length > 4) {
        log('system', `Emergency compaction: context overflow detected (${context.messages.length} messages). Force-compacting...`)
        const compactModel = options?.compactionModel || model
        await emergencyCompact(compactModel, context, compaction, options)
        const sysToks = context.systemPrompt ? estimateTokens(context.systemPrompt) : 0
        const msgToks = totalMessageTokens(context.messages)
        log('system', `Emergency compaction complete: ${context.messages.length} messages, ~${sysToks + msgToks} total tokens (system: ${sysToks}, messages: ${msgToks})`)
      }

      // Auth failure: the token, not the request, is what's broken. Re-resolve it
      // before sleeping — for claude-max that re-reads the credentials file that
      // another process (Claude Code, or our own refresh) just rotated.
      const isAuthError = lastError.message.includes('authentication_error') ||
        lastError.message.includes('has been revoked') ||
        lastError.message.includes('401')
      if (isAuthError && options?.refreshApiKey) {
        try {
          const fresh = await options.refreshApiKey()
          if (fresh && fresh !== apiKey) {
            apiKey = fresh
            log('system', 'Auth error — re-resolved provider credentials; retrying immediately.')
            continue  // Skip the backoff: a fresh token should work now.
          }
        } catch (err) {
          log('system', `Auth error — credential refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Timeout aborts are not transient the way a malformed-JSON blip is:
      // the prompt and the budget are identical on every attempt, so a call
      // that ran out of clock will usually do it again. Burning the full 5
      // attempts at a local provider's 300s timeout would tie one agent up for
      // ~25 minutes on a single turn — worse than the failure it replaces.
      // Allow one retry (covers a genuine one-off stall, e.g. another agent
      // monopolising the local server) and then give up on the turn.
      const isAbort = lastError.message.includes('LLM call aborted after')
      if (isAbort) {
        abortAttempts++
        if (abortAttempts > MAX_ABORT_RETRIES) {
          log('error',
            `LLM aborted ${abortAttempts}x on this turn — ending it rather than retrying further. ` +
            `The model is not finishing inside its time budget: raise the \`llm_timeout\` preference, ` +
            `lower maxTokens, or move this agent to a faster (MoE) model.`)
          throw lastError
        }
      }

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
      log('error', `LLM error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`, JSON.stringify({
        model: { name: (model as any).name || 'unknown', contextWindow: model.contextWindow },
        messageCount: context.messages.length,
        estimatedTokens: totalMessageTokens(context.messages),
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        error: lastError.message,
      }, null, 2))
      await sleep(delay)
    }
  }

  throw lastError || new Error('LLM call failed after retries')
}

/**
 * Enforce tool_use/tool_result pairing across the message history. Returns the
 * number of removed messages/blocks. Two failure shapes are repaired:
 *  - a toolResult whose toolCallId has no preceding assistant toolCall block
 *  - an assistant toolCall block with no toolResult anywhere after it
 * Messages left with no content are dropped entirely.
 */
function sanitizeToolPairing(context: Context): number {
  // Existence-based pairing is NOT enough: the Anthropic API requires every
  // tool_result to sit in the message(s) IMMEDIATELY after its tool_use.
  // Compaction and mid-turn reconnects produce contexts where both halves of
  // a pair exist but are no longer adjacent — the old existence check removed
  // nothing while the API kept rejecting with a 400 on messages.N.content.M
  // (observed on two agents overnight 2026-08-27, both needing manual loop
  // restarts). Enforce adjacency: a toolResult is kept only while its id is
  // pending from the assistant message just before it; unresolved calls are
  // stripped the moment any other message intervenes.
  let removed = 0
  const kept: any[] = []
  let pending: Set<string> | null = null
  let pendingMsg: any = null

  const flushPending = () => {
    if (pending && pending.size > 0 && pendingMsg) {
      const stale = pending
      pendingMsg.content = pendingMsg.content.filter(
        (b: any) => !(b.type === 'toolCall' && b.id && stale.has(b.id)))
      removed += stale.size
      if (pendingMsg.content.length === 0) {
        const i = kept.indexOf(pendingMsg)
        if (i >= 0) kept.splice(i, 1)
        removed++
      }
    }
    pending = null
    pendingMsg = null
  }

  for (const msg of context.messages as any[]) {
    if (msg.role === 'toolResult') {
      if (pending && msg.toolCallId && pending.has(msg.toolCallId)) {
        pending.delete(msg.toolCallId)
        kept.push(msg)
        if (pending.size === 0) { pending = null; pendingMsg = null }
      } else {
        removed++ // orphaned or out-of-position result
      }
      continue
    }
    flushPending()
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const ids = msg.content
        .filter((b: any) => b.type === 'toolCall' && b.id)
        .map((b: any) => b.id as string)
      kept.push(msg)
      if (ids.length > 0) { pending = new Set(ids); pendingMsg = msg }
    } else {
      kept.push(msg)
    }
  }
  flushPending()
  context.messages = kept
  return removed
}

/**
 * Emergency compaction: aggressively trim context when API reports overflow.
 * Keeps only the last ~30% of messages and truncates large tool results.
 */
async function emergencyCompact(
  model: Model<any>,
  context: Context,
  compaction?: CompactionState,
  options?: LoopOptions,
): Promise<void> {
  // First, truncate oversized tool results in-place
  for (const msg of context.messages) {
    if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) {
          const text = (block as any).text
          if (typeof text === 'string' && text.length > 2000) {
            (block as any).text = safeTruncate(text, 1500, '\n...(truncated)')
          }
        }
      }
    }
  }

  // Keep only last 30% of messages (at least MIN_RECENT_MESSAGES)
  const keepCount = Math.max(MIN_RECENT_MESSAGES, Math.floor(context.messages.length * 0.3))
  if (context.messages.length <= keepCount + 1) return

  const splitIdx = findTurnBoundary(context.messages, context.messages.length - keepCount)
  if (splitIdx <= 1) return

  const oldMessages = context.messages.slice(1, splitIdx)
  const recentMessages = context.messages.slice(splitIdx)

  let summary: string
  try {
    summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, options)
  } catch {
    // Last resort: just drop old messages without summarizing
    summary = compaction?.summary || '(Earlier session context was dropped due to overflow.)'
  }

  if (compaction) compaction.summary = summary

  const summaryMessage: Message = {
    role: 'user' as const,
    content: `## Session History Summary (emergency compaction)\n\n${summary}\n\n---\nContinue your mission. Recent events follow.`,
    timestamp: Date.now(),
  }

  context.messages = [context.messages[0], summaryMessage, ...recentMessages]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}
