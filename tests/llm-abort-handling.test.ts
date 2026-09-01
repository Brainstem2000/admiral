import { describe, expect, mock, test } from 'bun:test'

/**
 * Regression cover for the local-model "endless decision loop".
 *
 * Observed 2026-09-01 (Morg'Thar on custom/Qwen3.8-27B-MLX-8bit): 6 of 8 LLM
 * calls came back `stopReason: 'aborted'` at exactly the 90s timeout, each
 * carrying a truncated `thinking` block and 0/0 usage. That shape cleared both
 * of completeWithRetry's guards — it is not `stopReason: 'error'`, and its
 * content is not empty — so it was returned as a legitimate response. The turn
 * loop then saw zero tool calls on round 0, scored the turn `idle`, and after
 * three of them tripped the idle backoff, which parked the agent until a human
 * nudged it. The model was never stuck; it was being killed mid-thought and
 * restarted from scratch every time.
 *
 * These tests pin the two properties that fix it: an aborted result is an
 * error (so it reaches the retry path instead of masquerading as a no-op),
 * and abort retries are capped so a chronically slow model cannot tie an
 * agent up for MAX_RETRIES * timeout.
 */

const noopLog = (() => {}) as unknown as Parameters<typeof import('../src/server/lib/loop').completeWithRetry>[2]

function ctx() {
  return { systemPrompt: 'sys', messages: [], tools: [] } as any
}

function model() {
  return { name: 'local-test-model', contextWindow: 32_000 } as any
}

/** The exact shape a timed-out local reasoning model returns. */
function abortedResponse() {
  return {
    role: 'assistant',
    stopReason: 'aborted',
    content: [{ type: 'thinking', thinking: 'Buy ammo (ensure' }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }
}

function toolUseResponse() {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 't1', name: 'read_todo', arguments: {} }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }
}

async function loadLoopWith(completeImpl: (...args: any[]) => any) {
  // Preserve the rest of pi-ai's surface — other modules in the import graph
  // (model resolution, in particular) need `getModel` and friends. Only the
  // network call is swapped out.
  const actual = await import('@mariozechner/pi-ai')
  mock.module('@mariozechner/pi-ai', () => ({ ...actual, complete: completeImpl }))
  return await import('../src/server/lib/loop')
}

describe('aborted LLM responses', () => {
  test('an aborted response is not returned as a valid turn', async () => {
    let calls = 0
    const { completeWithRetry } = await loadLoopWith(async () => {
      calls++
      return abortedResponse()
    })

    await expect(
      completeWithRetry(model(), ctx(), noopLog, { llmTimeoutMs: 1_000 }),
    ).rejects.toThrow(/aborted/i)

    // It must actually retry rather than accept the first abort as a no-op,
    // but must NOT burn all 5 general-purpose retries: at a local provider's
    // 300s timeout that would tie the agent up for ~25 minutes on one turn.
    expect(calls).toBe(2)
  }, 30_000)

  test('a transient abort recovers on retry', async () => {
    let calls = 0
    const { completeWithRetry } = await loadLoopWith(async () => {
      calls++
      return calls === 1 ? abortedResponse() : toolUseResponse()
    })

    const result: any = await completeWithRetry(
      model(), ctx(), noopLog, { llmTimeoutMs: 1_000 },
    )

    expect(result.stopReason).toBe('toolUse')
    expect(calls).toBe(2)
  }, 30_000)

  test('a caller-initiated abort is handed back without spending retries', async () => {
    const controller = new AbortController()
    controller.abort()

    let calls = 0
    const { completeWithRetry } = await loadLoopWith(async () => {
      calls++
      return abortedResponse()
    })

    // A nudge / stop / turn-restart is not a slow model. The result is passed
    // straight back for the turn loop to interpret (it checks `signal.aborted`
    // and ends the turn); retrying here would fight the operator.
    const result: any = await completeWithRetry(
      model(), ctx(), noopLog, { llmTimeoutMs: 1_000, signal: controller.signal },
    )

    expect(result.stopReason).toBe('aborted')
    expect(calls).toBe(1)
  }, 30_000)
})
