import { describe, expect, test } from 'bun:test'
import { getDb, findDeposits, searchDepositItems } from '../src/server/lib/db'

/**
 * "Where can we mine titanium" had an answer in the database and no way to ask it.
 *
 * 1,210 deposit readings across 385 POIs were being captured and never surfaced, so
 * the standing answer was to send somebody to fly and find out again — past belts the
 * fleet had already logged. These are the two rules the lookup has to hold, both of
 * which have cost real trips:
 *
 *  - Rank on RICHNESS, not `remaining`. Richness is a property of the seam. `remaining`
 *    is a reading that was true once and moves in both directions as a belt is mined and
 *    regenerates, and the game gates extraction on `too_sparse` against a
 *    `lock_minimum_stock` we never store. Ordering on it buries a rich seam under a
 *    poor one that happened to be measured when full.
 *  - Match how a person types. "titanium", "Titanium Ore" and "titanium_ore" are one
 *    question, and an exact-id-only lookup answers "nothing" to two of them — which
 *    reads as "we have never seen it" and is a different, wrong answer.
 */

const seed = getDb()
seed.query('DELETE FROM fleet_intel_deposits').run()
const rows: Array<[string, string, string, string, string, number, number, number]> = [
  // poi_id, item_id, system_id, poi_name, item_name, richness, remaining, supported_power
  ['rich_but_worked', 'titanium_ore', 'alphecca', 'Deep Titanium Vein', 'Titanium Ore', 34, 701, 35],
  ['poor_but_full',   'titanium_ore', 'frontier', 'Pioneer Fields',     'Titanium Ore', 12, 90000, 12],
  ['tapped_out',      'titanium_ore', 'alniyat',  'Alniyat Debris Ring','Titanium Ore', 20, 0,     1],
  ['crystal_site',    'energy_crystal','ivorygate','Forgotten Prism',   'Energy Crystal', 22, 2344, 117],
]
for (const r of rows) {
  seed.query(`INSERT OR REPLACE INTO fleet_intel_deposits
    (poi_id, item_id, system_id, poi_name, item_name, richness, remaining, supported_power, reported_by, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-seed', datetime('now'))`).run(...r)
}

describe('where to mine', () => {
  test('ranks on richness, never on the remaining count', () => {
    const found = findDeposits('titanium_ore', 25)
    expect(found.length).toBe(2) // the tapped-out one is filtered by default
    // poor_but_full holds 128x more by the last reading. It must not come first.
    expect(found[0]!.poi_id).toBe('rich_but_worked')
    expect(found[1]!.poi_id).toBe('poor_but_full')
  })

  test('a belt last seen empty is still listed when asked for — it regenerates', () => {
    const all = findDeposits('titanium_ore', 25, true)
    expect(all.map(r => r.poi_id)).toContain('tapped_out')
  })

  test('every row carries the age of its reading, so nothing reads as fresh by omission', () => {
    const [first] = findDeposits('titanium_ore', 1)
    expect(first).toHaveProperty('age_days')
    expect(Number(first!.age_days)).toBeLessThan(1)
  })

  test('matches the id, the display name, and a bare word', () => {
    for (const q of ['titanium_ore', 'titanium', 'Titanium Ore', 'TITANIUM']) {
      const hit = searchDepositItems(q).map(r => r.item_id)
      expect(hit).toContain('titanium_ore')
    }
    // "energy crystal" with a space must reach energy_crystal
    expect(searchDepositItems('energy crystal').map(r => r.item_id)).toContain('energy_crystal')
  })

  test('an empty query lists every ore we have actually seen in the ground', () => {
    const all = searchDepositItems('')
    expect(all.map(r => r.item_id).sort()).toEqual(['energy_crystal', 'titanium_ore'])
    const ti = all.find(r => r.item_id === 'titanium_ore')!
    expect(ti.pois).toBe(3)        // counts the tapped-out site: it is still a known place
    expect(ti.best_richness).toBe(34)
  })

  test('an ore nobody surveyed returns nothing, not a guess', () => {
    expect(findDeposits('adamantite_ore', 25)).toEqual([])
    expect(searchDepositItems('adamantite')).toEqual([])
  })
})

/**
 * "How far is that from me" is the second half of the question, and it is asked in
 * whatever way is to hand — a system id, a station, or half a name typed from memory.
 * A station is not a node in the route graph, so it has to be converted to the system
 * it sits in; handing `gold_run_extraction_hub` straight to the router returns "no
 * route" for a place that is 24 jumps away.
 */
describe('measuring from where you actually are', () => {
  test('a station resolves to the system it sits in, not to nothing', () => {
    const { systemFor } = require('../src/server/lib/places')
    const d = getDb()
    d.query(`INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, has_station, discovered_by)
             VALUES ('gold_run','Gold Run',1,'test-seed')`).run()
    // The real case from the route-graph fix: asking from a STATION returned "no
    // known route" for a place 24 jumps out, because a station is not a graph node.
    expect(systemFor('gold_run_extraction_hub')).toBe('gold_run')
    expect(systemFor('gold_run')).toBe('gold_run')
  })

  test('half a name that matches one place is not a question', () => {
    const { resolvePlace } = require('../src/server/lib/places')
    const d = getDb()
    d.query(`INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, has_station, discovered_by)
             VALUES ('ivorygate','Ivorygate',0,'test-seed')`).run()
    expect(resolvePlace('ivoryg').exact).toBe('ivorygate')
  })

  test('a fragment matching several places asks rather than guessing an end of the map', () => {
    const { resolvePlace } = require('../src/server/lib/places')
    const d = getDb()
    for (const id of ['crystal_reach', 'crystal_vale']) {
      d.query(`INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, has_station, discovered_by)
               VALUES (?,?,0,'test-seed')`).run(id, id)
    }
    const r = resolvePlace('crystal_')
    expect(r.exact).toBeNull()
    expect(r.candidates.length).toBeGreaterThan(1)
  })
})
