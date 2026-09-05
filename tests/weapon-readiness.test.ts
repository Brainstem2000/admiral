/**
 * The briefing called a nearly-full gun EMPTY, and the agent argued with it every turn.
 *
 * "Ready" was computed as `cur >= cap - 1` — the magazine had to be FULL. On
 * 2026-09-05 Morg'Thar's Autocannon I held 493 of 500 rounds, which is not
 * >= 499, so no weapon counted as ready and the briefing emitted:
 *
 *   "WEAPON READINESS: ALL 1 MAGAZINES EMPTY — you cannot win a fight.
 *    Do not attack. Travel to ammo, buy it, reload, then hunt."
 *
 * Directly above it, the same briefing printed "loaded 493/500". He spent turns
 * reconciling the contradiction, wrote it into his own memory as a standing
 * lesson ("Briefing warning MAGAZINES EMPTY is STALE and CONTRADICTED by the
 * weapon status line"), and re-derived that reconciliation on later turns —
 * which is a large part of why his thoughts opened with an alarm banner.
 *
 * Injected state outranks what the agent observes, so a wrong line here is
 * worse than no line: it tells a combat-capable ship to stand down.
 *
 * READY answers "can this gun fire" (cur > 0). FULL answers "does it need
 * topping up" (cur >= cap - 1). They are different questions and the readiness
 * line only ever wanted the first.
 */
import { test, expect, describe } from 'bun:test'

interface Gun { current_ammo: number; magazine_size: number }

/** Mirrors the readiness classification in briefing.ts. */
function readiness(weapons: Gun[]): 'COMBAT READY' | 'CAN FIGHT' | 'ALL EMPTY' | 'UNKNOWN' {
  let ready = 0, full = 0, knownCaps = 0
  for (const w of weapons) {
    const cur = Number(w.current_ammo ?? 0) || 0
    const cap = Number(w.magazine_size ?? NaN)
    if (cur > 0) ready++
    if (Number.isFinite(cap) && cap > 0) { knownCaps++; if (cur >= cap - 1) full++ }
  }
  if (knownCaps !== weapons.length) return 'UNKNOWN'
  if (full === weapons.length) return 'COMBAT READY'
  if (ready > 0) return 'CAN FIGHT'
  return 'ALL EMPTY'
}

describe("a gun with rounds in it is never reported empty", () => {
  test("Morg'Thar's 493/500 autocannon — the exact case", () => {
    expect(readiness([{ current_ammo: 493, magazine_size: 500 }])).toBe('CAN FIGHT')
  })

  test('a single round still means the ship can fight', () => {
    expect(readiness([{ current_ammo: 1, magazine_size: 650 }])).toBe('CAN FIGHT')
  })

  test('only a genuinely empty magazine reports empty', () => {
    expect(readiness([{ current_ammo: 0, magazine_size: 500 }])).toBe('ALL EMPTY')
  })

  test('several guns, all with rounds but none topped up', () => {
    // Two autocannons at 493 and 480 of 500 — the old rule called this ALL EMPTY.
    expect(readiness([
      { current_ammo: 493, magazine_size: 500 },
      { current_ammo: 480, magazine_size: 500 },
    ])).toBe('CAN FIGHT')
  })
})

describe('full still means full, so a ready ship is not sent shopping', () => {
  test('a topped-up magazine reports combat ready', () => {
    expect(readiness([{ current_ammo: 650, magazine_size: 650 }])).toBe('COMBAT READY')
  })

  test('one missing round in a large magazine is still operationally full', () => {
    // The original intent, preserved: 999/1000 must not become an ammo errand.
    expect(readiness([{ current_ammo: 999, magazine_size: 1000 }])).toBe('COMBAT READY')
  })

  test('a mixed loadout reports that it can fight, not that it is ready', () => {
    expect(readiness([
      { current_ammo: 500, magazine_size: 500 },
      { current_ammo: 0, magazine_size: 650 },
    ])).toBe('CAN FIGHT')
  })

  test('every magazine empty across several guns is the only all-empty case', () => {
    expect(readiness([
      { current_ammo: 0, magazine_size: 500 },
      { current_ammo: 0, magazine_size: 650 },
    ])).toBe('ALL EMPTY')
  })
})

describe('an unreadable magazine suppresses the verdict entirely', () => {
  test('no capacity means no readiness claim, rather than a guess', () => {
    expect(readiness([{ current_ammo: 10, magazine_size: NaN as unknown as number }])).toBe('UNKNOWN')
  })
})
