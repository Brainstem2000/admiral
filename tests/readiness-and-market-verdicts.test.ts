import { describe, expect, test } from 'bun:test'
import {
  buildMarketPurchaseVerdict,
  fullWeaponReloadVerdict,
} from '../src/server/lib/tools'

describe('market purchase verdicts', () => {
  test('a bid with no asks is identified as not purchasable', () => {
    const verdict = buildMarketPurchaseVerdict({
      base_id: 'frontier_station',
      items: [{
        item_id: 'ferrous_slug_case',
        best_buy: 2,
        best_buy_qty: 101,
        best_sell: 0,
        best_sell_qty: 0,
        buy_orders: [{ price_each: 2, quantity: 101 }],
        sell_orders: [],
      }],
    }, { item_id: 'ferrous_slug_case' })

    expect(verdict?.unavailable).toBe(true)
    expect(verdict?.message).toContain('BID ONLY')
    expect(verdict?.message).toContain('will PAY YOU 2cr')
    expect(verdict?.message).toContain('You cannot buy here')
  })

  test('an empty station book is an explicit sourcing blocker', () => {
    const verdict = buildMarketPurchaseVerdict({
      base_id: 'deep_range_outpost',
      items: [],
    }, { item_id: 'ferrous_slug_case' })

    expect(verdict?.unavailable).toBe(true)
    expect(verdict?.message).toContain('NOT FOR SALE')
    expect(verdict?.message).toContain('continue the higher-level objective')
  })

  test('a real ask reports purchase price and depth', () => {
    const verdict = buildMarketPurchaseVerdict({
      base_id: 'trade_hub',
      items: [{
        item_id: 'ferrous_slug_case',
        best_sell: 7,
        best_sell_qty: 12,
        sell_orders: [{ price_each: 7, quantity: 12 }],
      }],
    }, { item_id: 'ferrous_slug_case' })

    expect(verdict?.unavailable).toBe(false)
    expect(verdict?.message).toContain('AVAILABLE')
    expect(verdict?.message).toContain('ASK 7cr')
    expect(verdict?.message).toContain('sell depth 12')
  })
})

describe('reload readiness verdict', () => {
  const ship = {
    modules: [
      { module_id: 'full', name: 'Mass Driver', current_ammo: 10, magazine_size: 10 },
      { module_id: 'effective', name: 'Fury Cannon', current_ammo: 999, magazine_size: 1000 },
      { module_id: 'low', name: 'Railgun II', current_ammo: 3, magazine_size: 7 },
    ],
  }

  test('turns a full reload into a no-op', () => {
    const verdict = fullWeaponReloadVerdict(ship, { weapon_instance_id: 'full' })
    expect(verdict).toContain('NO-OP')
    expect(verdict).toContain('10/10')
    expect(verdict).toContain('no cargo ammo was consumed')
  })

  test('treats a single missing round as combat-ready', () => {
    expect(fullWeaponReloadVerdict(ship, { id: 'effective' })).toContain('999/1000')
  })

  test('allows a genuinely low weapon to reload', () => {
    expect(fullWeaponReloadVerdict(ship, { weapon_instance_id: 'low' })).toBeNull()
  })
})
