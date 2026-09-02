import { describe, expect, test } from 'bun:test'
import { executeTool } from '../src/server/lib/tools'

/**
 * hunt_here: scan, engage, kill, loot, repeat — as ONE tool call.
 *
 * gpt-oss-120b follows a single next action reliably and multi-step loops
 * badly. Told in three separate directive rewrites to "arrive, get_nearby,
 * attack, loot, move on", Morg'Thar commuted instead: thirteen systems in 45
 * minutes on 2026-09-02 with zero attacks, including a gas pocket holding four
 * grazers. goto_system solved the same problem for travel.
 *
 * The safety rules live in code, not in the prompt: police are never shot, a
 * target tougher than half our hull is skipped, and the loop breaks off the
 * moment hull falls under the floor.
 */

interface Scenario {
  targets?: any
  hullSeq?: number[]        // hull reported on successive status reads
  battleTicks?: number      // how many reads report an active battle
  failAttack?: string
}

function harness(s: Scenario) {
  const calls: Array<{ cmd: string; args: any }> = []
  let reads = 0
  let battleReads = 0
  const hullSeq = s.hullSeq ?? [1785]
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => {
      const hull = hullSeq[Math.min(reads, hullSeq.length - 1)]
      reads++
      const inBattle = battleReads < (s.battleTicks ?? 0)
      if (inBattle) battleReads++
      return {
        ship: { hull, max_hull: 1785 },
        location: { system_id: 'krynn', docked_at: null },
        ...(inBattle ? { active_battle: { battle_id: 'b1', your_zone: 'outer' } } : {}),
      }
    },
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      if (cmd === 'get_nearby') return { result: s.targets ?? { creatures: [], pirates: [], empire_npcs: [], nearby: [] } }
      if (cmd === 'attack' && s.failAttack) return { error: { code: s.failAttack, message: 'nope' } }
      if (cmd === 'wrecks') return { result: { wrecks: [{ wreck_id: 'wr_1', name: 'Grazer wreck' }] } }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: `p-hunt-${Math.random()}`, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}

const GRAZERS = {
  creatures: [
    { creature_id: 'crt_big', name: 'Leviathan', hull: 1600, max_hull: 1600 },
    { creature_id: 'crt_small', name: 'Belt-Grazer', hull: 45, max_hull: 45 },
  ],
  empire_npcs: [{ npc_id: 'npc_police', name: '[POLICE] Rim Patrol', hull: 500, max_hull: 500 }],
  pirates: [], nearby: [],
}

describe('hunt_here', () => {
  test('attacks the weakest beatable target and loots the wreck', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    const attack = calls.find(c => c.cmd === 'attack')
    expect(attack?.args?.id).toBe('crt_small')       // weakest first, not the Leviathan
    expect(out).toContain('1 kill')
    expect(calls.some(c => c.cmd === 'loot')).toBe(true)
  }, 60_000)

  test('never attacks an empire NPC or police', async () => {
    const { ctx, calls } = harness({
      targets: { creatures: [], pirates: [], nearby: [], empire_npcs: [{ npc_id: 'npc_police', name: '[POLICE] Rim Patrol', hull: 10, max_hull: 10 }] },
    })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
    expect(out).toContain('NO KILLS')
    expect(out).toContain('empire NPC')
  }, 60_000)

  test('skips a target tougher than half our hull', async () => {
    const { ctx, calls } = harness({
      targets: { creatures: [{ creature_id: 'crt_big', name: 'Leviathan', hull: 1600, max_hull: 1600 }], pirates: [], empire_npcs: [], nearby: [] },
    })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
    expect(out).toContain('too tough')
  }, 60_000)

  test('refuses to start when hull is already under the floor', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, hullSeq: [500] })
    const out = await executeTool('hunt_here', { hull_floor_pct: 60 }, ctx)
    expect(out).toContain('ABORT')
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
  }, 60_000)

  test('an empty POI says so plainly instead of looping', async () => {
    const { ctx } = harness({})
    const out = await executeTool('hunt_here', {}, ctx)
    expect(out).toContain('nothing at this POI')
    expect(out).toContain('worked out')
  }, 60_000)

  test('the species filter keeps it on the contract creature', async () => {
    const { ctx, calls } = harness({
      targets: {
        creatures: [
          { creature_id: 'crt_ray', name: 'Drift-Ray', species: 'drift_ray', hull: 45, max_hull: 45 },
          { creature_id: 'crt_grz', name: 'Belt-Grazer', species: 'belt_grazer', hull: 60, max_hull: 60 },
        ], pirates: [], empire_npcs: [], nearby: [],
      },
      battleTicks: 1,
    })
    await executeTool('hunt_here', { max_kills: 1, species: 'belt_grazer' }, ctx)
    expect(calls.find(c => c.cmd === 'attack')?.args?.id).toBe('crt_grz')
  }, 60_000)

  test('a failed attack stops the macro instead of spinning', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, failAttack: 'target_not_found' })
    const out = await executeTool('hunt_here', { max_kills: 3 }, ctx)
    expect(out).toContain('attack failed')
    expect(calls.filter(c => c.cmd === 'attack').length).toBeLessThanOrEqual(4)
  }, 60_000)
})
