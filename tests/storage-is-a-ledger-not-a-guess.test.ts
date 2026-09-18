import { describe, expect, test } from 'bun:test'
import { getDb, normStationId } from '../src/server/lib/db'

/**
 * Brian, 2026-09-18: "in theory, if storage inventory was tracked properly and accounted for
 * the data would never be stale." He is right — every storage mutation passes through a command
 * WE issue, so the table should be exact rather than eventually-consistent. It was not, for two
 * independent reasons, and between them they sent four agents to sweep lockers the table swore
 * held 76 circuit_board. Every one read empty.
 *
 * BUG 1 — whose storage. `deposit_items target="faction"` moves cargo into the FACTION VAULT,
 * but the recorder booked +qty into the agent's PERSONAL storage. Nova's 173 silicon, Juno's
 * 400 titanium and Ledger's 116 silicon were all faction deposits showing as personal stock.
 * The mirror: `withdraw_items source="faction"` lands in the pilot's LOCKER, so personal
 * storage should rise, and the code always subtracted.
 *
 * BUG 2 — one station, two keys. The table is keyed (profile_id, station_id, item_id), so
 * "Crimson War Citadel" and "crimson_war_citadel" are different rows for one place. A live read
 * on the canonical id could not see the 42 circuit_board filed under the display name.
 */
const TOOLS = await Bun.file('src/server/lib/tools.ts').text()
const DB = await Bun.file('src/server/lib/db.ts').text()

describe('a deposit to the faction vault is not a personal gain', () => {
  test('deposit_items checks the target before crediting personal storage', () => {
    const seg = TOOLS.slice(TOOLS.indexOf("case 'deposit_items'"), TOOLS.indexOf("case 'bulk_transfer'"))
    expect(seg).toContain('if (depositIsFaction) break')
    // the regression: an unconditional positive delta
    expect(seg).not.toMatch(/case 'deposit_items':\s*\{ const l = line\(r\); apply\(profileId, docked, l\.id, \+l\.qty/)
  })

  test('a faction WITHDRAW credits the locker rather than debiting it', () => {
    const seg = TOOLS.slice(TOOLS.indexOf("case 'withdraw_items'"), TOOLS.indexOf("case 'bulk_transfer'"))
    expect(seg).toContain('withdrawIsFaction ? +l.qty : -l.qty')
  })

  test('the bulk forms honour it too', () => {
    const seg = TOOLS.slice(TOOLS.indexOf("case 'bulk_deposit'"), TOOLS.indexOf("case 'bulk_transfer'"))
    expect(seg).toContain("action === 'bulk_deposit' && depositIsFaction")
    expect(seg).toContain('withdrawIsFaction ? +1 : -1')
  })

  test('target is read from the result AND the args', () => {
    // lib_v2 echoes `target`; the v1 form only has it in commandArgs.
    expect(TOOLS).toContain("strField(r.target) || strField(commandArgs?.target)")
    expect(TOOLS).toContain("strField(r.source) || strField(commandArgs?.source)")
  })
})

describe('one station means one key', () => {
  test('display names fold onto the canonical id', () => {
    expect(normStationId('Crimson War Citadel')).toBe('crimson_war_citadel')
    expect(normStationId('crimson_war_citadel')).toBe('crimson_war_citadel')
    expect(normStationId('  The Anvil  Arsenal ')).toBe('the_anvil_arsenal')
  })

  test('a hex station id survives unchanged', () => {
    expect(normStationId('b495c6003fc83e18f6d8cecbe6929133')).toBe('b495c6003fc83e18f6d8cecbe6929133')
  })

  test('empty and null stay null — an unplaced row must not key on ""', () => {
    expect(normStationId('')).toBeNull()
    expect(normStationId(null)).toBeNull()
    expect(normStationId(undefined)).toBeNull()
  })

  test('applyStorageDelta normalises before keying', () => {
    expect(DB).toContain('const stationId = normStationId(stationIdRaw)')
  })

  test('the migration folds existing split rows and purges unverified ones', () => {
    const m = DB.slice(DB.indexOf('version: 13'), DB.indexOf('function runVersionedMigrations'))
    expect(m).toContain('storage key folded')
    expect(m).toContain('observed_at IS NULL')
  })

  test('the live table has no duplicate station spellings left', () => {
    const rows = getDb().query(`
      SELECT station_id FROM storage_inventory WHERE station_id IS NOT NULL
        AND station_id <> lower(replace(station_id,' ','_'))`).all() as unknown[]
    expect(rows.length).toBe(0)
  })
})
