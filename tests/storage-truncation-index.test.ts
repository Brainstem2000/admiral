/**
 * A truncated storage listing reads as ZERO, not as "cut off".
 *
 * The mission board already had this fix (missionIndexFor) because a missing
 * mission id answers `mission_not_found` — loud, and the agent knows to report a
 * blocker. A missing STORAGE line is silent and worse: the agent concludes the
 * material is absent and acts on that conclusion.
 *
 * Observed 2026-09-16 at Crimson War Citadel, whose faction vault holds 106 line
 * items and renders past the 4,000-char cap. Morg'Thar reported the vault view
 * "truncated, without showing control_node" while 249 control_node sat in it;
 * Nova Reyes hit the same cut on copper_ore with 2,931 present. Both were blocked
 * on stock they were standing next to, and the first facility of the whole
 * programme stalled for half an hour.
 */
import { test, expect } from 'bun:test'
// Imports the REAL function, not a mirror. tests/preload.ts points tools.ts at a
// throwaway data dir, so this never touches data/admiral.db. A mirrored copy —
// the pattern used by mission-board-truncation.test.ts — can pass while the
// shipped function is broken, which is the opposite of what this test is for.
import { storageIndexFor } from '../src/server/lib/tools'

/** A vault big enough to blow the cap, with the two items that actually got lost. */
function bigVault() {
  const items = [
    { item_id: 'control_node', quantity: 249 },
    { item_id: 'copper_ore', quantity: 2931 },
  ]
  for (let i = 0; i < 104; i++) items.push({ item_id: `filler_item_${i}`, quantity: i + 1 })
  return { base_id: 'crimson_war_citadel', items }
}

test('a listing under the cap gets no index appended', () => {
  const short = 'Storage at crimson_war_citadel\nItems (2):\ncontrol_node\t249'
  expect(storageIndexFor(short, bigVault(), 'view_faction_storage')).toBe('')
})

test('a truncated listing appends every item id and quantity', () => {
  const long = 'x'.repeat(5000)   // past MAX_RESULT_CHARS (4000)
  const idx = storageIndexFor(long, bigVault(), 'view_faction_storage')
  expect(idx).not.toBe('')
  // The two items that were actually lost in production must be present.
  expect(idx).toContain('control_node 249')
  expect(idx).toContain('copper_ore 2931')
  // And it must say WHERE, because storage is per-station and a quantity without
  // a station is the error that has cost this project the most.
  expect(idx).toContain('crimson_war_citadel')
})

test('the index warns that missing lines are missing, not zero', () => {
  const idx = storageIndexFor('x'.repeat(5000), bigVault(), 'view_faction_storage')
  // The agent must not read a short list as "that is everything I have".
  expect(idx).toMatch(/MISSING, not zero/)
})

test('it applies to personal storage too, and ignores unrelated commands', () => {
  const long = 'x'.repeat(5000)
  expect(storageIndexFor(long, bigVault(), 'view_storage')).toContain('control_node 249')
  expect(storageIndexFor(long, bigVault(), 'get_missions')).toBe('')
  expect(storageIndexFor(long, bigVault(), undefined)).toBe('')
})

test('zero-quantity rows are omitted so the index stays readable', () => {
  const data = { base_id: 's1', items: [{ item_id: 'a', quantity: 5 }, { item_id: 'b', quantity: 0 }] }
  const idx = storageIndexFor('x'.repeat(5000), data, 'view_storage')
  expect(idx).toContain('a 5')
  expect(idx).not.toContain('b 0')
})
