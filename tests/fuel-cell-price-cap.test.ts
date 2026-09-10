import { describe, expect, test } from 'bun:test'
import { executeTool } from '../src/server/lib/tools'
import { getDb } from '../src/server/lib/db'
import { startCatalogService } from '../src/server/lib/catalog'

getDb()
startCatalogService()

/**
 * Nova Reyes bought eight fuel_cell at 3,000cr each at Hex Star on 2026-09-10
 * (base value 43) — 24,000cr for 160 fuel that a station tank sells for ~500.
 * The fuel-cell gate capped the QUANTITY at 8 and never looked at the price.
 * A buy is now refused when the docked station's last view_market shows the
 * cell ask above 5x its base value; a sane ask still goes through.
 */

function harness(ask: number) {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'krynn', docked_at: 'crimson_war_citadel' },
      ship: { hull: 100, max_hull: 100, fuel: 100, max_fuel: 130 },
      player: { credits: 100_000 },
    }),
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      if (cmd === 'view_market') {
        return { result: { action: 'view_market', base_id: 'crimson_war_citadel',
          items: [{ item_id: 'fuel_cell', best_sell: ask, best_sell_qty: 6466, best_buy: 2, best_buy_qty: 1 }] } }
      }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: `p-cellcap-${Math.random()}`, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}

describe('fuel-cell price cap', () => {
  test('a 3,000cr fuel_cell ask is refused before the buy reaches the game', async () => {
    const { ctx, calls } = harness(3000)
    await executeTool('game', { command: 'view_market', args: { item_id: 'fuel_cell' } }, ctx)
    const out = await executeTool('game', { command: 'buy', args: { item_id: 'fuel_cell', quantity: 2 } }, ctx)
    expect(out).toContain('BLOCKED')
    expect(out).toContain('lowball')
    expect(out).toContain('base value 43')
    expect(calls.some(c => c.cmd === 'buy')).toBe(false)
  })

  test('a 45cr ask passes the cap (the quantity reserve still applies)', async () => {
    const { ctx, calls } = harness(45)
    await executeTool('game', { command: 'view_market', args: { item_id: 'fuel_cell' } }, ctx)
    const out = await executeTool('game', { command: 'buy', args: { item_id: 'fuel_cell', quantity: 2 } }, ctx)
    expect(out).not.toContain('lowball')
    expect(calls.some(c => c.cmd === 'buy')).toBe(true)
  })
})
