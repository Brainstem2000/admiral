/**
 * 424 ledger rows read as "unattributed" while the answer sat in the same row.
 *
 * The universal residual catch books any wallet movement the explicit rows did
 * not explain, so nothing vanishes — that part is right. But it stamped every
 * such row `unattributed` even though `source_command` already recorded the
 * action it was seen during. Most were ordinary fuel, sales tax and mission
 * fees showing up in the Admiral's transaction log as mysteries.
 *
 * The trap in fixing it: the action a residual is observed DURING is not always
 * its cause. In the real data one row stamped `refuel` carried +2,019,719 while
 * its own payload read {"action":"refuel","cost":48} — a 48-credit top-up that
 * coincided with a commission refund landing. Mapping refuel -> fuel blindly
 * would have booked two million credits of refunds as fuel spend. The split is
 * stark: 134 refuel residuals at or under 2,000cr net -42,013 and are real fuel;
 * 15 above it net +2,029,725 and are not.
 *
 * So a residual is only given its action's kind when the amount is consistent
 * with what that action declared about itself. Otherwise it is `coincident`,
 * which is a smaller claim and a true one.
 */
import { test, expect, describe } from 'bun:test'
import { classifyResidual, plausibleBound, readDeclared } from '../src/server/lib/ledger-attribution'

describe('an ordinary charge is attributed to its action', () => {
  test('a 90cr fuel top-up is fuel', () => {
    expect(classifyResidual('refuel', -90, { action: 'refuel', cost: 90 })).toBe('fuel')
  })

  test('a small negative on a sale is the sales tax', () => {
    expect(classifyResidual('sell', -174, { action: 'sell', total_earned: 1750 })).toBe('sales_tax')
  })

  test('a mission bond on accept is named as one', () => {
    expect(classifyResidual('accept_mission', -135, { mission_id: 'x' })).toBe('mission_bond')
  })

  test('prefixed command names normalise before lookup', () => {
    expect(classifyResidual('spacemolt_market_sell', -100, {})).toBe('sales_tax')
  })

  test('a charge with nothing declared is still attributed if it is small', () => {
    // The floor exists so ordinary fees do not fall through for want of a field.
    expect(classifyResidual('craft', -320, {})).toBe('craft_fee')
  })
})

describe('a movement that merely overlapped the action is not attributed to it', () => {
  test('the real 2,019,719 refuel row is NOT booked as fuel', () => {
    const kind = classifyResidual('refuel', 2_019_719, { action: 'refuel', cost: 48, market_cost: 32 })
    expect(kind).not.toBe('fuel')
    expect(kind).toBe('coincident')
  })

  test("Ledger's +159,126 during a 1,750cr sale is not sales tax", () => {
    expect(classifyResidual('sell', 159_126, { action: 'sell', total_earned: 1750 })).toBe('coincident')
  })

  test('a residual seen during a read-only command is never given a kind', () => {
    // `view` moved -1,305,121 in the real data. A query cannot have caused it.
    expect(classifyResidual('view', -1_305_121, {})).toBe('coincident')
  })

  test('an unknown verb is coincident, not invented', () => {
    expect(classifyResidual('some_new_command', -500, {})).toBe('coincident')
  })

  test('with no command at all it stays unattributed, which is honest', () => {
    expect(classifyResidual(null, -500, {})).toBe('unattributed')
    expect(classifyResidual('', -500, {})).toBe('unattributed')
  })
})

describe('the consistency bound', () => {
  test('scales with the declared amount so large honest trades still attribute', () => {
    // A 100,000cr purchase may carry a 4,000cr tax; that is consistent.
    expect(classifyResidual('buy', -4_000, { total_cost: 100_000 })).toBe('purchase_tax')
  })

  test('but not without limit', () => {
    expect(classifyResidual('buy', -900_000, { total_cost: 100_000 })).toBe('coincident')
  })

  test('reads the first declared figure it recognises', () => {
    expect(readDeclared({ cost: 48, total_earned: 9999 })).toBe(48)
    expect(readDeclared({ total_earned: 1750 })).toBe(1750)
    expect(readDeclared({})).toBeNull()
    expect(readDeclared(null)).toBeNull()
  })

  test('a zero declared figure is ignored rather than pinning the bound to zero', () => {
    expect(readDeclared({ cost: 0, total_earned: 500 })).toBe(500)
    expect(plausibleBound(null)).toBe(5000)
  })
})

/**
 * A BULK order declares its amounts inside `results[]` and carries no top-level
 * cost field. Reading only the top level returned null, plausibleBound floored at
 * 5,000, and every real bulk order exceeds that — so CyberSpock's on-plan
 * titanium_alloy x120 @2,500 was stamped `coincident` and lost its attribution,
 * surfacing in the dashboard as an unexplained -305,733.
 *
 * The guard that must survive the fix: a payload that DOES declare its own figure
 * is answering for itself. CyberSapper sold one Refueling Pump for 1,100 with a
 * 68,523 residual alongside it — that is genuinely a different event, and a
 * nested array must never talk over the top-level `total_earned`.
 */
describe('bulk order envelopes', () => {
  const BULK = {
    action: 'create_buy_order', mode: 'bulk', kind: 'bulk',
    results: [{
      index: 0, success: true, item: 'Titanium Alloy', item_id: 'titanium_alloy',
      quantity: 120, price_each: 2500,
      fills: [{ price_each: 2500, quantity: 120 }],
    }],
  }

  test('reads quantity x price_each out of results[]', () => {
    expect(readDeclared(BULK)).toBe(300_000)
  })

  test('the real purchase is attributed, not stamped coincident', () => {
    expect(classifyResidual('create_buy_order', -305_733, BULK)).toBe('order_create')
  })

  test('sums across multiple results', () => {
    expect(readDeclared({
      action: 'create_buy_order',
      results: [{ quantity: 10, price_each: 100 }, { quantity: 4, price_each: 250 }],
    })).toBe(2_000)
  })

  test('a per-result cost field wins over quantity x price', () => {
    expect(readDeclared({ action: 'create_buy_order', results: [{ total_cost: 7_777, quantity: 2, price_each: 1 }] }))
      .toBe(7_777)
  })

  test('a declared top-level figure still wins — the Refueling Pump case', () => {
    const sale = {
      action: 'sell', item_id: 'refueling_pump', quantity_sold: 1, total_earned: 1100,
      fills: [{ price_each: 1100, quantity: 1 }],
    }
    expect(readDeclared(sale)).toBe(1100)
    expect(classifyResidual('sell', -68_523, sale)).toBe('coincident')
  })

  test('an empty or absent results[] changes nothing', () => {
    expect(readDeclared({ action: 'create_buy_order', results: [] })).toBeNull()
    expect(readDeclared({ action: 'refuel', cost: 810 })).toBe(810)
    expect(classifyResidual('refuel', -29_292, { action: 'refuel', cost: 810 })).toBe('coincident')
  })
})
