import { describe, expect, mock, test } from 'bun:test'

/**
 * Wrap-up reserve.
 *
 * The system prompt tells the agent to record progress AFTER acting ("execute
 * the next action, then update the TODO"). A turn guillotined at the tool-round
 * cap therefore loses everything it learned, and the next turn — reading the
 * same unchanged todo/memory — re-derives it from scratch. That re-derivation
 * is what exhausts the round budget, so the failure sustains itself.
 *
 * Observed on Morg'Thar (2026-09-01, custom/gpt-oss-120b): 47 tool calls across
 * 4 turns, 3 of them hitting the cap, and ZERO state writes. His TODO said he
 * was at Blood Forge, his memory said The Rampart, and the game said Krynn.
 *
 * These tests pin the reserve: an agent that never persists gets prompted and
 * given bounded extra rounds to do it, and an agent that already persisted is
 * not given anything extra.
 */

function ctx() {
  return { systemPrompt: 'sys', messages: [] as any[], tools: [] } as any
}

function model() {
  return { name: 'test-model', contextWindow: 32_000 } as any
}

function queryCall(id: string) {
  return { type: 'toolCall', id, name: 'game', arguments: { command: 'get_status' } }
}

function assistant(content: any[]) {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    content,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }
}

async function loadLoop(completeImpl: (...args: any[]) => any) {
  const actual = await import('@mariozechner/pi-ai')
  mock.module('@mariozechner/pi-ai', () => ({ ...actual, complete: completeImpl }))
  return await import('../src/server/lib/loop')
}

function stubConnection() {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    execute: async () => ({ result: 'ok' }),
    onNotification: () => {},
    getLocalState: () => null,
  } as any
}

describe('wrap-up reserve', () => {
  test('an agent that never persists is warned and given reserve rounds', async () => {
    const logs: Array<[string, string]> = []
    let round = 0
    const names: string[] = []

    const { runAgentTurn } = await loadLoop(async () => {
      round++
      return assistant([queryCall(`c${round}`)])
    })

    await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-wrapup-1', 'Test',
      ((t: string, s: string) => { logs.push([t, s]); if (t === 'tool_call') names.push(s) }) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    // The agent is told, explicitly, that its turn is ending unrecorded.
    expect(logs.some(([t, s]) => t === 'system' && s.includes('Wrap-up reserve'))).toBe(true)
    // ...and the turn is flagged as having persisted nothing.
    expect(logs.some(([t, s]) => t === 'system' && s.includes('NO TODO write'))).toBe(true)
    // The reserve is bounded — it does not become open-ended budget.
    expect(round).toBeLessThanOrEqual(4 + 2)
  }, 30_000)

  test('an agent that persists is not given reserve rounds', async () => {
    const logs: Array<[string, string]> = []
    let round = 0

    const { runAgentTurn } = await loadLoop(async () => {
      round++
      // Persist on the very first round, then keep querying.
      if (round === 1) {
        return assistant([{ type: 'toolCall', id: 'w1', name: 'update_todo', arguments: { content: 'done' } }])
      }
      return assistant([queryCall(`c${round}`)])
    })

    await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-wrapup-2', 'Test',
      ((t: string, s: string) => { logs.push([t, s]) }) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    // No nagging, and no extra rounds beyond the normal cap.
    expect(logs.some(([t, s]) => t === 'system' && s.includes('Wrap-up reserve'))).toBe(false)
    expect(logs.some(([t, s]) => t === 'system' && s.includes('NO TODO write'))).toBe(false)
    expect(round).toBe(4)
  }, 30_000)

  test('persisting inside the reserve closes the turn immediately', async () => {
    let round = 0
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      // Burn the whole normal budget, then comply with the wrap-up prompt.
      if (round <= 4) return assistant([queryCall(`c${round}`)])
      return assistant([{ type: 'toolCall', id: 'w', name: 'update_todo', arguments: { content: 'x' } }])
    })

    await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-wrapup-3', 'Test',
      (() => {}) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    // 4 normal rounds + a single reserve round that persisted — the second
    // reserve round is not spent once the state write has happened.
    expect(round).toBe(5)
  }, 30_000)

  test('the reserve refuses everything but state writes at dispatch, without touching the toolset', async () => {
    const logs: Array<[string, string]> = []
    let round = 0
    const toolsSeenPerRound: string[][] = []
    const c = ctx()
    c.tools = [
      { name: 'game', description: '', parameters: {} },
      { name: 'update_todo', description: '', parameters: {} },
      { name: 'update_memory', description: '', parameters: {} },
      { name: 'codex', description: '', parameters: {} },
    ]
    const originalTools = c.tools
    let executed = 0
    const conn = stubConnection()
    conn.execute = async () => { executed++; return { result: 'ok' } }

    const { runAgentTurn } = await loadLoop(async (_m: any, context: any) => {
      round++
      toolsSeenPerRound.push(context.tools.map((t: any) => t.name))
      return assistant([queryCall(`c${round}`)])
    })

    await runAgentTurn(
      model(), c, conn, 'p-wrapup-4', 'Test',
      ((t: string, s: string) => { logs.push([t, s]) }) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    // The declared toolset is never swapped: on a harmony-format local server a
    // different tool list rewrites the developer message and re-prefills the
    // KV cache, and executeTool runs whatever the model names anyway.
    expect(c.tools).toBe(originalTools)
    for (const seen of toolsSeenPerRound) expect(seen).toContain('game')

    // Once the reserve engages, a query is refused at dispatch — it never
    // reaches the game — and the refusal is what the model reads back.
    const results = c.messages.filter((m: any) => m.role === 'toolResult')
    const refused = results.filter((m: any) => m.content[0].text.startsWith('Not executed — wrap-up reserve'))
    expect(refused.length).toBeGreaterThan(0)
    expect(executed).toBeLessThan(round)
    expect(logs.some(([t, s]) => t === 'system' && s.includes('refused game'))).toBe(true)
  }, 30_000)

  test('a refused reserve call still gets a tool result, so the history stays paired', async () => {
    let round = 0
    const c = ctx()
    c.tools = [
      { name: 'game', description: '', parameters: {} },
      { name: 'update_todo', description: '', parameters: {} },
      { name: 'update_memory', description: '', parameters: {} },
    ]

    const { runAgentTurn } = await loadLoop(async () => {
      round++
      return assistant([queryCall(`c${round}`), queryCall(`d${round}`)])
    })

    await runAgentTurn(
      model(), c, stubConnection(), 'p-wrapup-5', 'Test',
      (() => {}) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const m of c.messages) {
      if (m.role === 'assistant') for (const b of m.content) if (b.type === 'toolCall') callIds.add(b.id)
      if (m.role === 'toolResult') resultIds.add(m.toolCallId)
    }
    expect(callIds.size).toBeGreaterThan(0)
    expect([...callIds].every((id) => resultIds.has(id))).toBe(true)
  }, 30_000)

  test('a memory-only write does not satisfy operational persistence', async () => {
    const logs: Array<[string, string]> = []
    let round = 0
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      if (round === 1) {
        return assistant([{ type: 'toolCall', id: 'm1', name: 'update_memory', arguments: { content: 'market unavailable' } }])
      }
      if (round <= 4) return assistant([queryCall(`c${round}`)])
      return assistant([{ type: 'toolCall', id: 't1', name: 'update_todo', arguments: { content: 'move on' } }])
    })

    await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-wrapup-memory-only', 'Test',
      ((t: string, s: string) => { logs.push([t, s]) }) as any,
      { value: 'buy unavailable ammo' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    expect(logs.some(([t, s]) => t === 'system' && s.includes('no TODO write (memory was updated)'))).toBe(true)
    expect(round).toBe(5)
  }, 30_000)
})
