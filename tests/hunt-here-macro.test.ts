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
  docked?: boolean
  failTravel?: string
  systemPois?: any[]
  hullSeq?: number[]        // hull reported on successive status reads
  battleTicks?: number      // how many reads report an active battle
  failAttack?: string
  failAttackTimes?: number
  lootNeedsWreckId?: boolean
}

function harness(s: Scenario) {
  const calls: Array<{ cmd: string; args: any }> = []
  let undocked = false
  let travelled = false
  let attackFails = 0
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
        location: { system_id: 'krynn', docked_at: s.docked && !undocked ? 'crimson_war_citadel' : null, poi_id: 'start_poi' },
        ...(inBattle ? { active_battle: { battle_id: 'b1', your_zone: 'outer' } } : {}),
      }
    },
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      if (cmd === 'undock') { undocked = true; return { result: 'ok' } }
      if (cmd === 'travel' && s.failTravel) return { error: { code: s.failTravel, message: 'no such poi' } }
      if (cmd === 'travel') { travelled = true; return { result: 'ok' } }
      if (cmd === 'get_system') return { result: { system: { id: 'gsc_0030', pois: s.systemPois ?? [] } } }
      if (cmd === 'get_nearby') {
        // Arrival POI is empty until we travel to the hunting POI.
        if (s.systemPois && !travelled) return { result: { creatures: [], pirates: [], empire_npcs: [], nearby: [] } }
        return { result: s.targets ?? { creatures: [], pirates: [], empire_npcs: [], nearby: [] } }
      }
      if (cmd === 'attack' && s.failAttack) {
        attackFails++
        if (s.failAttackTimes === undefined || attackFails <= s.failAttackTimes) {
          return { error: { code: s.failAttack, message: 'nope' } }
        }
      }
      if (cmd === 'wrecks') return { result: { wrecks: [
        { id: 'wr_1', type: 'creature', victim_name: 'Belt-Grazer', killer_name: 'Test',
          cargo: [{ item_id: 'creature_carapace', quantity: 2 }] },
        { id: 'wr_other', type: 'creature', victim_name: 'Someone Else', killer_name: 'Rival Pilot', cargo: [] },
      ] } }
      if (cmd === 'loot' && s.lootNeedsWreckId && args && args.id !== undefined) {
        return { error: { code: 'invalid_payload', message: 'Unknown parameter(s): id' } }
      }
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


  test('undocks and travels to the POI itself — one call covers the whole stop', async () => {
    // A turn ends on the first action, so a model handed "undock, travel, hunt"
    // re-reads its TODO next turn and starts again at step one. Morg'Thar
    // undocked and re-docked in a loop for twenty minutes on 2026-09-02 and
    // never reached the hunt. The macro has to own the whole sequence.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1, docked: true })
    const out = await executeTool('hunt_here', { poi: 'krynn_belt', max_kills: 1 }, ctx)
    const order = calls.map(c => c.cmd)
    expect(order.indexOf('undock')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('travel')).toBeGreaterThan(order.indexOf('undock'))
    expect(order.indexOf('attack')).toBeGreaterThan(order.indexOf('travel'))
    expect(calls.find(c => c.cmd === 'travel')?.args?.target_poi).toBe('krynn_belt')
    expect(out).toContain('Undocked')
  }, 60_000)

  test('a travel failure aborts with the POI named instead of hunting the wrong place', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, docked: true, failTravel: 'poi_not_found' })
    const out = await executeTool('hunt_here', { poi: 'nowhere' }, ctx)
    expect(out).toContain('ABORT')
    expect(out).toContain('nowhere')
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
  }, 60_000)


  test('with no poi given it finds the belt/gas/ice POI itself instead of hunting the star', async () => {
    // Morg'Thar jumped into GSC-0030 — which has a gas cloud AND an ice field —
    // called a bare hunt_here() at the arrival POI, got nothing and jumped away.
    const { ctx, calls } = harness({
      targets: GRAZERS, battleTicks: 1,
      systemPois: [
        { id: 'gsc_0030_star', name: 'GSC-0030 Star', type: 'sun' },
        { id: 'gsc_0030_emission_nebula', name: 'Emission Nebula', type: 'gas_cloud' },
      ],
    })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.find(c => c.cmd === 'travel')?.args?.target_poi).toBe('gsc_0030_emission_nebula')
    expect(out).toContain('No targets at')
    expect(calls.some(c => c.cmd === 'attack')).toBe(true)
  }, 60_000)

  test('a system with no hunting POI at all still reports cleanly', async () => {
    const { ctx, calls } = harness({ systemPois: [{ id: 'star', name: 'Star', type: 'sun' }] })
    const out = await executeTool('hunt_here', {}, ctx)
    expect(calls.some(c => c.cmd === 'travel')).toBe(false)
    expect(out).toContain('NO KILLS')
  }, 60_000)


  test('waits for an unfinished battle instead of attacking into it', async () => {
    // After its first real kill at Nekkar Belt the macro attacked into its own
    // unresolved fight, got action_pending, reported NO KILLS, and the model
    // called it again — a spin. It must let the battle settle first.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 3 })
    await executeTool('hunt_here', { max_kills: 1 }, ctx)
    // The very first thing after the prelude is a state read, not an attack.
    const firstAttack = calls.findIndex(c => c.cmd === 'attack')
    const firstScan = calls.findIndex(c => c.cmd === 'get_nearby')
    expect(firstScan).toBeGreaterThanOrEqual(0)
    expect(firstAttack).toBeGreaterThan(firstScan)
  }, 60_000)

  test('action_pending on attack is treated as pacing, not a dead hunt', async () => {
    // The game acks the order then reports action_pending once; the retry lands.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1, failAttack: 'action_pending', failAttackTimes: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(out).not.toContain('attack failed [action_pending]')
    expect(calls.filter(c => c.cmd === 'attack').length).toBeGreaterThan(1)  // it retried
    expect(out).toContain('1 kill')
  }, 120_000)


  test('loots its own wreck using the id the payload actually uses', async () => {
    // The wrecks payload names it `id`, not `wreck_id`, and the wreck only
    // appears a tick after the kill. Getting either wrong made three
    // Belt-Grazer kills at Nekkar Belt report "No wrecks looted".
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    const loot = calls.find(c => c.cmd === 'loot')
    expect(loot?.args?.id).toBe('wr_1')
    expect(out).toContain('creature_carapace x2')
  }, 90_000)

  test('does not loot a wreck another pilot made', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.filter(c => c.cmd === 'loot').map(c => c.args?.id)).not.toContain('wr_other')
  }, 90_000)

  test('falls back to the other documented loot signature', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1, lootNeedsWreckId: true })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'loot' && c.args?.wreck_id === 'wr_1')).toBe(true)
    expect(out).toContain('creature_carapace')
  }, 90_000)

  test('a failed attack stops the macro instead of spinning', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, failAttack: 'target_not_found' })
    const out = await executeTool('hunt_here', { max_kills: 3 }, ctx)
    expect(out).toContain('attack failed')
    expect(calls.filter(c => c.cmd === 'attack').length).toBeLessThanOrEqual(4)
  }, 60_000)
})
