import { describe, expect, test } from 'bun:test'

/**
 * Ammo must survive a bulk sell.
 *
 * `sell_cargo(exclude=[])` means "sell everything sellable", and ammunition is
 * sellable. On 2026-09-01 Morg'Thar bought 120 standard_rounds_box at 12cr to
 * re-arm for a multi-day hunt, then twenty minutes later ran sell_cargo twice
 * and dumped 30 of them at ~7.7cr — a ~130cr LOSS — immediately before
 * departing to hunt, leaving no reload supply aboard.
 *
 * The BoM lock did not catch it (SELL_CARGO_ALWAYS_EXCLUDE has been empty
 * since the Devastator commission closed) and the jettison gate does not cover
 * selling. The protected set is derived from the ship's own fitted weapons, so
 * it stays correct for any agent, hull or ammo type.
 */

function shipWithAmmo(ammoId: string) {
  return {
    modules: [
      { name: 'Autocannon', ammo_type: 'autocannon', loaded_ammo_id: ammoId, current_ammo: 1000 },
      { name: 'Shield Emitter' },
    ],
  }
}

/** Docked, with the given cargo aboard. */
function statusWith(cargo: Array<{ item_id: string; quantity: number }>) {
  return {
    player: { credits: 83000 },
    ship: { cargo_used: cargo.length, cargo_capacity: 120 },
    location: { docked_at: 'blood_forge_smelting_works' },
    cargo,
  }
}

function stubConnection(cargo: Array<{ item_id: string; quantity: number }>, sold: string[]) {
  return {
    mode: 'http_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    getLocalState: () => null,
    onNotification: () => {},
    execute: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_ship') return { result: shipWithAmmo('standard_rounds_box') }
      if (command === 'get_status') return { result: statusWith(cargo) }
      if (command === 'view_market') {
        return { result: { items: [
          { item_id: 'standard_rounds_box', best_buy: 8, best_buy_qty: 500 },
          { item_id: 'titanium_ore', best_buy: 40, best_buy_qty: 500 },
        ] } }
      }
      if (command === 'sell') {
        sold.push(String(args?.item_id ?? args?.id))
        return { result: 'sold' }
      }
      return { result: 'ok' }
    },
  } as any
}

function ctxFor(connection: any) {
  return {
    connection,
    profileId: `p-ammo-${Math.random()}`,
    profileName: 'Test',
    log: () => {},
    todo: '',
    memory: '',
  } as any
}

describe('sell_cargo ammo protection', () => {
  test('ammo the ship fires is never bulk-sold, even with exclude=[]', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const sold: string[] = []
    const cargo = [
      { item_id: 'standard_rounds_box', quantity: 120 },
      { item_id: 'titanium_ore', quantity: 10 },
    ]

    const out = await executeTool('sell_cargo', { exclude: [] }, ctxFor(stubConnection(cargo, sold)))

    // The exact call that cost the reload supply.
    expect(sold).not.toContain('standard_rounds_box')
    // Loot still sells — the guard must not turn sell_cargo into a no-op.
    expect(sold).toContain('titanium_ore')
    // And the agent is told why, so it does not simply retry.
    expect(out).toContain('Ammo protected')
    expect(out).toContain('standard_rounds_box')
  }, 30_000)

  test('non-ammo cargo is unaffected when no weapons are fitted', async () => {
    const { executeTool } = await import('../src/server/lib/tools')
    const sold: string[] = []
    const cargo = [{ item_id: 'titanium_ore', quantity: 10 }]

    const conn = stubConnection(cargo, sold)
    conn.execute = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_ship') return { result: { modules: [{ name: 'Shield Emitter' }] } }
      if (command === 'get_status') return { result: statusWith(cargo) }
      if (command === 'view_market') return { result: { items: [{ item_id: 'titanium_ore', best_buy: 40, best_buy_qty: 500 }] } }
      if (command === 'sell') { sold.push(String(args?.item_id ?? args?.id)); return { result: 'sold' } }
      return { result: 'ok' }
    }

    await executeTool('sell_cargo', { exclude: [] }, ctxFor(conn))
    expect(sold).toContain('titanium_ore')
  }, 30_000)
})
