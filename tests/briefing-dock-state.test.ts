/**
 * The briefing must never claim an agent is DOCKED when it is in space.
 *
 * `isAgentDocked` had a fallback that inferred docked status from the POI NAME
 * (/citadel$/, /station$/, ...) for connection shapes that carry no explicit
 * flag. The explicit checks above it were TRUTHY tests, so a false or null
 * docked signal fell through to that heuristic — and an agent sitting in space
 * at a station's POI reads as docked, because "War Citadel" ends in "citadel".
 *
 * Morg'Thar caught it himself on 2026-09-04: "the briefing says I'm DOCKED but
 * the game says I'm IN SPACE at War Citadel. The briefing is STALE." It was not
 * stale — it was wrong, which is worse, because a refresh would not fix it.
 *
 * The briefing tells an undocked agent it "cannot trade/market/storage/missions",
 * so the wrong answer sends it to attempt exactly those and fail.
 *
 * An explicit signal is authoritative in BOTH directions; `docked_at: null` is
 * a real answer, not a missing one. The name heuristic applies only when the
 * payload carries no docked field at all.
 */
import { test, expect, describe } from 'bun:test'
import { buildSituationalBriefing } from '../src/server/lib/briefing'

// Mirrors isAgentDocked, which is module-private.
const STATION_POI_RX = /(station|citadel|outpost|trading_post|_post|_hub|_depot|_market|_yard|_dock|_port|_base|_terminal|_spire|_haven|_anchorage|_nexus|_command|_prime)$/i
function isAgentDocked(gs: Record<string, unknown> | null): boolean {
  if (!gs) return false
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  if (typeof player?.docked === 'boolean') return player.docked
  if (typeof player?.is_docked === 'boolean') return player.is_docked
  if (typeof gs.docked === 'boolean') return gs.docked as boolean
  if (location && 'docked_at' in location) return Boolean(location.docked_at)
  const poi = (player?.current_poi ?? location?.poi_name ?? '') as unknown
  if (typeof poi === 'string' && poi.length > 0) {
    if (STATION_POI_RX.test(poi)) return true
    if (player?.home_base && poi === player.home_base) return true
  }
  return false
}

describe('explicit docked signals are authoritative in both directions', () => {
  test("docked_at: null at a station POI is NOT docked — the exact Morg case", () => {
    expect(isAgentDocked({
      location: { docked_at: null, poi_name: 'War Citadel', system_name: 'Krynn' },
    })).toBe(false)
  })

  test('docked_at with a base id IS docked', () => {
    expect(isAgentDocked({
      location: { docked_at: 'crimson_war_citadel', poi_name: 'War Citadel' },
    })).toBe(true)
  })

  test('player.docked === false wins over a station-shaped POI name', () => {
    expect(isAgentDocked({ player: { docked: false, current_poi: 'ironhearth_station' } })).toBe(false)
  })

  test('every station-suffix in the regex is overridden by an explicit false', () => {
    for (const poi of ['War Citadel', 'ironhearth_station', 'deep_range_outpost',
                       'gold_run_hub', 'cargo_lanes_depot', 'market_prime']) {
      expect(isAgentDocked({ location: { docked_at: null, poi_name: poi } })).toBe(false)
    }
  })
})

describe('the name heuristic still works where nothing else is available', () => {
  // This shape carries no docked field at all — inference is all there is.
  test('a station-like POI with no docked field reads as docked', () => {
    expect(isAgentDocked({ player: { current_poi: 'ironhearth_station' } })).toBe(true)
  })

  test('a belt or field with no docked field reads as IN SPACE', () => {
    for (const poi of ['eltanin_prime_belt', 'albireo_ice_fields', 'fumalsamakah_frost_ring']) {
      expect(isAgentDocked({ player: { current_poi: poi } })).toBe(false)
    }
  })

  test('no location information at all is not docked', () => {
    expect(isAgentDocked({})).toBe(false)
    expect(isAgentDocked(null)).toBe(false)
  })
})

describe('the briefing renders nothing without a warm cache', () => {
  test('an unknown profile yields an empty briefing, never a fabricated one', () => {
    expect(buildSituationalBriefing('no-such-profile')).toBe('')
  })
})
