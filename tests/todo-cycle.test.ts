import { describe, expect, mock, test } from 'bun:test'

/**
 * TODO once per cycle.
 *
 * Turns end on the first successful game action. The wrap-up (TODO write) is
 * demanded only when a full cycle of `maxToolRounds` rounds has accumulated
 * since the profile last wrote its TODO — counted ACROSS turns — or at the
 * round cap. Per-action wrap-ups rewrote the TODO every ~20s on Morg'Thar
 * (2026-09-02) and provoked prose "TODO Updated …" replies instead of actions.
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
function call(id: string, name: string, args: any) {
  return { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }], usage: usage() }
}
const query = (id: string) => call(id, 'game', { command: 'get_status' })
const action = (id: string) => call(id, 'game', { command: 'undock' })
const todo = (id: string) => call(id, 'update_todo', { content: 'next: hunt' })

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
function run(loop: any, c: any, pid: string, logs: string[], impl: any, max = 4) {
  return loop.runAgentTurn(
    model(), c, stubConnection(), pid, 'Test',
    ((t: string, s: string) => { logs.push(`${t}:${s}`) }) as any,
    { value: '' } as any, { value: '' } as any,
    { maxToolRounds: max },
  )
}

describe('TODO once per cycle', () => {
  test('an action early in the cycle ends the turn with no wrap-up', async () => {
    let round = 0
    const logs: string[] = []
    const loop = await loadLoop(async () => { round++; return action(`a${round}`) })
    const outcome = await run(loop, ctx(), `p-cycle-${Math.random()}`, logs, null)
    expect(outcome).toBe('completed')
    expect(round).toBe(1)
    expect(logs.some((l) => l.includes('Wrap-up reserve'))).toBe(false)
    expect(logs.some((l) => l.includes('TODO refresh due in'))).toBe(true)
  }, 30_000)

  test('once a full cycle has accumulated across turns, the next action demands the TODO', async () => {
    const pid = `p-cycle-${Math.random()}`
    let round = 0
    let phase: 'burn' | 'act' = 'burn'
    const logs: string[] = []
    const loop = await loadLoop(async () => {
      round++
      if (phase === 'burn') return query(`q${round}`)          // never writes the TODO
      return round % 2 === 1 ? action(`a${round}`) : todo(`t${round}`)
    })

    // Turn 1: four query rounds, cap reached, reserve refused — TODO never written.
    await run(loop, ctx(), pid, logs, null, 4)
    expect(logs.some((l) => l.includes('NO TODO write'))).toBe(true)

    // Turn 2: first action now carries the wrap-up, and the TODO write closes it.
    phase = 'act'
    round = 0
    logs.length = 0
    const outcome = await run(loop, ctx(), pid, logs, null, 4)
    expect(outcome).toBe('completed')
    expect(logs.some((l) => l.includes('Wrap-up reserve: action completed'))).toBe(true)
    expect(logs.some((l) => l.includes('TODO recorded in the wrap-up reserve'))).toBe(true)

    // Turn 3: the counter was reset by the write — back to action-and-done.
    round = 0
    logs.length = 0
    await run(loop, ctx(), pid, logs, null, 4)
    expect(logs.some((l) => l.includes('Wrap-up reserve'))).toBe(false)
    expect(logs.some((l) => l.includes('TODO refresh due in'))).toBe(true)
  }, 60_000)
})
