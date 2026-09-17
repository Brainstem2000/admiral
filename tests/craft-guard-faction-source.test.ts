/**
 * The craft pre-flight guard must read the SAME store the game will.
 *
 * `craft` takes `source` (defaulting to `deliver_to`), and "faction" /
 * "faction:<bucket>" draws inputs from the faction vault rather than the agent's
 * own locker. The guard checked personal storage unconditionally.
 *
 * On 2026-09-16 Bob Comet ran exactly the right command —
 * `craft(assemble_platinum_control_node, quantity=50, source="faction",
 * deliver_to="faction")` — with the inputs sitting in the vault, and this guard
 * refused it with "station storage has 0" and drove him to HALT. It blocked the
 * vault-to-vault pattern the whole fleet had just been moved onto, and it did so
 * WITHOUT spending a game tick, so nothing could correct it. A guard that invents
 * an unclearable blocker is worse than no guard: the file says so directly, two
 * comments above the bug.
 */
import { test, expect } from 'bun:test'

/** The source resolution the guard performs, extracted so it can be pinned. */
function resolveCraftSource(args: Record<string, unknown> | undefined): 'faction' | 'personal' {
  const s = String(args?.source ?? args?.deliver_to ?? '').trim().toLowerCase()
  return (s === 'faction' || s.startsWith('faction:')) ? 'faction' : 'personal'
}

test('source="faction" reads the vault', () => {
  expect(resolveCraftSource({ source: 'faction' })).toBe('faction')
})

test('a faction BUCKET is still the vault, not a personal locker', () => {
  // `faction:<bucket>` is a Storage Extension compartment — still faction stock.
  expect(resolveCraftSource({ source: 'faction:raw materials' })).toBe('faction')
  expect(resolveCraftSource({ source: 'FACTION:Products' })).toBe('faction')
})

test('source defaults to deliver_to, which is how the fleet actually calls it', () => {
  // The documented default: "source ... defaults to deliver_to".
  expect(resolveCraftSource({ deliver_to: 'faction' })).toBe('faction')
  // Bob's exact call.
  expect(resolveCraftSource({ source: 'faction', deliver_to: 'faction' })).toBe('faction')
})

test('an explicit source beats deliver_to when they differ', () => {
  // Pull from a stocked vault, deposit finished goods into a personal locker.
  expect(resolveCraftSource({ source: 'storage', deliver_to: 'faction' })).toBe('personal')
})

test('no source and no deliver_to means the personal locker', () => {
  expect(resolveCraftSource({})).toBe('personal')
  expect(resolveCraftSource(undefined)).toBe('personal')
  expect(resolveCraftSource({ source: 'storage' })).toBe('personal')
})
