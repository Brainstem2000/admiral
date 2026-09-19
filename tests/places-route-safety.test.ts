import { describe, expect, test } from 'bun:test'
import { getDb, banSystem } from '../src/server/lib/db'
import { routeWithSafety, riskOf, KILLZONES } from '../src/server/lib/places'

/**
 * The game's find_route returns a path and says nothing about its safety. Grading
 * a corridor by its DESTINATION is how 228 weapon_core were sent down a 13-hop
 * zero-police run to a policed station. A corridor is exactly as safe as its worst
 * intermediate jump, so that is what gets reported.
 *
 * Travel doctrine is TIERED, not a ban: only systems where the fleet has lost a capital
 * ship are hard-banned (learned, 2026-09-18), and a zero-police system that is not one of
 * them is workable with the right hull.
 * Grading all lawless space as forbidden is what left every silver and silicon
 * seam "unreachable" while agents idled — all of them sit at police 0.
 */
function link(a: string, b: string) {
  getDb().query('INSERT OR IGNORE INTO system_links (a, b, source) VALUES (?, ?, ?)').run(a, b, 'test')
}
function sys(id: string, police: number) {
  getDb().query(`INSERT OR REPLACE INTO fleet_intel_systems
      (system_id, system_name, police_level, discovered_by) VALUES (?, ?, ?, ?)`)
    .run(id, id, police, 'test')
}

describe('a route is graded by its worst hop, not its destination', () => {
  test('a policed destination reached through lawless space reports the lawless hop', () => {
    sys('t_home', 100); sys('t_mid', 0); sys('t_dest', 90)
    link('t_home', 't_mid'); link('t_mid', 't_dest')

    const r = routeWithSafety('t_home', 't_dest')
    expect(r.found).toBe(true)
    expect(r.jumps).toBe(2)
    expect(r.lawless_hops).toBe(1)
    // The destination is safe. The RUN is not. That distinction is the whole point.
    expect(r.worst?.system_id).toBe('t_mid')
    expect(r.worst?.risk).toBe('lawless')
  })

  test('endpoints are excluded from the worst-hop verdict — you chose to be there', () => {
    sys('t_law_a', 0); sys('t_safe_mid', 100); sys('t_law_b', 0)
    link('t_law_a', 't_safe_mid'); link('t_safe_mid', 't_law_b')

    const r = routeWithSafety('t_law_a', 't_law_b')
    expect(r.worst?.system_id).toBe('t_safe_mid')   // the only hop you cannot opt out of
    expect(r.lawless_hops).toBe(0)
  })

  test('a killzone in the corridor is flagged and a detour offered when one exists', () => {
    const kz = 't_kz_banned'
    banSystem({ system_id: kz, source: 'seed:test' })
    // The direct run crosses the banned system in 2 hops; the detour takes 3. It must be
    // strictly longer, or which path BFS returns depends on the order ids sort in — this
    // test once passed only because '70_ophiuchi' happened to sort before 't_k_long'.
    sys('t_k_home', 100); sys(kz, 0); sys('t_k_dest', 80); sys('t_k_long', 30); sys('t_k_long2', 30)
    link('t_k_home', kz); link(kz, 't_k_dest')
    link('t_k_home', 't_k_long'); link('t_k_long', 't_k_long2'); link('t_k_long2', 't_k_dest')

    const r = routeWithSafety('t_k_home', 't_k_dest')
    expect(r.crosses_killzone).toBe(true)
    expect(r.detour).toBeDefined()
    expect(r.detour!.found).toBe(true)
    expect(r.detour!.crosses_killzone).toBe(false)
  })

  test('an unsurveyed system is "thin", never assumed safe', () => {
    expect(riskOf(`t_unknown_${Math.random().toString(36).slice(2, 7)}`).risk).toBe('thin')
  })

  test('zero police is lawless but NOT a hard ban unless a capital ship was lost there', () => {
    sys('t_plain_lawless', 0)
    const r = riskOf('t_plain_lawless')
    expect(r.risk).toBe('lawless')
    expect(r.killzone).toBe(false)          // tiered doctrine: workable with the right hull
    banSystem({ system_id: 't_capital_grave', source: 'seed:test' })
    expect(KILLZONES.has('t_capital_grave')).toBe(true)
    expect(riskOf('t_capital_grave').killzone).toBe(true)
  })

  test('no path returns found:false rather than a misleading empty route', () => {
    sys('t_island_a', 100); sys('t_island_b', 100)   // deliberately unlinked
    expect(routeWithSafety('t_island_a', 't_island_b').found).toBe(false)
  })
})
