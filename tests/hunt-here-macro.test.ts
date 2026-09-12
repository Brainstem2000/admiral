import { describe, expect, test } from 'bun:test'
import { executeTool, targetVerdict, weaponDps } from '../src/server/lib/tools'

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
 * target our guns cannot kill quickly is skipped (targetVerdict: under half our
 * hull, OR dead inside ~5 ticks, OR a grazer dead inside ~20 — the hull-only
 * version refused 60-hull grazers to a 90-damage railgun on 2026-09-11), and
 * the loop breaks off the moment hull falls under the floor.
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
  lootNeedsId?: boolean         // the server rejects `wreck_id` and wants the older `id` signature
  maxHull?: number          // our ship's max hull (default 1785, the Devastator the macro was written for)
  modules?: any[]           // structured get_ship modules, so the macro can read our firepower
  activeMissions?: string   // text form of get_active_missions, so the macro has paid quarry
}

function harness(s: Scenario) {
  const calls: Array<{ cmd: string; args: any }> = []
  let undocked = false
  let travelled = false
  let attackFails = 0
  let advCalls = 0
  let reads = 0
  let battleReads = 0
  const hullSeq = s.hullSeq ?? [s.maxHull ?? 1785]
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
        ship: { hull, max_hull: s.maxHull ?? 1785 },
        location: { system_id: 'krynn', docked_at: s.docked && !undocked ? 'crimson_war_citadel' : null, poi_id: 'start_poi' },
        ...(inBattle ? { active_battle: { battle_id: 'b1', your_zone: 'outer' } } : {}),
      }
    },
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      if (cmd === 'undock') { undocked = true; return { result: 'ok' } }
      if (cmd === 'get_ship' && s.modules) return { result: { modules: s.modules } }
      if (cmd === 'get_active_missions' && s.activeMissions) return { result: s.activeMissions }
      if (cmd === 'advance') {
        advCalls++
        if (advCalls > (s.battleTicks ?? 0)) return { error: { code: 'not_in_battle', message: 'You are not in a battle.' } }
        return { result: { action: 'advance', message: 'Advancing toward the enemy.' } }
      }
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
        { id: 'wr_1', type: 'creature', victim_id: 'crt_small', victim_name: 'Belt-Grazer', killer_name: "Morg'Thar",
          cargo: [{ item_id: 'creature_carapace', quantity: 2 }] },
        { id: 'wr_other', type: 'creature', victim_name: 'Someone Else', killer_name: 'Rival Pilot', cargo: [] },
      ] } }
      if (cmd === 'loot' && s.lootNeedsId && args && args.wreck_id !== undefined) {
        return { error: { code: 'invalid_payload', message: 'Unknown parameter(s): wreck_id' } }
      }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: `p-hunt-${Math.random()}`, profileName: "Morg'Thar - Warrior", log: () => {}, todo: '', memory: '' } as any
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
    expect(out).toContain('1 CONFIRMED kill')
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
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
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
    expect(out).toContain('1 CONFIRMED kill')
  }, 120_000)


  test('loots its own wreck: reads the wreck `id`, sends it as `wreck_id`', async () => {
    // The wrecks payload names the wreck `id`, not `wreck_id`, and the wreck
    // only appears a tick after the kill. Getting either wrong made three
    // Belt-Grazer kills at Nekkar Belt report "No wrecks looted". The loot
    // command itself wants `wreck_id` — the live server answered every `id`
    // attempt on 2026-09-11 with "Valid parameters: wreck_id, item_id,
    // module_id, quantity" — so that key goes first.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    const loot = calls.find(c => c.cmd === 'loot')
    expect(loot?.args?.wreck_id).toBe('wr_1')
    expect(out).toContain('creature_carapace x2')
  }, 90_000)

  test('does not loot a wreck another pilot made', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.filter(c => c.cmd === 'loot').map(c => c.args?.wreck_id ?? c.args?.id)).not.toContain('wr_other')
  }, 90_000)

  test('falls back to the other documented loot signature', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1, lootNeedsId: true })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'loot' && c.args?.id === 'wr_1')).toBe(true)
    expect(out).toContain('creature_carapace')
  }, 90_000)


  test('loots wrecks whose killer_name is the game USERNAME, not the profile name', async () => {
    // The game reports killer_name: "Morg'Thar"; the Admiral profile is
    // "Morg'Thar - Warrior". Comparing the two filtered out every wreck the
    // agent had just made — four straight three-kill runs reported
    // "No wrecks looted" on 2026-09-02.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'loot')).toBe(true)
    expect(out).toContain('creature_carapace')
    expect(out).not.toContain('No wrecks looted')
  }, 90_000)


  test('sets a firing stance and closes range, and only stops when advance says the battle ended', async () => {
    // Neither get_status nor the local state exposes battle state, so advance()
    // — which succeeds in a battle and returns not_in_battle outside one — is
    // both the range-closer and the probe. Without this the loop exited one
    // tick after attacking and scored every attack as a win.
    const { ctx, calls } = harness({ targets: GRAZERS, battleTicks: 3 })
    await executeTool('hunt_here', { max_kills: 1 }, ctx)
    const stances = calls.filter(c => c.cmd === 'stance').map(c => c.args?.id)
    expect(stances).toContain('fire')
    expect(calls.filter(c => c.cmd === 'advance').length).toBeGreaterThanOrEqual(3)
  }, 120_000)

  test('a failed attack stops the macro instead of spinning', async () => {
    const { ctx, calls } = harness({ targets: GRAZERS, failAttack: 'target_not_found' })
    const out = await executeTool('hunt_here', { max_kills: 3 }, ctx)
    expect(out).toContain('attack failed')
    expect(calls.filter(c => c.cmd === 'attack').length).toBeLessThanOrEqual(4)
  }, 60_000)
})

describe('combat tools are not offered to non-combat roles', () => {
  test('a hunter gets hunt_here; everyone else does not see it at all', async () => {
    // The dispatch-site refusal is the guard, but a tool the agent must never
    // use should not be on the menu either: Cass Margin (an uninsured hauler)
    // called hunt_here three times in twenty minutes on 2026-09-02 and was
    // refused each time, burning a turn apiece.
    const { toolsForRole } = await import('../src/server/lib/tools')
    const hunter = toolsForRole('hunter').map(t => t.name)
    const other = toolsForRole('default').map(t => t.name)
    expect(hunter).toContain('hunt_here')
    expect(other).not.toContain('hunt_here')
    // Everything else must still be offered to both.
    for (const t of ['game', 'goto_system', 'sell_cargo', 'update_todo', 'codex']) {
      expect(hunter, t).toContain(t)
      expect(other, t).toContain(t)
    }
  })

  // ---- firepower-aware gate (2026-09-11) ----------------------------------
  // Morg'Thar's Shard: hull 110, Railgun II (90 kinetic, cd 3) + Autocannon II
  // (18 kinetic, cd 1). Effective vs armour at the kinetic 50% share:
  // 90*0.5/3 + 18*0.5/1 = 24 per tick.
  const SHARD_GUNS = [
    { module_id: 'rg', type_id: 'railgun_ii', name: 'Railgun II', type: 'weapon', slot: 'weapon',
      stats: { cooldown: 3, damage: 90, damage_type: 'kinetic', reach: 5, special: 'armor_bypass_50' }, magazine_size: 7, current_ammo: 7 },
    { module_id: 'ac', type_id: 'autocannon_ii', name: 'Autocannon II', type: 'weapon', slot: 'weapon',
      stats: { cooldown: 1, damage: 18, damage_type: 'kinetic', reach: 2 }, magazine_size: 650, current_ammo: 648 },
    { module_id: 'sh', type_id: 'shield_i', name: 'Shield I', type: 'defense', slot: 'defense', stats: { shield: 40 } },
  ]
  const GRAZER_60 = { creatures: [{ creature_id: 'crt_small', name: 'Belt-Grazer', species: 'belt_grazer', role: 'grazer', hull: 60, max_hull: 60 }], pirates: [], empire_npcs: [], nearby: [] }

  test('a glass cannon hunts prey heavier than half its hull when its guns drop it fast', async () => {
    // The Shard at hull 100 caps "half our hull" at 50; every Belt-Grazer is 60.
    // The hull-only rule sent Morg'Thar through four systems without a shot.
    const { ctx, calls } = harness({ targets: GRAZER_60, hullSeq: [100], maxHull: 110, modules: SHARD_GUNS, battleTicks: 1 })
    const out = await executeTool('hunt_here', { max_kills: 1, species: 'belt_grazer' }, ctx)
    expect(calls.find(c => c.cmd === 'attack')?.args?.id).toBe('crt_small')
    expect(out).toContain('1 CONFIRMED kill')
  }, 60_000)

  test('the firepower rule does not open the door to a leviathan', async () => {
    const { ctx, calls } = harness({
      targets: { creatures: [{ creature_id: 'crt_big', name: 'Molt Leviathan', species: 'molt_leviathan', role: 'predator', hull: 1600, max_hull: 1600 }], pirates: [], empire_npcs: [], nearby: [] },
      hullSeq: [100], maxHull: 110, modules: SHARD_GUNS,
    })
    const out = await executeTool('hunt_here', { max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
    expect(out).toContain('too tough')
    expect(out).toContain('ticks to kill')      // the refusal shows its arithmetic
  }, 60_000)

  test('a dry railgun leaves the autocannon, which still clears a grazer inside the grazer window', async () => {
    const dry = SHARD_GUNS.map(m => m.module_id === 'rg' ? { ...m, current_ammo: 0 } : m)
    const { ctx, calls } = harness({ targets: GRAZER_60, hullSeq: [100], maxHull: 110, modules: dry, battleTicks: 1 })
    await executeTool('hunt_here', { max_kills: 1, species: 'belt_grazer' }, ctx)
    expect(calls.find(c => c.cmd === 'attack')?.args?.id).toBe('crt_small')
  }, 60_000)

  test('weaponDps reads structured modules, skips dry magazines, and parses the text table', () => {
    expect(weaponDps(SHARD_GUNS)).toBeCloseTo(24, 5)
    expect(weaponDps(SHARD_GUNS.map(m => m.module_id === 'rg' ? { ...m, current_ammo: 0 } : m))).toBeCloseTo(9, 5)
    expect(weaponDps([{ name: 'Shield I', type: 'defense', stats: { shield: 40 } }])).toBeNull()
    expect(weaponDps(undefined)).toBeNull()
    const text = 'Modules (2):\nid\ttype\tslot\tsize\tstats\nrg\trailgun_ii\tweapon\t10\tdmg:90 type:kinetic cd:3 ammo:7/7 loaded:Ferrous Slug Case reach:5\nac\tautocannon_ii\tweapon\t10\tdmg:18 type:kinetic cd:1 ammo:0/650 loaded:Standard Rounds Box reach:2\n'
    expect(weaponDps(undefined, text)).toBeCloseTo(15, 5)   // the empty autocannon contributes nothing
  })

  test('targetVerdict: half-hull rule kept, fast kills and grazers admitted, the rest refused with numbers', () => {
    const grazer = { kind: 'creature', role: 'grazer' }
    const predator = { kind: 'creature', role: 'predator' }
    expect(targetVerdict({ ...predator, hull: 40 }, 100, null)).toBeNull()            // under half our hull: always
    expect(targetVerdict({ ...predator, hull: 60 }, 100, 24)).toBeNull()              // 3 ticks: fast kill, hull ratio irrelevant
    expect(targetVerdict({ ...grazer, hull: 220 }, 100, 24)).toBeNull()               // pilot-whale, 10 ticks: grazer window
    expect(targetVerdict({ ...predator, hull: 220 }, 100, 24)).toContain('10 ticks') // same hull, fights back: refused
    expect(targetVerdict({ ...predator, hull: 1600 }, 100, 24)).toContain('67 ticks')   // 1600/24
    expect(targetVerdict({ ...grazer, hull: 600 }, 100, 24)).toContain('25 ticks')   // past the stalemate window even for a grazer
    expect(targetVerdict({ ...grazer, hull: 90 }, 100, null)).toBeNull()              // guns unreadable: grazer up to parity
    expect(targetVerdict({ ...grazer, hull: 120 }, 100, null)).toContain('could not be read')
    expect(targetVerdict({ ...predator, hull: 60 }, 100, null)).toContain('could not be read')
    expect(targetVerdict({ ...predator, hull: null }, 100, 24)).toBeNull()            // unknown hull: legacy, engage
  })

  test('a species filter that hides everything names what is present instead of calling the POI worked out', async () => {
    const { ctx, calls } = harness({
      targets: { creatures: [{ creature_id: 'crt_w', name: 'Frost-Wyrm', species: 'frost_wyrm', role: 'predator', hull: 80, max_hull: 80 }], pirates: [], empire_npcs: [], nearby: [] },
      hullSeq: [100], maxHull: 110, modules: SHARD_GUNS,
    })
    const out = await executeTool('hunt_here', { species: 'rime_grazer' }, ctx)
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
    expect(out).toContain('no "rime_grazer" at this POI')
    expect(out).toContain('Frost-Wyrm (hull 80)')
    expect(out).not.toContain('worked out')
  }, 60_000)

  test('a misspelt species argument does not stop the hunt when the paid quarry is standing right there', async () => {
    const { ctx, calls } = harness({
      targets: { creatures: [{ creature_id: 'crt_h', name: 'Hoarfrost Grazer', species: 'hoarfrost_grazer', role: 'grazer', hull: 60, max_hull: 60 }], pirates: [], empire_npcs: [], nearby: [] },
      hullSeq: [100], maxHull: 110, modules: SHARD_GUNS, battleTicks: 1,
      activeMissions: 'Active missions (1/5):\n--- Ice-Field Thinning ---\nObjectives:\n  - Hunt 6 Hoarfrost-Grazers: 0/6\n',
    })
    const out = await executeTool('hunt_here', { species: 'rime_grazer', max_kills: 1 }, ctx)
    expect(calls.find(c => c.cmd === 'attack')?.args?.id).toBe('crt_h')
    expect(out).toContain('hunting the paid quarry')
  }, 90_000)

  test('a species argument does not turn an unpaid kill into a paid one', async () => {
    // Grazer Cull already 8/8 (not an open objective); only sift-rays still pay.
    const { ctx, calls } = harness({ targets: GRAZER_60, hullSeq: [100], maxHull: 110, modules: SHARD_GUNS, battleTicks: 1,
      activeMissions: 'Active missions (2/5):\n--- Grazer Cull ---\nObjectives:\n  - Hunt 8 Belt-Grazers: 8/8 [DONE]\n--- Nebula Drift Hunt ---\nObjectives:\n  - Hunt 6 Sift-Rays: 1/6\n' })
    const out = await executeTool('hunt_here', { species: 'belt_grazer', max_kills: 1 }, ctx)
    expect(calls.some(c => c.cmd === 'attack')).toBe(false)
    expect(out).toContain('NOTHING PAID HERE'); expect(out).toContain('complete_mission')
  }, 60_000)
})
