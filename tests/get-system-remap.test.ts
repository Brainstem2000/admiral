/**
 * get_system / get_poi never take a system argument — the remap must fire.
 *
 * The game ACCEPTS `get_system(system_id=elsewhere)` and then silently answers
 * for the system you are standing in. tools.ts records that this happened 84
 * times in one day on a single agent, every one of them a confident wrong
 * answer about a place the agent was not at. `get_map(system_id=...)` IS
 * honoured, so a request for another system is rewritten to it.
 *
 * This was previously untested. That is the dangerous state for a rewrite of
 * this shape: an earlier gate in this same file "never once fired in
 * production" because it matched on the command name only, and the storage
 * ledger rotted for days before anyone noticed. A silent no-op here restores
 * exactly the 84-wrong-answers bug, and nothing would fail.
 *
 * An orphaned branch (brainstem2000-animated-spork) carried a test asserting
 * the OLD behavior — a rewrite to `search_systems(query=...)`. That approach
 * was superseded by the get_map remap, which returns real data for the system
 * actually asked about. This file replaces it.
 */
import { describe, expect, test } from 'bun:test'
import { executeTool } from '../src/server/lib/tools'

function harness(localState: Record<string, unknown> | null) {
  const seen: Array<{ command: string; args?: Record<string, unknown> }> = []
  const connection = {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => localState,
    execute: async (command: string, args?: Record<string, unknown>) => {
      seen.push({ command, args: args ? { ...args } : args })
      return { result: 'ok' }
    },
  } as unknown as Parameters<typeof executeTool>[2]['connection']
  return { seen, connection }
}

const AT_HAVEN = { location: { system_id: 'haven', system_name: 'Haven', poi_id: 'grand_exchange_station' } }

function ctx(connection: ReturnType<typeof harness>['connection'], profileId: string) {
  return { connection, profileId, profileName: 'Test', log: () => {}, todo: '', memory: '' } as Parameters<typeof executeTool>[2]
}

describe('get_system with a system argument', () => {
  test('another system is REMAPPED to get_map, which the game honours', async () => {
    const { seen, connection } = harness(AT_HAVEN)
    const out = await executeTool('game', { command: 'get_system', args: { system_id: 'iron_reach' } },
      ctx(connection, 'remap-elsewhere'))
    const map = seen.find((s) => s.command === 'get_map')
    expect(map).toBeDefined()
    expect(map!.args).toMatchObject({ system_id: 'iron_reach' })
    // Never send the bare get_system — that is the call that answers wrongly.
    expect(seen.some((s) => s.command === 'get_system')).toBe(false)
    // The agent must be TOLD, or it will trust a number for the wrong place.
    expect(String(out)).toContain('iron_reach')
    expect(String(out)).toContain('get_map')
  })

  test('the CURRENT system goes out live with the argument stripped', async () => {
    const { seen, connection } = harness(AT_HAVEN)
    await executeTool('game', { command: 'get_system', args: { system_id: 'haven' } },
      ctx(connection, 'remap-current'))
    const call = seen.find((s) => s.command === 'get_system')
    expect(call).toBeDefined()
    // The game does not know this parameter; sending it risks invalid_payload.
    expect(call!.args ?? {}).not.toHaveProperty('system_id')
    expect(seen.some((s) => s.command === 'get_map')).toBe(false)
  })

  test('every spelling of the system argument is caught, not just system_id', async () => {
    // An agent that gets refused on one key will try another; catching only
    // system_id would leave the 84-wrong-answers path wide open.
    for (const key of ['system_id', 'id', 'system', 'system_name', 'target_system', 'name']) {
      const { seen, connection } = harness(AT_HAVEN)
      await executeTool('game', { command: 'get_system', args: { [key]: 'iron_reach' } },
        ctx(connection, `remap-key-${key}`))
      expect(seen.some((s) => s.command === 'get_map')).toBe(true)
    }
  })

  test('a display name resolves to the same id as the snake_case form', async () => {
    const { seen, connection } = harness(AT_HAVEN)
    await executeTool('game', { command: 'get_system', args: { system_id: 'Iron Reach' } },
      ctx(connection, 'remap-display-name'))
    expect(seen.find((s) => s.command === 'get_map')!.args).toMatchObject({ system_id: 'iron_reach' })
  })

  test('no argument at all is left completely alone', async () => {
    const { seen, connection } = harness(AT_HAVEN)
    await executeTool('game', { command: 'get_system', args: {} }, ctx(connection, 'remap-noarg'))
    expect(seen.some((s) => s.command === 'get_system')).toBe(true)
    expect(seen.some((s) => s.command === 'get_map')).toBe(false)
  })
})

describe('get_poi with a POI argument', () => {
  test('a POI elsewhere is stripped and the agent is told to travel first', async () => {
    const { seen, connection } = harness(AT_HAVEN)
    const out = await executeTool('game', { command: 'get_poi', args: { poi_id: 'iron_reach_mining_colony' } },
      ctx(connection, 'poi-elsewhere'))
    const call = seen.find((s) => s.command === 'get_poi')
    expect(call).toBeDefined()
    expect(call!.args ?? {}).not.toHaveProperty('poi_id')
    expect(String(out)).toContain('travel')
  })
})
