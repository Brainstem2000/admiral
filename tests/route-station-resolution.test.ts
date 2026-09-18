import { describe, expect, test } from 'bun:test'
import { getDb } from '../src/server/lib/db'
import { resolvePlace, systemFor } from '../src/server/lib/places'

// The test process runs on a throwaway database (tests/preload.ts), so the intel rows
// these lookups read are seeded here rather than taken from data/admiral.db — a test
// that touches the live map once announced a 5-jump path that did not exist.
// The EMPTY system_id row is seeded on purpose: it exists in production and matches
// `x LIKE '' || '%'` for every string, so any query that forgets to exclude it collapses
// the entire map. The last test below is the guard for exactly that.
const seed = getDb()
for (const id of ['krynn', 'iron_reach', 'ironhearth', 'ironhollow', 'ironpeak', 'ironveil',
                  'gold_run', 'blood_forge', '']) {
  seed.query('INSERT OR REPLACE INTO fleet_intel_systems (system_id, system_name, has_station, discovered_by) VALUES (?, ?, ?, ?)')
      .run(id, id || '(blank)', 1, 'test-seed')
}
// Stations come from the faction table here: storage_inventory has a foreign key to
// profiles, and seeding a whole profile to test a name lookup is more fixture than the
// thing under test deserves.
for (const station of ['iron_reach_mining_colony', 'gold_run_extraction_hub', 'blood_forge_smelting_works']) {
  seed.query('INSERT OR REPLACE INTO faction_storage_inventory (faction_id, station_id, item_id, item_name, quantity, updated_at) VALUES (?,?,?,?,?,?)')
      .run('t-fac', station, 'iron_ore', 'Iron Ore', 1, new Date().toISOString())
}

/**
 * Asking for a route to a STATION is the normal way to ask, and it used to answer
 * "No known route — the map graph may not reach it."
 *
 * Two separate causes, both of which made a reachable place look unreachable:
 *   1. A partial name ("iron") matched nothing exactly, and the miss was reported as a
 *      routing failure rather than as an ambiguous query. Five systems matched.
 *   2. A station id resolved fine but is not a NODE in the system graph — gold_run
 *      _extraction_hub sits in gold_run, 24 jumps from Krynn, and the route was there
 *      the whole time.
 *
 * These assert the properties rather than specific galaxy contents, which move.
 */
describe('place resolution', () => {
  test('an exact system id resolves to itself with no questions', () => {
    const r = resolvePlace('krynn')
    expect(r.exact).toBe('krynn')
    expect(r.candidates).toHaveLength(0)
  })

  test('a partial name returns candidates instead of a silent miss', () => {
    const r = resolvePlace('iron')
    expect(r.exact).toBeNull()
    expect(r.candidates.length).toBeGreaterThan(1)
    expect(r.candidates).toContain('iron_reach')
  })

  test('candidates are shortest-first, so the system outranks its station', () => {
    const r = resolvePlace('iron')
    expect(r.candidates.indexOf('iron_reach'))
      .toBeLessThan(r.candidates.indexOf('iron_reach_mining_colony'))
  })

  test('empty input asks nothing and matches nothing', () => {
    expect(resolvePlace('   ')).toEqual({ exact: null, candidates: [] })
  })
})

describe('station to system', () => {
  test('a station resolves to the system it sits in', () => {
    expect(systemFor('gold_run_extraction_hub')).toBe('gold_run')
  })

  test('a system resolves to itself and is never re-prefixed', () => {
    expect(systemFor('krynn')).toBe('krynn')
    expect(systemFor('iron_reach')).toBe('iron_reach')
  })

  test('an unknown place is returned unchanged rather than guessed at', () => {
    expect(systemFor('somewhere_that_does_not_exist')).toBe('somewhere_that_does_not_exist')
  })

  test('the empty system_id row never swallows a lookup', () => {
    // `x LIKE '' || '%'` is true for every string; if that row is matched, EVERY station
    // resolves to '' and the whole map collapses. It has happened once already.
    expect(systemFor('blood_forge_smelting_works')).not.toBe('')
  })
})
