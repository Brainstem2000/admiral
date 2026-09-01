import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// buildSituationalBriefing reads recurring obligations from SQLite, so the db
// layer must have a writable workspace. Point it at a throwaway dir (same
// approach as tests/helpers/db-migration-check.ts) rather than the live
// data/admiral.db, which holds real fleet state and credentials.
const cwd = process.cwd()
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-briefing-test-'))
process.chdir(workspace)
afterAll(() => {
  process.chdir(cwd)
  fs.rmSync(workspace, { recursive: true, force: true })
})

// db.ts caches a module-level handle that most helpers use directly; the server
// primes it via getDb() at boot, so a test must do the same before the briefing
// touches SQLite.
const { getDb } = await import('../src/server/lib/db')
getDb()

const { refreshBriefingData, buildSituationalBriefing, clearBriefingCache } =
  await import('../src/server/lib/briefing')

/**
 * The situational briefing reported the ship's class and cargo but never its
 * WEAPONS. So the agent re-derived its own armament from get_ship every turn
 * and got it wrong.
 *
 * Morg'Thar, 2026-09-01: seven weapons across two ammo types. He burned ~11
 * tool rounds guessing which of seven near-identical weapon ids to reload,
 * alternated between `id` and `weapon_instance_id`, called help(reload), and
 * re-ran get_ship twice — and was stocking 89 standard_rounds_box, which feeds
 * ONE gun that was already full at 999/1000, while SIX of his seven weapons
 * fire ferrous_slug_case and were nearly dry.
 *
 * get_status carries no `modules` array, so the collector has to fetch
 * get_ship (a free query) and graft it on.
 */

const SHIP_WITH_SEVEN_WEAPONS = {
  modules: [
    { id: 'd480def5', type: 'fury_cannon', slot: 'weapon', loaded_ammo_id: 'standard_rounds_box', current_ammo: 999 },
    { id: '3b19ed4d', type: 'mass_driver', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 9 },
    { id: 'f2a8d2de', type: 'mass_driver', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 9 },
    { id: '4d8c2794', type: 'piercing_railgun_ii', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 9 },
    { id: '80c68c01', type: 'piercing_railgun_ii', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 9 },
    { id: 'b2f43f54', type: 'railgun_ii', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 6 },
    { id: '8b21a7a0', type: 'railgun_ii', slot: 'weapon', loaded_ammo_id: 'ferrous_slug_case', current_ammo: 6 },
    { id: '37c8fce7', type: 'crimson_berserker_plating', slot: 'defense' },
  ],
}

const STATUS = {
  player: { credits: 80235, system: 'alhena', current_poi: 'voss_redoubt' },
  // No `modules` here — this is the shape that made the loadout invisible.
  ship: { class: 'crimson_devastator', cargo_used: 98, cargo_capacity: 120, fuel: 344, max_fuel: 350, hull: 1685, max_hull: 1785 },
  location: { system_name: 'alhena', poi_name: 'Voss Redoubt' },
}

function stubConnection(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    getLocalState: () => null,
    onNotification: () => {},
    execute: async (command: string) => {
      if (command === 'get_status') return { result: STATUS }
      if (command === 'get_ship') return { result: overrides.ship ?? SHIP_WITH_SEVEN_WEAPONS }
      if (command === 'get_cargo') return { result: { cargo: [{ item_id: 'standard_rounds_box', quantity: 89 }] } }
      return { result: null }
    },
  } as any
}

describe('briefing weapon loadout', () => {
  test('the briefing names every weapon, its ammo and its reload id', async () => {
    const pid = `p-brief-${Math.random()}`
    clearBriefingCache(pid)
    await refreshBriefingData(pid, stubConnection())
    const b = buildSituationalBriefing(pid)

    expect(b).toContain('Weapons')
    // All three weapon kinds are named...
    expect(b).toContain('fury_cannon')
    expect(b).toContain('mass_driver')
    expect(b).toContain('piercing_railgun_ii')
    expect(b).toContain('railgun_ii')
    // ...with the ammo each one actually fires...
    expect(b).toContain('ferrous_slug_case')
    expect(b).toContain('standard_rounds_box')
    // ...and the ids reload needs, so they are not guessed.
    expect(b).toContain('80c68c01')
    expect(b).toContain('8b21a7a0')
    // Defense modules are not weapons and must not be listed as such.
    expect(b).not.toContain('crimson_berserker_plating')
  })

  test('identical guns are grouped rather than listed seven times', async () => {
    const pid = `p-brief-group-${Math.random()}`
    clearBriefingCache(pid)
    await refreshBriefingData(pid, stubConnection())
    const b = buildSituationalBriefing(pid)

    // Two mass_drivers collapse to one line with a count.
    expect(b).toMatch(/mass_driver x2/)
    expect(b).toMatch(/piercing_railgun_ii x2/)
    // The single fury_cannon carries no count suffix.
    expect(b).toMatch(/fury_cannon ->/)
  })

  test('a ship with no modules does not emit an empty Weapons section', async () => {
    const pid = `p-brief-none-${Math.random()}`
    clearBriefingCache(pid)
    await refreshBriefingData(pid, stubConnection({ ship: { modules: [] } }))
    const b = buildSituationalBriefing(pid)

    expect(b).not.toContain('Weapons')
    // ...but the rest of the briefing still renders.
    expect(b).toContain('crimson_devastator')
  })
})
