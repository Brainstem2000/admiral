import { describe, expect, test } from 'bun:test'
import { applyFactionStorageDelta, getFactionStorageQuantity, recordFactionStorageSnapshot } from '../src/server/lib/db'
import { captureFactionFromCommand } from '../src/server/lib/faction-ledger'

const FAC = 'fac_test_vault'
const ST = 'test_war_citadel'

/**
 * The vault inventory used to move ONLY on view_faction_storage, so every deposit between
 * views left it under-reporting. The craft pre-flight guard reads that table, so it refused
 * crafts that would have succeeded and agents reported themselves blocked on material they
 * were standing on (2026-09-16: table said 154 copper_wiring, the vault held 1,080).
 */
describe('faction vault inventory moves with the ledger, not only with snapshots', () => {
  test('a deposit credits the vault; a withdrawal debits it', () => {
    const item = `widget_${Math.random().toString(36).slice(2, 8)}`
    expect(getFactionStorageQuantity(item, ST)).toBe(0)

    applyFactionStorageDelta(FAC, ST, item, 600)
    expect(getFactionStorageQuantity(item, ST)).toBe(600)

    applyFactionStorageDelta(FAC, ST, item, 145)
    expect(getFactionStorageQuantity(item, ST)).toBe(745)

    applyFactionStorageDelta(FAC, ST, item, -400)
    expect(getFactionStorageQuantity(item, ST)).toBe(345)
  })

  test('quantity never goes negative — a drifted cache waits for the next snapshot', () => {
    const item = `drift_${Math.random().toString(36).slice(2, 8)}`
    applyFactionStorageDelta(FAC, ST, item, -500)     // we never saw the stock this removes
    expect(getFactionStorageQuantity(item, ST)).toBe(0)

    applyFactionStorageDelta(FAC, ST, item, 50)
    applyFactionStorageDelta(FAC, ST, item, -80)
    expect(getFactionStorageQuantity(item, ST)).toBe(0)
  })

  test('a snapshot still replaces wholesale, and deltas resume from it', () => {
    const item = `snap_${Math.random().toString(36).slice(2, 8)}`
    applyFactionStorageDelta(FAC, ST, item, 10)
    recordFactionStorageSnapshot(FAC, ST, [{ item_id: item, item_name: '', quantity: 1200 }], 'tester')
    expect(getFactionStorageQuantity(item, ST)).toBe(1200)

    applyFactionStorageDelta(FAC, ST, item, -250)
    expect(getFactionStorageQuantity(item, ST)).toBe(950)
  })

  test('a deposit command result credits the vault end to end', () => {
    const item = `cmd_${Math.random().toString(36).slice(2, 8)}`
    const args = { item_id: item, quantity: 600, target: 'faction', source: 'storage' }
    // Carries faction_id so the ledger can attribute it without prior state.
    const result = { action: 'faction_deposit_items', faction_id: FAC, base_id: ST, item_id: item, quantity: 600, tick: 111 }

    captureFactionFromCommand('deposit', args, result, 'p_vault_test', 'Tester', { station: ST })
    expect(getFactionStorageQuantity(item, ST)).toBe(600)
  })

  test('a replayed result does NOT double-count — the ledger dedupe_key is the token', () => {
    const item = `dupe_${Math.random().toString(36).slice(2, 8)}`
    const args = { item_id: item, quantity: 250, target: 'faction', source: 'storage' }
    const result = { action: 'faction_deposit_items', faction_id: FAC, base_id: ST, item_id: item, quantity: 250, tick: 222 }

    captureFactionFromCommand('deposit', args, result, 'p_vault_test', 'Tester', { station: ST })
    captureFactionFromCommand('deposit', args, result, 'p_vault_test', 'Tester', { station: ST })
    captureFactionFromCommand('deposit', args, result, 'p_vault_test', 'Tester', { station: ST })

    expect(getFactionStorageQuantity(item, ST)).toBe(250)
  })

  test('the vault is PER STATION — a deposit at one station does not appear at another', () => {
    const item = `perstation_${Math.random().toString(36).slice(2, 8)}`
    applyFactionStorageDelta(FAC, ST, item, 300)
    applyFactionStorageDelta(FAC, 'test_iron_reach', item, 40)

    expect(getFactionStorageQuantity(item, ST)).toBe(300)
    expect(getFactionStorageQuantity(item, 'test_iron_reach')).toBe(40)
    expect(getFactionStorageQuantity(item)).toBe(340)          // fleet-wide sum, the trap
  })

  test('an errored result moves nothing', () => {
    const item = `err_${Math.random().toString(36).slice(2, 8)}`
    captureFactionFromCommand('deposit',
      { item_id: item, quantity: 999, target: 'faction', source: 'storage' },
      { error: 'insufficient_storage', faction_id: FAC, base_id: ST },
      'p_vault_test', 'Tester', { station: ST })
    expect(getFactionStorageQuantity(item, ST)).toBe(0)
  })
})

/**
 * The first version of this fix silently did nothing after a server restart. factionByProfile is
 * in-memory, a plain deposit{target:"faction"} result does not repeat faction_id, and the vault
 * delta was keyed on it — so every lockbox movement in the window after a restart was journaled
 * unattributed and moved no stock. Observed live 2026-09-16 22:02 CT.
 */
describe('faction id survives a restart', () => {
  test('a deposit whose result carries no faction_id still moves the vault', () => {
    const seed = `seed_${Math.random().toString(36).slice(2, 8)}`
    // Something on disk already knows the faction — as it does in any real deployment.
    recordFactionStorageSnapshot(FAC, ST, [{ item_id: seed, item_name: '', quantity: 1 }], 'tester')

    const item = `restart_${Math.random().toString(36).slice(2, 8)}`
    const result = { action: 'faction_deposit_items', base_id: ST, item_id: item, quantity: 22, tick: 333 }
    //                         ^ no faction_id, exactly what the game returns for a bare deposit
    captureFactionFromCommand('deposit',
      { item_id: item, quantity: 22, target: 'faction', source: 'storage' },
      result, `p_cold_${Math.random().toString(36).slice(2, 6)}`, 'ColdStart', { station: ST })

    expect(getFactionStorageQuantity(item, ST)).toBe(22)
  })
})
