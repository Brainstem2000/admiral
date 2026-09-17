import { describe, expect, test } from 'bun:test'
import { __setStationsFeedForTests, systemForBase, stationsFeedAvailable, MIN_PLAUSIBLE_STATIONS } from '../src/server/lib/stations-feed'

/**
 * `goto_system` takes a SYSTEM, but every directive, package manifest and vault
 * listing names STATIONS — so agents hand it a station id and eat a refusal they
 * then reason their way out of, a turn at a time. Three did it in one evening on
 * 2026-09-17: iron_reach_mining_colony for iron_reach, frontier_station for
 * starfall, node_beta_industrial_station for node_beta.
 *
 * Prompt wording cannot fix this — the two ids look interchangeable and the station
 * is what every other part of the game hands you — so the harness resolves it from
 * the station feed. These tests pin the behaviour the resolver relies on.
 */
const REAL = [
  { id: 'iron_reach_mining_colony', base_id: 'iron_reach_mining_colony', system_id: 'iron_reach' },
  // Deliberately NOT named after its system. A prefix match would fail here, which
  // is exactly what sent a hauler hunting the wrong system.
  { id: 'grand_exchange_station', base_id: 'grand_exchange_station', system_id: 'haven' },
  { id: 'frontier_station', base_id: 'frontier_station', system_id: 'starfall' },
]
// The feed refuses to answer from a truncated snapshot (MIN_PLAUSIBLE_STATIONS),
// so pad past that floor or every lookup returns null.
const filler = Array.from({ length: MIN_PLAUSIBLE_STATIONS + 5 }, (_, i) => ({
  id: `filler_${i}`, base_id: `filler_${i}`, system_id: `filler_sys_${i}`,
}))
const seed = () => __setStationsFeedForTests([...REAL, ...filler])

describe('a station id resolves to its system', () => {
  test('station -> system, including stations not named after their system', () => {
    seed()
    expect(systemForBase('iron_reach_mining_colony')).toBe('iron_reach')
    expect(systemForBase('grand_exchange_station')).toBe('haven')
    expect(systemForBase('frontier_station')).toBe('starfall')
  })

  test('a SYSTEM id resolves to nothing, so a correct call is never rewritten', () => {
    seed()
    expect(systemForBase('iron_reach')).toBeNull()
    expect(systemForBase('haven')).toBeNull()
  })

  test('an unknown id resolves to nothing rather than guessing', () => {
    seed()
    expect(systemForBase('somewhere_invented')).toBeNull()
  })

  test('a truncated feed answers nothing — the resolver degrades to old behaviour, never to a wrong system', () => {
    // This is the safety property that matters: if the feed is thin or stale the
    // resolver must do NOTHING, not guess. A wrong rewrite would send a ship to
    // the wrong end of the galaxy.
    __setStationsFeedForTests(REAL)            // 3 stations, under the floor
    expect(stationsFeedAvailable()).toBe(false)
    expect(systemForBase('iron_reach_mining_colony')).toBeNull()
  })

  test('a stale feed also answers nothing', () => {
    __setStationsFeedForTests([...REAL, ...filler], Date.now() - 30 * 24 * 3600_000)
    expect(systemForBase('iron_reach_mining_colony')).toBeNull()
  })
})
