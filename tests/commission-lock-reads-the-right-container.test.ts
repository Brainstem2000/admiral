import { describe, expect, test } from 'bun:test'
import { getDb, setCommissionRequirements, getCommissionRequirement } from '../src/server/lib/db'

/**
 * A shipyard commission reads CARGO and the pilot's PERSONAL LOCKER — never the
 * faction vault (docs/shipyard; the three-containers rule). So a craft that draws
 * from the vault cannot break a commission line, and the commission lock must not
 * refuse it.
 *
 * This is the second time the same bug class has blocked a correct vault-to-vault
 * craft. checkCraftInputs was fixed on 2026-09-16 after it refused Bob Comet's
 * `assemble_platinum_control_node source="faction" deliver_to="faction"` with the
 * inputs sitting in the vault, and sent him to HALT. The sibling guard here kept
 * reading personal storage, and on 2026-09-19 it refused Morg'Thar's
 * `assemble_gold_processing_core x57 deliver_to="faction"` — 379 circuit_board in
 * the vault, 0 in his locker — against a 1,900 board line recorded for a
 * superseded industrial plan. It was blocking the craft that produces the
 * targeting_computer the live commission is 70 short of.
 *
 * The rule under test is a property of the containers, not of any one plan: if the
 * units being consumed were never reachable by the commission, spending them cannot
 * break it.
 */

const seed = getDb()
seed.query(`DELETE FROM commission_requirements`).run()
setCommissionRequirements('crimson_devastator', [
  { item_id: 'targeting_computer', quantity: 70 },
], null)
setCommissionRequirements('devastator_industry', [
  { item_id: 'circuit_board', quantity: 1900 },
], null)

/** The predicate the guard uses to decide which container a craft consumes. */
function drawsFromVault(args: Record<string, unknown> | undefined): boolean {
  const src = String(args?.source ?? args?.deliver_to ?? '').trim().toLowerCase()
  return src === 'faction' || src.startsWith('faction:')
}

describe('the commission lock and the three containers', () => {
  test('a vault-sourced craft is recognised however it was addressed', () => {
    expect(drawsFromVault({ deliver_to: 'faction' })).toBe(true)
    expect(drawsFromVault({ source: 'faction' })).toBe(true)
    expect(drawsFromVault({ deliver_to: 'faction:industry' })).toBe(true)
    expect(drawsFromVault({ source: 'faction', deliver_to: 'self' })).toBe(true)
  })

  test('a craft into the pilot’s own locker is NOT exempt — that container is the commission’s', () => {
    expect(drawsFromVault({})).toBe(false)
    expect(drawsFromVault({ deliver_to: 'self' })).toBe(false)
    expect(drawsFromVault(undefined)).toBe(false)
  })

  test('the stale requirement that caused the block is still recorded — the fix is the container, not the data', () => {
    // The guard must stay correct without anyone having to remember to prune a
    // superseded plan. 1,900 boards remains on the books and must not block a
    // vault craft regardless.
    expect(getCommissionRequirement('circuit_board')).toBe(1900)
    expect(getCommissionRequirement('targeting_computer')).toBe(70)
  })

  test('requirements recorded by two different plans both remain readable', () => {
    // devastator_industry and crimson_devastator are separate sets; neither may
    // silently erase the other, because the sell/gift guards key off the same read.
    expect(getCommissionRequirement('circuit_board')).toBeGreaterThan(0)
    expect(getCommissionRequirement('targeting_computer')).toBeGreaterThan(0)
    expect(getCommissionRequirement('nothing_on_any_list')).toBe(0)
  })
})
