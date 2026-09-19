import { describe, expect, test } from 'bun:test'

/**
 * The fuel-cell price cap is meant to stop a lowball ask, not to make cells
 * unbuyable. Base value is what the fuel guide says a cell is WORTH against a
 * station tank; it is not a trading price.
 *
 * Measured live 2026-09-19 from /api/market: `fuel_cell` asks **400cr in five of
 * six empires** (crimson, nebula, outerrim, solarian, voidborn) at depths of
 * 3,876 to 12,947. Only the pirate board is higher, at 2,803. So 400 is simply
 * the price, and a cap of 5x base (215) refuses every purchase in the galaxy.
 *
 * It did exactly that: Grit Vane, staging a rescue for a pilot stranded 27 jumps
 * out, was refused 8 cells at our own dock at the only price on offer. The guard
 * also fires only when a fresh view_market exists — so it blocked the agent who
 * checked the board and allowed Bob Comet, who bought the same 8 cells at the
 * same 400cr an hour earlier without looking. A guard that punishes gathering
 * information is worse than no guard.
 *
 * The real bound on exposure is the QUANTITY cap of 8 cells (~3,200cr), which is
 * untouched. This cap only has to catch asks that are absurd against that.
 */

const FUEL_CELL_BASE: Record<string, number> = { fuel_cell: 43, premium_fuel_cell: 120, military_fuel_cell: 390 }
const FUEL_CELL_PRICE_CAP_X = 12

const blocked = (itemId: string, ask: number) =>
  FUEL_CELL_BASE[itemId] !== undefined && ask > FUEL_CELL_PRICE_CAP_X * FUEL_CELL_BASE[itemId]

describe('fuel cell price cap', () => {
  test('allows the price that actually exists in five of six empires', () => {
    expect(blocked('fuel_cell', 400)).toBe(false)
  })

  test('still blocks both incidents it was written for', () => {
    // Nova Reyes, Hex Star, 2026-09-10: 8 cells at 3,000 = 24,000cr.
    expect(blocked('fuel_cell', 3000)).toBe(true)
    // The pirate board, measured 2026-09-19.
    expect(blocked('fuel_cell', 2803)).toBe(true)
  })

  test('the old 5x cap would have refused the real market price', () => {
    // Regression marker: this is the bug, written down.
    expect(400 > 5 * FUEL_CELL_BASE.fuel_cell!).toBe(true)
    expect(400 > FUEL_CELL_PRICE_CAP_X * FUEL_CELL_BASE.fuel_cell!).toBe(false)
  })

  test('the other two cell grades keep a sane band', () => {
    expect(blocked('premium_fuel_cell', 1000)).toBe(false)   // 120 base -> cap 1,440
    expect(blocked('premium_fuel_cell', 5000)).toBe(true)
    expect(blocked('military_fuel_cell', 2000)).toBe(false)  // 390 base -> cap 4,680
    expect(blocked('military_fuel_cell', 9000)).toBe(true)
  })

  test('items with no base value are not governed by this cap at all', () => {
    expect(blocked('titanium_ore', 999999)).toBe(false)
  })
})
