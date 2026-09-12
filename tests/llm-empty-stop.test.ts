import { describe, expect, mock, test } from 'bun:test'

/**
 * CyberSpock, 2026-09-12 04:26 CT: standing by docked on orders ("one status_log
 * and nothing else"), Sonnet answered the round after the status_log with a
 * completed reply carrying no content blocks. completeWithRetry treated every
 * empty reply as a transport failure and retried it five times — six hosted
 * calls per idle turn, forever. A completed reply with real usage and nothing
 * to say is the model's "nothing to do": hand it back so the turn loop scores
 * the round (idle → the idle backoff parks the agent, which is the intent).
 * A reply with no usage at all is still a broken call and keeps retrying.
 */
const noopLog = (() => {}) as unknown as Parameters<typeof import('../src/server/lib/loop').completeWithRetry>[2]
function ctx() { return { systemPrompt: 'sys', messages: [], tools: [] } as any }
function model() { return { name: 'hosted-test-model', contextWindow: 200_000 } as any }
function emptyStop(usage: { input: number; cacheRead: number }) {
  return { role: 'assistant', stopReason: 'stop', content: [], usage: { input: usage.input, output: 1, cacheRead: usage.cacheRead, cacheWrite: 0, cost: { total: 0 } } }
}
function toolUseResponse() {
  return { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't1', name: 'read_todo', arguments: {} }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }
}
async function loadLoopWith(completeImpl: (...args: any[]) => any) {
  const actual = await import('@mariozechner/pi-ai')
  mock.module('@mariozechner/pi-ai', () => ({ ...actual, complete: completeImpl }))
  return await import('../src/server/lib/loop')
}

describe('empty completed LLM replies', () => {
  test('a completed reply with real usage and no content is returned once, not retried', async () => {
    let calls = 0
    const { completeWithRetry } = await loadLoopWith(async () => { calls++; return emptyStop({ input: 3, cacheRead: 63_500 }) })
    const result: any = await completeWithRetry(model(), ctx(), noopLog, { llmTimeoutMs: 1_000 })
    expect(result.stopReason).toBe('stop')
    // A content-less assistant message would be rejected by the API on the next
    // call, so the reply is handed back with a placeholder text block instead.
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toContain('nothing to do')
    expect(calls).toBe(1)
  }, 30_000)

  test('an empty reply with no usage is still a failed call that retries', async () => {
    let calls = 0
    const { completeWithRetry } = await loadLoopWith(async () => { calls++; return calls === 1 ? emptyStop({ input: 0, cacheRead: 0 }) : toolUseResponse() })
    const result: any = await completeWithRetry(model(), ctx(), noopLog, { llmTimeoutMs: 1_000 })
    expect(result.stopReason).toBe('toolUse')
    expect(calls).toBe(2)
  }, 30_000)
})
