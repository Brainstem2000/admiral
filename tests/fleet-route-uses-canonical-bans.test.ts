import { describe, expect, test } from 'bun:test'
import { FORBIDDEN_SYSTEMS } from '../src/server/lib/db'

/**
 * fleet_route is what agents are told to use when the game's find_route offers a path
 * through a system that has killed us. It hard-coded `new Set(['goldcrest','bluerift'])`
 * — two of the nine in FORBIDDEN_SYSTEMS — so it would happily route through ross_248
 * (124 losses, the June massacre) and algol (Morg'Thar's 2,640,487 Devastator). Grit Vane
 * hit this on 2026-09-17 coming home from cargo_lanes: every route on offer crossed a
 * system on the ban list, and the designated safe fallback was not checking seven of them.
 *
 * db.ts states the intent: "The risk floor is code, not directive prose, because a
 * directive gets rewritten and this must not be." That only holds if every code path
 * reads the SAME list.
 */
const SRC = await Bun.file('src/server/lib/tools.ts').text()

describe('fleet_route excludes every fleet-banned system, not a hand-copied subset', () => {
  test('it references the canonical set rather than a literal', () => {
    const line = SRC.split('\n').find(l => /const FORBIDDEN =/.test(l))
    expect(line).toBeDefined()
    expect(line!).toContain('FORBIDDEN_SYSTEMS')
    // The specific regression: a literal Set of ids inside the handler.
    expect(line!).not.toMatch(/new Set\(\s*\[/)
  })

  test('the canonical list still contains the systems that actually killed us', () => {
    // If one of these is ever dropped, that is a deliberate act and this test should be
    // the thing that makes someone say so out loud.
    for (const id of ['ross_248', 'algol', 'alhena', 'glenhaven', 'nekkar', 'sadalmelik',
                      'xamidimura', 'goldcrest', 'bluerift']) {
      expect(FORBIDDEN_SYSTEMS.has(id)).toBe(true)
    }
  })

  test('the tool description does not promise a narrower guarantee than it delivers', () => {
    const i = SRC.indexOf("name: 'fleet_route'")
    expect(i).toBeGreaterThan(-1)
    const desc = SRC.slice(i, i + 900)
    // It used to advertise only two ids, which is how the gap survived review.
    expect(desc).not.toMatch(/forbidden systems \(goldcrest, bluerift\) automatically/)
    expect(desc).toContain('ross_248')
  })
})
