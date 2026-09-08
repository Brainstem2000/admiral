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
  const topItem = args.item_id ?? args.item ?? args.id
  const orders = args.orders
  if (Array.isArray(orders)) {
    for (const o of orders) {
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>
        push(r.item_id ?? r.item ?? r.id ?? topItem, r.quantity ?? r.qty)
      }
    }
  }
  if (!out.length) push(topItem, args.quantity ?? args.qty)
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


/**
 * The gate went blind on two real call shapes, observed 2026-09-07. CyberSpock
 * placed a standing order for fury_crystal x16 at 18:29 and tried to buy another
 * 16 at 21:09; the checkpoint never fired, because:
 *   - the second call passed the item as `id=`, not `item_id=`
 *   - the first passed `orders:[{price_each, quantity}]` with NO item_id inside,
 *     inheriting it from the top-level `item_id`, which produced ZERO lines
 * A guard that cannot see the call is worse than none: it reports safe.
 */
describe('every real call shape is readable', () => {
  test('buy with id= instead of item_id=', () => {
    expect(purchaseLines({ id: 'fury_crystal', quantity: 16 }))
      .toEqual([{ id: 'fury_crystal', qty: 16 }])
  })

  test('orders[] entries inherit the top-level item_id', () => {
    expect(purchaseLines({
      item_id: 'fury_crystal',
      orders: [{ price_each: 680, quantity: 16 }],
    })).toEqual([{ id: 'fury_crystal', qty: 16 }])
  })

  test('an explicit per-order item_id still wins over the top level', () => {
    expect(purchaseLines({
      item_id: 'fury_crystal',
      orders: [{ item_id: 'circuit_board', quantity: 375 }],
    })).toEqual([{ id: 'circuit_board', qty: 375 }])
  })

  test('the real duplicate would now checkpoint', () => {
    const bought = (m: Record<string, number>) => (id: string) => m[id] ?? 0
    expect(wouldCheckpoint({ id: 'fury_crystal', quantity: 16 }, bought({ fury_crystal: 16 })))
      .toBe(true)
  })
})
