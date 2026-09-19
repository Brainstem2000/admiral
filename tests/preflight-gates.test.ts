import { describe, expect, test } from 'bun:test'
import {
  attackAmmoVerdict, holdFullVerdict, mineFullHoldVerdict, routeRefuelVerdict,
  weaponAmmoState, cellFuelInCargo, systemSellsFuelTo, CELL_FUEL,
} from '../src/server/lib/tools'
import { recordCargoSnapshot, getDb } from '../src/server/lib/db'
import { __setStationsFeedForTests, stationsInSystem } from '../src/server/lib/stations-feed'

/**
 * PREFLIGHT GATES — Brian, 2026-09-18. Every directive now ends with three rules: never run
 * out of fuel, never fight without ammo, never set off to pick up cargo on a full hold. Prose
 * alone has never held for every driving model, so each rule is also a code gate. Every test
 * below is written against the incident that produced the rule.
 */

function stub(state: Record<string, unknown> | null, seen: string[] = [], replies: Record<string, unknown> = {}) {
  return {
    mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => state,
    execute: async (command: string) => { seen.push(command); return replies[command] ?? { result: 'ok' } },
  } as any
}
/** cargo_inventory has a foreign key to profiles, so a test pilot must exist first. */
function pilot(tag: string): string {
  const pid = `p-${tag}-${Math.random().toString(36).slice(2)}`
  getDb().query('INSERT INTO profiles (id, name) VALUES (?, ?)').run(pid, `Test ${tag}`)
  return pid
}
const ctxFor = (connection: unknown, profileId: string) =>
  ({ connection, profileId, profileName: 'Test', log: () => {}, todo: '', memory: '' }) as any

// ---------------------------------------------------------------------------------------------
describe('refuel from cells works in open space', () => {
  // Ledger Voss, Bellatrix, 2026-09-18: 30 fuel, four cells just handed over by a 27-jump rescue,
  // and the dock gate refused his bare `refuel` because he was not at a station. The game falls
  // back to cargo cells automatically; refusing that defeats the point of carrying them.
  const inSpace = { location: { docked_at: null, system_id: 'bellatrix', poi_id: 'bellatrix_ice_shelf' }, ship: {} }

  test('a bare refuel in space passes when the hold carries cells', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = pilot('cells')
    recordCargoSnapshot(pid, [{ item_id: 'fuel_cell', quantity: 4 } as any])
    const seen: string[] = []
    const out = await executeTool('game', { command: 'refuel' }, ctxFor(stub(inSpace, seen), pid))
    expect(String(out)).not.toContain('NOT DOCKED')
    expect(seen).toContain('refuel')              // it reached the game
  })

  test('with no cells aboard, a bare refuel in space is still refused — there is nothing to draw on', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = pilot('nocells')
    const seen: string[] = []
    const out = await executeTool('game', { command: 'refuel' }, ctxFor(stub(inSpace, seen), pid))
    expect(String(out)).toContain('NOT DOCKED')
    expect(seen).not.toContain('refuel')
  })

  test('cells are counted by the fuel each type restores', () => {
    const pid = pilot('cellfuel')
    recordCargoSnapshot(pid, [{ item_id: 'fuel_cell', quantity: 4 } as any, { item_id: 'premium_fuel_cell', quantity: 1 } as any])
    expect(cellFuelInCargo(pid)).toBe(4 * CELL_FUEL.fuel_cell! + CELL_FUEL.premium_fuel_cell!)
    expect(cellFuelInCargo(pilot('empty'))).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('never go into a fight without ammo', () => {
  const guns = (loaded: number[]) => weaponAmmoState(loaded.map((n, i) => ({
    module_id: `gun${i}`, name: `autocannon_${i}`, ammo: `${n}/500`, loaded_ammo_id: 'standard_rounds_box',
  })))

  test('energy-only loadouts and fully loaded ones are never refused', () => {
    expect(attackAmmoVerdict(weaponAmmoState([{ name: 'pulse_laser' }]), false)).toBeNull()
    expect(attackAmmoVerdict(guns([500, 444]), false)).toBeNull()
  })

  test('under half armament is a hard refusal — repeating does not get past it', () => {
    const s = guns([0, 0, 0, 300])
    expect(attackAmmoVerdict(s, false)).toContain('under half armament')
    expect(attackAmmoVerdict(s, true)).toContain('under half armament')
  })

  test('at half or better, the first attempt is refused with the exact reload commands', () => {
    const v = attackAmmoVerdict(guns([500, 0, 500]), false)!
    expect(v).toContain('1 of 3 weapons are EMPTY')
    expect(v).toContain('reload(id="gun1", target="standard_rounds_box")')
  })

  test('…and repeating the identical attack proceeds, so a ship under fire is never trapped', () => {
    expect(attackAmmoVerdict(guns([500, 0, 500]), true)).toBeNull()
  })

  test('wired: attack is refused on a dry loadout, then allowed on the identical repeat', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const pid = pilot('atk')
    const seen: string[] = []
    const ship = { result: { modules: [
      { module_id: 'g1', name: 'autocannon_ii', ammo: '0/650', loaded_ammo_id: 'standard_rounds_box' },
      { module_id: 'g2', name: 'autocannon_ii', ammo: '650/650', loaded_ammo_id: 'standard_rounds_box' },
    ] } }
    const conn = stub({ location: { docked_at: null } }, seen, { get_ship: ship })
    const first = await executeTool('game', { command: 'attack', args: { id: 'pirate_1' } }, ctxFor(conn, pid))
    expect(String(first)).toContain('EMPTY')
    expect(seen).not.toContain('attack')
    await executeTool('game', { command: 'attack', args: { id: 'pirate_1' } }, ctxFor(conn, pid))
    expect(seen).toContain('attack')
  })
})

// ---------------------------------------------------------------------------------------------
describe('never set off to pick up cargo on a full hold', () => {
  test('every pickup is refused on a full hold; unknown or not-full passes', () => {
    for (const cmd of ['mine', 'loot_wreck', 'salvage', 'buy', 'withdraw_items']) {
      expect(holdFullVerdict(cmd, {}, 300, 300)).toContain('hold is FULL')
    }
    expect(holdFullVerdict('mine', {}, 299, 300)).toBeNull()
    expect(holdFullVerdict('mine', {}, null, 300)).toBeNull()
    expect(holdFullVerdict('sell', {}, 300, 300)).toBeNull()            // not a pickup
  })

  test('a buy delivered to storage and a withdraw aimed elsewhere do not use the hold', () => {
    expect(holdFullVerdict('buy', { deliver_to: 'storage' }, 300, 300)).toBeNull()
    expect(holdFullVerdict('withdraw_items', { target: 'faction' }, 300, 300)).toBeNull()
    expect(holdFullVerdict('withdraw_items', { target: 'cargo' }, 300, 300)).toContain('FULL')
  })

  test('the refusal sends the agent to store, never to jettison (nobody jettisons, 2026-09-17)', () => {
    const v = holdFullVerdict('mine', {}, 300, 300)!
    expect(v).toContain('deposit_items')
    expect(v).not.toContain('jettison')
  })

  test('wired: game(mine) on a full hold never reaches the game', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const seen: string[] = []
    const out = await executeTool('game', { command: 'mine' },
      ctxFor(stub({ location: { docked_at: null }, ship: { cargo_used: 300, cargo_capacity: 300 } }, seen), pilot('mine')))
    expect(String(out)).toContain('hold is FULL')
    expect(seen).not.toContain('mine')
  })
})

describe('mine_until_full on a full hold', () => {
  const keep = new Set(['silicon_ore'])
  // Nova Reyes, Mebsuta, 2026-09-18: a hold full of ore that belt does not hold. The macro may
  // only return ore to the deposit that produced it, so it had nothing to dump — zero mine actions.
  test('the Mebsuta case: full of ore this belt cannot take back -> refused before a wasted run', () => {
    const v = mineFullHoldVerdict(300, 300, keep, [{ item_id: 'titanium_ore', quantity: 300 }], ['silicon_ore'])!
    expect(v).toContain('cannot take back')
    expect(v).toContain('titanium_ore')
  })

  test('full of filler this belt DOES hold -> allowed, the macro can return it and keep mining', () => {
    expect(mineFullHoldVerdict(300, 300, keep, [{ item_id: 'iron_ore', quantity: 300 }], ['silicon_ore', 'iron_ore'])).toBeNull()
  })

  test('full of the ore you came for -> the job is done, not an error', () => {
    expect(mineFullHoldVerdict(300, 300, keep, [{ item_id: 'silicon_ore', quantity: 300 }], ['silicon_ore'])).toContain('job is done')
  })

  test('no keep on a full hold -> refused; not full, or an unknown deposit list -> the macro decides', () => {
    expect(mineFullHoldVerdict(300, 300, new Set(), [{ item_id: 'iron_ore', quantity: 300 }], ['iron_ore'])).toContain('no room')
    expect(mineFullHoldVerdict(200, 300, keep, [], ['silicon_ore'])).toBeNull()
    expect(mineFullHoldVerdict(300, 300, keep, [{ item_id: 'titanium_ore', quantity: 300 }], [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('never fly somewhere you cannot refuel from', () => {
  // Ledger Voss: Alsuhail -> Bellatrix on 80 fuel, 4 fuel per jump. Bellatrix's only station is
  // pirate-held and refused him (-30). The nearest station that would admit him was Cargo Lanes,
  // 14 jumps on. A straight chain reproduces the geometry.
  const chain = ['bellatrix', ...Array.from({ length: 13 }, (_, k) => `hop${k + 1}`), 'cargo_lanes']
  const neighbours = (s: string) => {
    const i = chain.indexOf(s)
    return i < 0 ? [] : [chain[i - 1], chain[i + 1]].filter(Boolean) as string[]
  }
  const base = { target: 'bellatrix', perJump: 4, neighbours, forbidden: new Set<string>(),
                 canRefuelIn: (s: string) => s === 'cargo_lanes' }

  test('the Bellatrix trap: 64 fuel on arrival, the nearest usable fuel 14 jumps / 56 on -> refused', () => {
    const v = routeRefuelVerdict({ ...base, arrivalFuel: 64 })!
    expect(v).toContain('MACRO ABORT')
    expect(v).toContain('cargo_lanes')
    expect(v).toContain('14 jump')
    expect(v).toContain('fuel cells')
  })

  test('enough fuel for the next leg at the 25% margin -> allowed', () => {
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 70 })).toBeNull()
  })

  test('a destination that sells fuel to you is always allowed', () => {
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 0, canRefuelIn: () => true })).toBeNull()
  })

  test('a forbidden system is never counted as a way through', () => {
    // The only path to fuel runs through a forbidden system -> nothing reachable -> stands down
    // rather than guessing (the known map is not the whole galaxy).
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 64, forbidden: new Set(['hop5']) })).toBeNull()
  })

  test('a thin map can never refuse an honest route', () => {
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 0, target: 'unknown_system' })).toBeNull()
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 0, canRefuelIn: () => false })).toBeNull()
    expect(routeRefuelVerdict({ ...base, arrivalFuel: 64, perJump: 0 })).toBeNull()
  })
})

describe('a station that sells fuel is not one that admits you', () => {
  test('the feed keeps each station’s empire, and pirate-held fuel does not count', () => {
    __setStationsFeedForTests([
      { id: 'crix_stronghold_station', system_id: 'bellatrix', services: ['refuel', 'market'], empire: 'pirates' } as any,
      { id: 'cargo_lanes_freight_depot', system_id: 'cargo_lanes', services: ['refuel'], empire: 'nebula' } as any,
      { id: 'glintfin_range', system_id: 'silvermark', services: [], empire: '' } as any,
      // The feed refuses any snapshot under 40 stations as a broken response, so pad it to a
      // realistic size. (That floor is also why a short live feed makes this gate stand down.)
      ...Array.from({ length: 45 }, (_, k) => ({ id: `filler_${k}`, system_id: `filler_sys_${k}`, services: ['refuel'], empire: 'crimson' } as any)),
    ])
    expect(stationsInSystem('bellatrix')[0]!.empire).toBe('pirates')
    const pid = pilot('admit')
    expect(systemSellsFuelTo(pid, 'bellatrix')).toBe(false)     // Crix Stronghold: sells fuel, refuses us
    expect(systemSellsFuelTo(pid, 'cargo_lanes')).toBe(true)
    expect(systemSellsFuelTo(pid, 'silvermark')).toBe(false)    // Glintfin Range: private, no services
    __setStationsFeedForTests(null)
  })
})
