/**
 * Subprocess helper: run sell_cargo with the database NEVER opened.
 *
 * db.ts binds its handle lazily, so a process that imports tools.ts without
 * calling getDb() has a null connection — which is what the commission lock
 * hits. This reproduces, exactly, the shape of the failure that made the macro
 * abort with nothing sold. It has to be its own process because any other test
 * in the same process may already have opened the handle.
 *
 * argv[2] is a throwaway data dir, so nothing here can reach data/admiral.db.
 */
;(globalThis as { __ADMIRAL_DATA_DIR?: string }).__ADMIRAL_DATA_DIR = process.argv[2]

// NOTE: tools.ts only — importing db.ts's getDb() here would defeat the point.
const { executeTool } = await import('../../src/server/lib/tools')

const cargo = [{ item_id: 'titanium_ore', quantity: 10 }]
const sold: string[] = []
const conn = {
  mode: 'http_v2',
  isConnected: () => true,
  supportsNotifications: () => false,
  getLocalState: () => null,
  onNotification: () => {},
  execute: async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_ship') return { result: { modules: [{ name: 'Shield Emitter' }] } }
    if (command === 'get_status') {
      return { result: {
        player: { credits: 83000 },
        ship: { cargo_used: cargo.length, cargo_capacity: 120 },
        location: { docked_at: 'blood_forge_smelting_works' },
        cargo,
      } }
    }
    if (command === 'view_market') return { result: { items: [{ item_id: 'titanium_ore', best_buy: 40, best_buy_qty: 500 }] } }
    if (command === 'sell') { sold.push(String(args?.item_id ?? args?.id)); return { result: 'sold' } }
    return { result: 'ok' }
  },
} as any
const ctx = { connection: conn, profileId: 'p-no-db', profileName: 'Test', log: () => {}, todo: '', memory: '' } as any

const out = await executeTool('sell_cargo', { exclude: [] }, ctx)
console.log('__RESULT__' + JSON.stringify({ out, sold }))
