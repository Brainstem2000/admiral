import { describe, expect, test } from 'bun:test'

/**
 * Ledger Voss, 2026-09-12 04:35 CT: goto_system("82_erisani") aborted at once
 * (find_route: system_not_found — a typo), yet the destination gate had already
 * recorded the typo as his commitment, so goto_system("82_eridani") and then a
 * different system were refused four times as "re-routing without having done
 * anything there". A course that never left is not a commitment.
 */
function stubConnection(calls: string[]) {
  return {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({ location: { system_id: 'markab', system_name: 'Markab', docked_at: null }, ship: { fuel: 140, max_fuel: 180 }, player: { credits: 1_000 } }),
    execute: async (command: string, args?: Record<string, unknown>) => {
      calls.push(command)
      if (command === 'find_route') {
        const t = String(args?.target_system ?? '')
        if (t === '82_erisani') return { error: { code: 'system_not_found', message: 'Unknown system' } }
        return { result: { found: true, estimated_fuel: 4, fuel_available: 140, fuel_per_jump: 4, route: [{ jumps: 0, system_id: 'markab' }, { jumps: 1, system_id: t }] } }
      }
      return { result: 'ok' }
    },
  } as any
}
function ctxFor(profileId: string, calls: string[]) {
  return { connection: stubConnection(calls), profileId, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
}

describe('destination gate after an aborted goto_system', () => {
  test('a goto that aborted before moving leaves no commitment behind', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-dest-abort-${Math.random()}`
    const calls: string[] = []
    const typo = await executeTool('goto_system', { target_system: '82_erisani' }, ctxFor(pid, calls))
    expect(typo).toContain('MACRO ABORT')
    const corrected = await executeTool('goto_system', { target_system: 'epsilon_eridani' }, ctxFor(pid, calls))
    expect(corrected).not.toContain('BLOCKED')
    expect(corrected).toContain('goto_system')
    expect(calls.filter((c) => c === 'jump')).toHaveLength(1)
  })

  test('an earlier real commitment survives an aborted goto in between', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-dest-abort-prior-${Math.random()}`
    const calls: string[] = []
    // Committed to stillwater (the stub never moves, so the ship is still "in markab").
    const first = await executeTool('goto_system', { target_system: 'stillwater' }, ctxFor(pid, calls))
    expect(first).not.toContain('BLOCKED')
    // A typo'd re-route aborts — and must not erase the stillwater commitment…
    const typo = await executeTool('goto_system', { target_system: '82_erisani' }, ctxFor(pid, calls))
    expect(typo).toMatch(/MACRO ABORT|BLOCKED/)
    // …so an unrelated third destination is still refused as churn.
    const third = await executeTool('goto_system', { target_system: 'bharani' }, ctxFor(pid, calls))
    expect(third).toContain('BLOCKED by Admiral doctrine')
    expect(third).toContain('stillwater')
  })
})
