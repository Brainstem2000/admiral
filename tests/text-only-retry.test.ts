import { describe, expect, mock, test } from 'bun:test'

/**
 * Text-only first round.
 *
 * gpt-oss-120b (Morg'Thar, 2026-09-02 09:31 CT) answered the wrap-up prompt in
 * prose three turns running — "**TODO Updated** … single next action:
 * reload(id=…)" — with no tool call. The reload was never sent, the TODO never
 * written, and the idle backoff parked him for it. A text-only first round now
 * gets exactly one "call the tool" retry before the turn scores idle.
 */

function ctx() {
  return { systemPrompt: 'sys', messages: [] as any[], tools: [] } as any
}

function model() {
  return { name: 'test-model', contextWindow: 32_000 } as any
}

function usage() {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
}

function assistantText(text: string) {
  return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: usage() }
}

function assistantCall(id: string) {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id, name: 'update_todo', arguments: { content: 'next: reload' } }],
    usage: usage(),
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

describe('text-only first round', () => {
  test('gets one explicit retry, and a tool call on the retry rescues the turn', async () => {
    let round = 0
    const c = ctx()
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      if (round === 1) return assistantText('**TODO Updated** — single next action: reload(id="abc", target="ferrous_slug_case")')
      return assistantCall('w1')
    })

    const outcome = await runAgentTurn(
      model(), c, stubConnection(), 'p-text-1', 'Test',
      (() => {}) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    // Not idle: the retry produced a real tool call and the turn ran on from there.
    expect(outcome).toBe('completed')
    expect(round).toBeGreaterThanOrEqual(2)
    expect(c.messages.some((m: any) => m.role === 'user' && /text, not an action/.test(m.content))).toBe(true)
    // Exactly one retry note, however long the turn ran afterwards.
    expect(c.messages.filter((m: any) => m.role === 'user' && /text, not an action/.test(m.content)).length).toBe(1)
  }, 30_000)

  test('a second text-only answer scores idle instead of retrying forever', async () => {
    let round = 0
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      return assistantText('still just describing what I would do')
    })

    const outcome = await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-text-2', 'Test',
      (() => {}) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    expect(outcome).toBe('idle')
    expect(round).toBe(2)
  }, 30_000)

  test('a game() call printed as JSON text is executed as the call it meant, with no retry', async () => {
    let round = 0
    const c = ctx()
    const executed: string[] = []
    const conn = stubConnection()
    conn.execute = async (command: string) => { executed.push(command); return { result: 'ok' } }
    const logs: string[] = []
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      if (round === 1) return assistantText('{\n  "command": "get_status",\n  "args": {}\n}')
      return assistantCall(`w${round}`)
    })

    const outcome = await runAgentTurn(
      model(), c, conn, 'p-text-4', 'Test',
      ((t: string, s: string) => { logs.push(`${t}:${s}`) }) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    expect(outcome).toBe('completed')
    expect(executed[0]).toBe('get_status')
    expect(logs.some((l) => l.includes('Recovered a tool call'))).toBe(true)
    expect(c.messages.some((m: any) => m.role === 'user' && /text, not an action/.test(m.content))).toBe(false)
    // The rewritten assistant message and its result are paired, so the history stays valid.
    const first = c.messages.find((m: any) => m.role === 'assistant')
    expect(first.content[0].type).toBe('toolCall')
    expect(c.messages.some((m: any) => m.role === 'toolResult' && m.toolCallId === first.content[0].id)).toBe(true)
  }, 30_000)

  test('a response with no text at all (nothing to retry) is idle immediately', async () => {
    let round = 0
    const { runAgentTurn } = await loadLoop(async () => {
      round++
      return { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hmm' }], usage: usage() }
    })

    const outcome = await runAgentTurn(
      model(), ctx(), stubConnection(), 'p-text-3', 'Test',
      (() => {}) as any,
      { value: '' } as any, { value: '' } as any,
      { maxToolRounds: 4 },
    )

    expect(outcome).toBe('idle')
    expect(round).toBe(1)
  }, 30_000)
})
