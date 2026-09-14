import { describe, expect, test } from 'bun:test'
import { getDb, recordShipModules } from '../src/server/lib/db'

/**
 * A fitted-module manifest is ONE ROW PER SLOT, never one row per module NAME.
 *
 * The pre-v9 PRIMARY KEY (profile_id, ship_id, module_name, slot) made a ship's
 * second copy of a module overwrite its first on the INSERT OR REPLACE path, so
 * a loadout carrying the same module twice was recorded as carrying it once.
 * Two things then read wrong: the CPU/power draw came up short by a whole
 * module, and anything counting fitted modules saw a free slot that was taken.
 *
 * Found live on 2026-09-14: CyberSpock's Gas Tanker carries Mining Laser II
 * twice among four utility modules. Its 15:02 capture held three utility rows
 * and reported 15 CPU / 29 power against a real 18 / 36 — which is the whole
 * margin a refit decision turns on.
 *
 * The row key is now (profile_id, ship_id, slot, slot_index), with slot_index
 * numbered within each slot family in capture order.
 */

// db.ts binds its module-level handle lazily; open it before any writer runs.
getDb()

// CyberSpock's real Gas Tanker loadout, with the discounted costs his
// Engineering skill actually charges (catalog list prices are higher).
const GAS_TANKER = [
  { name: 'Shield Booster III', slot: 'defense', cpu_usage: 4, power_usage: 9 },
  { name: 'Cargo Expander III', slot: 'utility', cpu_usage: 3, power_usage: 3 },
  { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
  { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
  { name: 'Mining Laser III', slot: 'utility', cpu_usage: 5, power_usage: 10 },
]

function rowsFor(profileId: string) {
  return getDb().query(
    'SELECT module_name, slot, slot_index, cpu, power FROM ship_modules WHERE profile_id = ? ORDER BY slot, slot_index'
  ).all(profileId) as Array<{ module_name: string; slot: string; slot_index: number; cpu: number; power: number }>
}

describe('ship module manifest', () => {
  test('a loadout carrying the same module twice records both rows', () => {
    const profileId = 'p-dup-basic'
    recordShipModules(profileId, 'gas-tanker-1', GAS_TANKER)

    const rows = rowsFor(profileId)
    expect(rows.length).toBe(5)

    const lasers = rows.filter(r => r.module_name === 'Mining Laser II')
    expect(lasers.length).toBe(2)
    // Distinguished by their slot position, not by name.
    expect(lasers.map(r => r.slot_index).sort()).toEqual([1, 2])
  })

  test('CPU and power totals count every fitted module', () => {
    const profileId = 'p-dup-totals'
    recordShipModules(profileId, 'gas-tanker-1', GAS_TANKER)

    const total = getDb().query(
      'SELECT COUNT(*) n, SUM(cpu) cpu, SUM(power) power FROM ship_modules WHERE profile_id = ?'
    ).get(profileId) as { n: number; cpu: number; power: number }

    // The bug reported 15 / 29 here — one Mining Laser II short.
    expect(total.n).toBe(5)
    expect(total.cpu).toBe(18)
    expect(total.power).toBe(36)
  })

  test('slot occupancy counts the duplicate, so a taken slot never reads free', () => {
    const profileId = 'p-dup-slots'
    recordShipModules(profileId, 'gas-tanker-1', GAS_TANKER)

    const utility = getDb().query(
      "SELECT COUNT(*) n FROM ship_modules WHERE profile_id = ? AND slot = 'utility'"
    ).get(profileId) as { n: number }
    expect(utility.n).toBe(4)   // all four utility slots are occupied
  })

  test('slot_index restarts per slot family and follows capture order', () => {
    const profileId = 'p-dup-order'
    recordShipModules(profileId, 'ship-x', [
      { name: 'Railgun II', slot: 'weapon', cpu_usage: 2, power_usage: 4 },
      { name: 'Railgun II', slot: 'weapon', cpu_usage: 2, power_usage: 4 },
      { name: 'Armor Plate II', slot: 'defense', cpu_usage: 1, power_usage: 2 },
      { name: 'Railgun II', slot: 'weapon', cpu_usage: 2, power_usage: 4 },
    ])

    const rows = rowsFor(profileId)
    expect(rows.filter(r => r.slot === 'weapon').map(r => r.slot_index)).toEqual([0, 1, 2])
    expect(rows.filter(r => r.slot === 'defense').map(r => r.slot_index)).toEqual([0])
  })

  test('a re-capture replaces the manifest rather than accumulating rows', () => {
    const profileId = 'p-dup-replace'
    recordShipModules(profileId, 'gas-tanker-1', GAS_TANKER)
    expect(rowsFor(profileId).length).toBe(5)

    // The expander comes out, an iron filter goes in: still four utility slots.
    recordShipModules(profileId, 'gas-tanker-1', [
      { name: 'Shield Booster III', slot: 'defense', cpu_usage: 4, power_usage: 9 },
      { name: 'Magnetic Ore Separator', slot: 'utility', cpu_usage: 2, power_usage: 11 },
      { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
      { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
      { name: 'Mining Laser III', slot: 'utility', cpu_usage: 5, power_usage: 10 },
    ])

    const rows = rowsFor(profileId)
    expect(rows.length).toBe(5)
    expect(rows.some(r => r.module_name === 'Cargo Expander III')).toBe(false)
    expect(rows.filter(r => r.module_name === 'Mining Laser II').length).toBe(2)
  })

  test('a module with no name is skipped without shifting the slots after it', () => {
    const profileId = 'p-dup-unnamed'
    recordShipModules(profileId, 'ship-y', [
      { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
      { slot: 'utility', cpu_usage: 99, power_usage: 99 },
      { name: 'Mining Laser II', slot: 'utility', cpu_usage: 3, power_usage: 7 },
    ])

    const rows = rowsFor(profileId)
    expect(rows.length).toBe(2)
    expect(rows.map(r => r.slot_index)).toEqual([0, 1])
    const total = rows.reduce((s, r) => s + r.cpu, 0)
    expect(total).toBe(6)
  })
})
