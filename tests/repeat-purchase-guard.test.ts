import { test, expect, describe } from 'bun:test'

/**
 * A shopping list in a directive is a SNAPSHOT. It does not shrink as the agent
 * fills it, and an agent that has already bought a line cannot tell from the list.
 *
 * 2026-09-06: CyberSpock bought titanium_alloy x120 at 17:40 for 305,733,
 * deposited it in station storage at the Blood Forge yard, then bought another 120
 * at 20:02 for 304,716. His own reasoning at 19:58 read "Already have 120, need 0"
 * — then fury_crystal, circuit_board and weapon_housing all came back unavailable
 * and he fell back to the one line he COULD execute. titanium_alloy bids 300
 * against the 2,500 paid, so 88% of it is unrecoverable.
 *
 * Prose could not have stopped this: he already knew the fact and acted against
 * it. These tests pin the arithmetic and, just as importantly, the exemptions —
 * a guard that blocks a genuine ammo restock is the guard causing the outage.
 */

const RESTOCKABLE = /(?:fuel_cell|rounds_box|missile|torpedo|repair_kit|shield_cell|ammo|charge_pack|medkit)/i

function purchaseLines(args: Record<string, unknown> | undefined): Array<{ id: string; qty: number }> {
  if (!args) return []
  const out: Array<{ id: string; qty: number }> = []
  const push = (id: unknown, qty: unknown) => {
    const i = typeof id === 'string' ? id : ''
    const q = typeof qty === 'number' ? qty : Number(qty)
    if (i && Number.isFinite(q) && q > 0) out.push({ id: i, qty: q })
  }
  const orders = args.orders
  if (Array.isArray(orders)) {
    for (const o of orders) {
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>
        push(r.item_id ?? r.item, r.quantity ?? r.qty)
      }
    }
  }
  if (!out.length) push(args.item_id ?? args.item, args.quantity ?? args.qty)
  return out
}

/** Mirrors the guard's decision, given what the ledger says was already bought. */
function wouldCheckpoint(args: Record<string, unknown>, alreadyBought: (id: string) => number): boolean {
  for (const line of purchaseLines(args)) {
    if (RESTOCKABLE.test(line.id) || line.qty < 10) continue
    if (alreadyBought(line.id) >= line.qty) return true
  }
  return false
}

describe('purchase line extraction', () => {
  test('reads a direct buy', () => {
    expect(purchaseLines({ item_id: 'titanium_alloy', quantity: 120 }))
      .toEqual([{ id: 'titanium_alloy', qty: 120 }])
  })

  test('reads a BULK order out of orders[] — the shape that caused this', () => {
    expect(purchaseLines({
      item_id: 'titanium_alloy',
      orders: [{ item_id: 'titanium_alloy', price_each: 2500, quantity: 120 }],
    })).toEqual([{ id: 'titanium_alloy', qty: 120 }])
  })

  test('reads every line of a multi-item bulk order', () => {
    expect(purchaseLines({
      orders: [
        { item_id: 'circuit_board', quantity: 132 },
        { item_id: 'weapon_housing', quantity: 68 },
      ],
    })).toEqual([{ id: 'circuit_board', qty: 132 }, { id: 'weapon_housing', qty: 68 }])
  })

  test('ignores malformed and zero-quantity lines', () => {
    expect(purchaseLines({ orders: [null, { item_id: 'x', quantity: 0 }, 'nope'] })).toEqual([])
    expect(purchaseLines(undefined)).toEqual([])
  })
})

describe('the checkpoint decision', () => {
  const bought = (m: Record<string, number>) => (id: string) => m[id] ?? 0

  test('the real case: 120 already bought, 120 more requested', () => {
    expect(wouldCheckpoint(
      { orders: [{ item_id: 'titanium_alloy', quantity: 120 }] },
      bought({ titanium_alloy: 120 }),
    )).toBe(true)
  })

  test('a FIRST purchase is never blocked', () => {
    expect(wouldCheckpoint(
      { item_id: 'titanium_alloy', quantity: 120 }, bought({}),
    )).toBe(false)
  })

  test('topping up a partial fill is not a repeat', () => {
    // bought 40 of a 120 line, asking for the remaining 80 — must go through
    expect(wouldCheckpoint(
      { item_id: 'circuit_board', quantity: 80 }, bought({ circuit_board: 40 }),
    )).toBe(false)
  })

  test('consumables are exempt — the guard must not strand a restock', () => {
    for (const id of ['standard_rounds_box', 'fuel_cell', 'repair_kit', 'shield_cell']) {
      expect(wouldCheckpoint({ item_id: id, quantity: 200 }, bought({ [id]: 500 }))).toBe(false)
    }
  })

  test('small quantities are exempt', () => {
    expect(wouldCheckpoint({ item_id: 'engine_core', quantity: 4 }, bought({ engine_core: 9 })))
      .toBe(false)
  })

  test('one repeated line in a multi-item order is enough to checkpoint', () => {
    expect(wouldCheckpoint(
      { orders: [{ item_id: 'fury_crystal', quantity: 216 }, { item_id: 'titanium_alloy', quantity: 120 }] },
      bought({ titanium_alloy: 120 }),
    )).toBe(true)
  })
})
