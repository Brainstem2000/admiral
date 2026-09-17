import { describe, expect, test } from 'bun:test'
import { findItemEverywhere, getEverythingTotals, getDb, applyStorageDelta, applyFactionStorageDelta } from '../src/server/lib/db'

/**
 * The fleet holds material in THREE places that feed DIFFERENT consumers, and the
 * existing fleet-wide lookups (findItemAcrossFleet, getFleetItemTotals) read only
 * two of them — personal lockers and ship holds. Faction storage was invisible to
 * the API, the dashboard and the Admiral at once.
 *
 * Measured cost, 2026-09-17: weapon_core 228 sat in grand_exchange_station while
 * the Devastator bill reported the line unsourceable and it was costed as a
 * crafting chain blocked on 440 tungsten_rod; and 3,346 steel_plate spread across
 * four vaults read as missing, which CLAUDE.md had recorded as a "wrong" number
 * when it was the right number for the wrong location.
 */
const ST = 'test_grand_exchange'

function pid(tag: string) {
  const d = getDb()
  const id = `p_inv_${tag}_${Math.random().toString(36).slice(2, 7)}`
  d.query('INSERT OR IGNORE INTO profiles (id, name) VALUES (?, ?)').run(id, 'Inv ' + id.slice(-5))
  return id
}

describe('the item lookup sees all three holders', () => {
  test('faction vault stock is found — the blind spot that hid seven vaults', () => {
    const item = `wc_${Math.random().toString(36).slice(2, 8)}`
    applyFactionStorageDelta('f_inv', ST, item, 228)

    const rows = findItemEverywhere(item)
    const vault = rows.find(r => r.holder_kind === 'vault')
    expect(vault).toBeDefined()
    expect(vault!.quantity).toBe(228)
    expect(vault!.station_id).toBe(ST)
    expect(vault!.profile_id).toBeNull()      // a vault belongs to the faction, not a pilot
  })

  test('all three holders appear for one item, each labelled', () => {
    const item = `mix_${Math.random().toString(36).slice(2, 8)}`
    const p = pid('mix')
    applyFactionStorageDelta('f_inv', ST, item, 500)
    applyStorageDelta(p, ST, item, 40, { source: 'command', ref: 'test', confidence: 'exact' })

    const kinds = new Set(findItemEverywhere(item).map(r => r.holder_kind))
    expect(kinds.has('vault')).toBe(true)
    expect(kinds.has('locker')).toBe(true)
    const total = findItemEverywhere(item).reduce((n, r) => n + r.quantity, 0)
    expect(total).toBe(540)
  })

  test('the same item in two different vaults reports as two locations, not one sum', () => {
    const item = `two_${Math.random().toString(36).slice(2, 8)}`
    applyFactionStorageDelta('f_inv', ST, item, 1296)
    applyFactionStorageDelta('f_inv', 'test_iron_reach', item, 1450)

    const vaults = findItemEverywhere(item).filter(r => r.holder_kind === 'vault')
    expect(vaults.length).toBe(2)
    // Summing across stations is the trap: 2,746 exists, but no single build can reach it.
    expect(vaults.map(v => v.quantity).sort((a, b) => b - a)).toEqual([1450, 1296])
  })

  test('the searchable index splits the total across holders rather than hiding it', () => {
    const item = `idx_${Math.random().toString(36).slice(2, 8)}`
    const p = pid('idx')
    applyFactionStorageDelta('f_inv', ST, item, 300)
    applyStorageDelta(p, ST, item, 25, { source: 'command', ref: 'test', confidence: 'exact' })

    const row = getEverythingTotals({ search: item }).find(r => r.item_id === item)
    expect(row).toBeDefined()
    expect(row!.total).toBe(325)
    expect(row!.in_vaults).toBe(300)
    expect(row!.in_lockers).toBe(25)
  })

  test('an item nobody holds returns nothing rather than a zero row', () => {
    expect(findItemEverywhere(`absent_${Math.random().toString(36).slice(2, 8)}`)).toEqual([])
  })
})
