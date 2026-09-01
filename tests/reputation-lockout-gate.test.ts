import { describe, expect, test } from 'bun:test'

/**
 * Reputation lockout gate.
 *
 * A station that has refused you does not change its mind because you flew
 * back. Morg'Thar (2026-09-01) attacked a faction target sitting under Voss
 * Redoubt Station's guns, dropped to -5 reputation and was refused docking —
 * then returned to Alhena and was refused again at -10, burning fuel and turns
 * on a guaranteed rejection each time.
 *
 * The directive already told him not to attack near stations. This is the gate
 * that makes the follow-on loop impossible rather than discouraged.
 */

function stubConnection(behaviour: { refuse: boolean }, seen: string[]) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    getLocalState: () => ({ location: { system_name: 'alhena' }, player: {} }),
    onNotification: () => {},
    execute: async (command: string) => {
      seen.push(command)
      if (command === 'dock' && behaviour.refuse) {
        return {
          error: {
            code: 'insufficient_reputation',
            message: 'Access denied. Your reputation with this faction is too low (current: -10).',
          },
        }
      }
      return { result: 'ok' }
    },
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

describe('reputation lockout gate', () => {
  test('a second dock attempt after a reputation refusal is blocked locally', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-rep-${Math.random()}`
    const seen: string[] = []
    const conn = stubConnection({ refuse: true }, seen)

    // First attempt reaches the game and is refused there.
    const first = await executeTool('game', { command: 'dock' }, ctxFor(conn, pid))
    expect(first).toContain('insufficient_reputation')
    // The refusal carries the way out, not just the rejection.
    expect(first).toContain('does not recover by returning')

    const dockCallsAfterFirst = seen.filter(c => c === 'dock').length
    expect(dockCallsAfterFirst).toBe(1)

    // Second attempt must not even reach the server.
    const second = await executeTool('game', { command: 'dock' }, ctxFor(conn, pid))
    expect(second).toContain('BLOCKED by Admiral doctrine')
    expect(second).toContain('alhena')
    expect(seen.filter(c => c === 'dock').length).toBe(1)
  })

  test('a different agent is unaffected by another agent lockout', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    const conn = stubConnection({ refuse: true }, seen)

    await executeTool('game', { command: 'dock' }, ctxFor(conn, `p-rep-a-${Math.random()}`))
    // A second, unrelated profile has its own standing.
    const other = await executeTool('game', { command: 'dock' }, ctxFor(conn, `p-rep-b-${Math.random()}`))

    expect(other).not.toContain('BLOCKED by Admiral doctrine')
  })

  test('the gate can be switched off by preference', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const { setPreference } = await import('../src/server/lib/db')
    const pid = `p-rep-off-${Math.random()}`
    const seen: string[] = []
    const conn = stubConnection({ refuse: true }, seen)

    await executeTool('game', { command: 'dock' }, ctxFor(conn, pid))
    setPreference('reputation_gate', 'off')
    try {
      const second = await executeTool('game', { command: 'dock' }, ctxFor(conn, pid))
      expect(second).not.toContain('BLOCKED by Admiral doctrine')
      expect(seen.filter(c => c === 'dock').length).toBe(2)
    } finally {
      setPreference('reputation_gate', '')
    }
  })
})
