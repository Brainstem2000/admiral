import { describe, expect, test } from 'bun:test'
import { FORBIDDEN_SYSTEMS, assessSystemDanger } from '../src/server/lib/db'

/**
 * The fleet's no-go list is derived from our OWN graveyard, not from the game's
 * danger grading, and it is CODE rather than directive prose on purpose.
 *
 * On 2026-09-14 Brian cleared Morg'Thar to "take more risks". I removed the ban
 * on Alhena and lawless space from his directive wholesale. He flew to Alhena and
 * lost the Warmaul to pirates (516,324 insured), then lost a Gauntlet at
 * Glenhaven. Alhena had already killed five other fleet ships, and Algol had
 * eaten the Crimson Devastator on 2026-09-03 for 2,640,487 — our worst single
 * loss ever.
 *
 * Brian, the morning after: "You should have kept him out of Alhena and where he
 * lost the previous [capital ship]."
 *
 * The lesson encoded here: clearing an agent for more risk is a decision about
 * which CONTRACTS they take. It is never a licence to enter a system that has
 * already destroyed a capital hull. A directive can be rewritten in a nudge at
 * 2am; this list cannot.
 */

/** Losses recorded per system in action_events, self-destructs excluded. */
const GRAVEYARD: Array<[string, number, string]> = [
  ['ross_248', 124, 'the June massacre'],
  ['goldcrest', 12, 'wildlife, twelve in one morning'],
  ['xamidimura', 9, ''],
  ['alhena', 6, "Morg'Thar's Warmaul, 516,324"],
  ['algol', 1, "Morg'Thar's Crimson Devastator, 2,640,487 — worst ever"],
  ['glenhaven', 1, "Morg'Thar's Gauntlet, no payout"],
  ['nekkar', 3, ''],
  ['sadalmelik', 3, ''],
]

describe('every system that has killed a fleet ship is banned', () => {
  for (const [sys, losses, note] of GRAVEYARD) {
    test(`${sys} — ${losses} loss(es)${note ? `, ${note}` : ''}`, () => {
      expect(FORBIDDEN_SYSTEMS.has(sys)).toBe(true)
    })
  }

  test('the two original bans survive', () => {
    expect(FORBIDDEN_SYSTEMS.has('goldcrest')).toBe(true)
    expect(FORBIDDEN_SYSTEMS.has('bluerift')).toBe(true)
  })

  test('a banned system grades FORBIDDEN regardless of its police level', () => {
    // Alhena is policed enough to look survivable. It is not — it has taken six.
    const v = assessSystemDanger('alhena')
    expect(v.grade).toBe('FORBIDDEN')
  })

  test('the check is case and whitespace insensitive', () => {
    expect(assessSystemDanger('  ALHENA ').grade).toBe('FORBIDDEN')
  })

  test('the working systems are NOT banned — the list must not strangle the fleet', () => {
    // Everything the miners and the hunter actually use every day.
    for (const ok of ['krynn', 'the_anvil', 'frostfeld', 'hd_20794', 'bharani',
                      'trappist_1', 'the_crucible', 'blood_forge', 'ironhearth', 'haven']) {
      expect(FORBIDDEN_SYSTEMS.has(ok)).toBe(false)
    }
  })
})
