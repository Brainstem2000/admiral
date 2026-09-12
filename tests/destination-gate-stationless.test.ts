import { describe, expect, test } from 'bun:test'
import { getDb, systemHasStation } from '../src/server/lib/db'

getDb()

/**
 * Passing through a stationless system is not "re-routing without working it".
 *
 * The destination gate refused every onward move after a one-hop leg arrived
 * at a system with nothing to work: Ledger Voss at Adhara (idling on 14 fuel)
 * and again at Pipirima, Nova Reyes at Proxima Centauri, CyberSpock at Blood
 * Forge, all on 2026-09-10 — four refusals, no churn prevented. Arrival at a
 * stationless system now satisfies the commitment for a FORWARD move; bouncing
 * back to where the course was set, and leaving a station system unworked,
 * stay refused. Reads real intel rows (adhara/pipirima/gudja have no station,
 * krynn does); writes nothing.
 */

function ctxFor(profileId: string, where: { system: string }) {
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    // A one-hop route to whatever is asked, and the jump succeeds: the goto
    // completes, so its commitment stands (an aborted goto leaves none).
    execute: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'find_route') {
        const t = String(args?.target_system ?? '')
        return { result: { found: true, estimated_fuel: 4, fuel_available: 120, fuel_per_jump: 4, route: [{ jumps: 0, system_id: where.system }, { jumps: 1, system_id: t }] } }
      }
      return { result: 'ok' }
    },
    onNotification: () => {},
    getLocalState: () => ({ location: { system_id: where.system, docked_at: null }, ship: { fuel: 120, max_fuel: 180 } }),
  } as any
  return { connection: conn, profileId, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
}

describe('destination gate — passing through stationless systems', () => {
  test('intel knows which of the test systems have a station', () => {
    expect(systemHasStation('adhara')).toBe(false)
    expect(systemHasStation('pipirima')).toBe(false)
    expect(systemHasStation('gudja')).toBe(false)
    expect(systemHasStation('krynn')).toBe(true)
    expect(systemHasStation('no_such_system_xyz')).toBe(null)
  })

  test('a raw jump onward from a stationless waypoint is allowed', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-pass-${Math.random()}`
    const where = { system: 'adhara' }
    await executeTool('goto_system', { target_system: 'pipirima' }, ctxFor(pid, where))   // commit, course set from adhara
    where.system = 'pipirima'                                                              // arrived
    const out = await executeTool('game', { command: 'jump', args: { id: 'gudja' } }, ctxFor(pid, where))
    expect(out).not.toContain('BLOCKED')
  })

  test('a goto_system onward from a stationless waypoint is allowed', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-pass-goto-${Math.random()}`
    const where = { system: 'adhara' }
    await executeTool('goto_system', { target_system: 'pipirima' }, ctxFor(pid, where))
    where.system = 'pipirima'
    const out = await executeTool('goto_system', { target_system: 'gudja' }, ctxFor(pid, where))
    expect(out).not.toContain('BLOCKED by Admiral doctrine')
  })

  test('bouncing straight back to where the course was set is still refused', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-bounce-${Math.random()}`
    const where = { system: 'adhara' }
    await executeTool('goto_system', { target_system: 'pipirima' }, ctxFor(pid, where))
    where.system = 'pipirima'
    const out = await executeTool('game', { command: 'jump', args: { id: 'adhara' } }, ctxFor(pid, where))
    expect(out).toContain('BLOCKED by Admiral doctrine')
  })

  test('leaving a STATION system without working it is still refused', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = `p-station-${Math.random()}`
    const where = { system: 'blood_forge' }
    await executeTool('goto_system', { target_system: 'krynn' }, ctxFor(pid, where))
    where.system = 'krynn'
    const out = await executeTool('game', { command: 'jump', args: { id: 'the_anvil' } }, ctxFor(pid, where))
    expect(out).toContain('BLOCKED by Admiral doctrine')
  })

  test("an Admiral course change clears the commitment, so the redirected move is not refused", async () => {
    const { executeTool, clearDestinationCommit } = await import('../src/server/lib/tools')
    const pid = `p-admiral-${Math.random()}`
    const where = { system: 'adhara' }
    await executeTool('goto_system', { target_system: 'pipirima' }, ctxFor(pid, where))   // course set from adhara
    where.system = 'pipirima'
    clearDestinationCommit(pid)                                                            // nudge / directive PUT / plan step
    const out = await executeTool('game', { command: 'jump', args: { id: 'adhara' } }, ctxFor(pid, where))
    expect(out).not.toContain('BLOCKED by Admiral doctrine')                              // the same bounce is refused without the clear (test above)
  })
})
