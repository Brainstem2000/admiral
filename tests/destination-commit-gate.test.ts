import { describe, expect, test } from 'bun:test'

/**
 * Destination-commit gate.
 *
 * An agent that re-picks its destination every turn travels constantly and
 * accomplishes nothing anywhere. Morg'Thar, 2026-09-01: stillwater -> bharani
 * -> the_crucible inside six minutes without working any of them, the last
 * being a system his own memory recorded as explored and depleted. Earlier the
 * same day he bounced krynn -> iron_reach -> krynn twice.
 *
 * The directive said "PICK A DESTINATION AND COMMIT" in capitals and the churn
 * continued, which is why this is a gate and not another paragraph.
 */

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

function ctxFor(profileId: string, logs: string[] = []) {
  return {
    connection: stubConnection(),
    profileId,
    profileName: 'Test',
    log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) },
    todo: '',
    memory: '',
  } as any
}

describe('destination commit gate', () => {
  test('re-routing without working the current system is refused', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-dest-${Math.random()}`

    const first = await executeTool('goto_system', { target_system: 'stillwater' }, ctxFor(pid))
    expect(first).not.toContain('BLOCKED')

    // Immediately re-target without having done anything at stillwater.
    const second = await executeTool('goto_system', { target_system: 'bharani' }, ctxFor(pid))
    expect(second).toContain('BLOCKED by Admiral doctrine')
    expect(second).toContain('stillwater')
    expect(second).toContain('bharani')
  })

  test('working the system first clears the gate', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-dest-work-${Math.random()}`

    await executeTool('goto_system', { target_system: 'stillwater' }, ctxFor(pid))
    // Actually work it — a scan is the cheapest thing that counts.
    await executeTool('game', { command: 'scan' }, ctxFor(pid))

    const next = await executeTool('goto_system', { target_system: 'bharani' }, ctxFor(pid))
    expect(next).not.toContain('BLOCKED')
  })

  test('re-issuing the SAME destination is never blocked', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-dest-same-${Math.random()}`

    await executeTool('goto_system', { target_system: 'valor' }, ctxFor(pid))
    // A retry of the same hop (macro interrupted, route resumed) must pass.
    const again = await executeTool('goto_system', { target_system: 'valor' }, ctxFor(pid))
    expect(again).not.toContain('BLOCKED')
  })

  test('the gate can be switched off by preference', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const { setPreference } = await import('../src/server/lib/db')
    const pid = `p-dest-off-${Math.random()}`

    setPreference('destination_gate', 'off')
    try {
      await executeTool('goto_system', { target_system: 'a_system' }, ctxFor(pid))
      const second = await executeTool('goto_system', { target_system: 'b_system' }, ctxFor(pid))
      expect(second).not.toContain('BLOCKED')
    } finally {
      setPreference('destination_gate', '')
    }
  })
})
