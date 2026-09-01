import { describe, expect, test } from 'bun:test'

/**
 * The v2 API exposes the same query in two spellings: a grouped command name
 * (`facility_owned`) and the group command carrying the action as an argument
 * (`facility` + {action:'owned'}). They ask the same question and return the
 * same answer.
 *
 * Keyed literally they look like different calls, so the query cache missed
 * and — worse — the identical-call loop breakers never saw a repeat.
 *
 * Morg'Thar, 2026-09-01: 22 facility calls across four spellings while the
 * game answered `facilities: []` every time. The breaker treated them as four
 * separate questions and only fired once a fifth exact repeat lined up.
 *
 * This is keying only. What gets SENT to the game must not change.
 */

function stubConnection(seen: string[]) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    execute: async (command: string) => {
      seen.push(command)
      return { result: 'facilities: []' }
    },
    onNotification: () => {},
    getLocalState: () => null,
  } as any
}

function ctxFor(connection: any, profileId: string, logs: string[] = []) {
  return {
    connection,
    profileId,
    profileName: 'Test',
    log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) },
    todo: '',
    memory: '',
  } as any
}

describe('command spelling canonicalisation', () => {
  test('the two spellings of one query collapse to a single loop-breaker key', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const logs: string[] = []
    const seen: string[] = []
    const pid = `p-canon-${Math.random()}`
    const conn = stubConnection(seen)

    // Four spellings of "what facilities do I own", alternating forms — the
    // exact shape Morg'Thar produced.
    await executeTool('game', { command: 'facility_owned' }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility', args: { action: 'owned' } }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility_owned' }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility', args: { action: 'owned' } }, ctxFor(conn, pid, logs))

    // Previously these were four distinct keys and nothing fired. They are one
    // question, so the repeat detector must see them as one.
    const noticed = logs.some(l => l.includes('QUERY LOOP') || l.includes('loop-break'))
    expect(noticed).toBe(true)
  })

  test('canonicalisation does not change what is sent to the game', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    const pid = `p-canon-send-${Math.random()}`

    await executeTool('game', { command: 'facility', args: { action: 'owned' } }, ctxFor(stubConnection(seen), pid))

    // The group form must go out on the wire exactly as the model wrote it —
    // only the cache/loop KEY is normalised.
    expect(seen[0]).toBe('facility')
  })

  test('genuinely different actions stay distinct', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const logs: string[] = []
    const seen: string[] = []
    const pid = `p-canon-distinct-${Math.random()}`
    const conn = stubConnection(seen)

    // Four DIFFERENT questions must not be mistaken for a loop.
    await executeTool('game', { command: 'facility', args: { action: 'owned' } }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility', args: { action: 'list' } }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility', args: { action: 'types' } }, ctxFor(conn, pid, logs))
    await executeTool('game', { command: 'facility', args: { action: 'upgrades' } }, ctxFor(conn, pid, logs))

    expect(logs.some(l => l.includes('QUERY LOOP'))).toBe(false)
  })
})
