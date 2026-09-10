/** Subprocess helper for commission-sell-lock.test.ts — isolated DB (chdir before import). */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const repoData = path.resolve(import.meta.dir, '..', '..', 'data')
for (const f of ['catalog-cache.json', 'catalog-etag.txt']) { const src = path.join(repoData, f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workspace, 'data', f)) }
const { getDb, createProfile, setCommissionRequirements, recordCargoSnapshot } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const { startCatalogService } = await import('../../src/server/lib/catalog')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
startCatalogService()
const base = { username: '', password: '', empire: 'crimson', player_id: '', provider: 'manual', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-builder', name: 'Builder', username: 'Builder' } as any)
createProfile({ ...base, id: 'p-mate', name: 'Mate', username: 'Ledger Voss' } as any)
setCommissionRequirements('juggernaut', [{ item_id: 'uranium_ore', quantity: 762 }], 'p-builder')
recordCargoSnapshot('p-builder', [{ item_id: 'uranium_ore', quantity: 160 }, { item_id: 'iron_ore', quantity: 50 }], 'ship-1')

function harness() {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => ({ location: { system_id: 'krynn', docked_at: 'crimson_war_citadel' }, ship: { hull: 100, max_hull: 100, fuel: 100, max_fuel: 130, cargo_used: 210, cargo_capacity: 450 }, player: { credits: 1000 },
      cargo: [{ item_id: 'uranium_ore', item_name: 'Uranium Ore', quantity: 160 }, { item_id: 'iron_ore', item_name: 'Iron Ore', quantity: 50 }] }),
    execute: async (cmd: string, args?: any) => {
      calls.push({ cmd, args })
      if (cmd === 'get_cargo' || cmd === 'get_ship' || cmd === 'get_status') return { result: { action: cmd, cargo: [{ item_id: 'uranium_ore', item_name: 'Uranium Ore', quantity: 160 }, { item_id: 'iron_ore', item_name: 'Iron Ore', quantity: 50 }], ship: { cargo_used: 210, cargo_capacity: 450 } } }
      if (cmd === 'view_market') return { result: { action: 'view_market', base_id: 'crimson_war_citadel', items: [{ item_id: 'uranium_ore', best_buy: 150, best_buy_qty: 1000 }, { item_id: 'iron_ore', best_buy: 5, best_buy_qty: 1000 }] } }
      if (cmd === 'sell') return { result: { action: 'sell', item_id: args?.item_id, quantity_sold: args?.quantity, total_earned: 5 * (args?.quantity ?? 0) } }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: 'p-builder', profileName: 'Builder', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}
const out: Record<string, unknown> = {}
{ const h = harness(); out.sellUranium = String(await executeTool('game', { command: 'sell', args: { item_id: 'uranium_ore', quantity: 50 } }, h.ctx)); out.sellUraniumReached = h.calls.some(c => c.cmd === 'sell') }
{ const h = harness(); await executeTool('game', { command: 'view_market', args: {} }, h.ctx); out.sellIron = String(await executeTool('game', { command: 'sell', args: { item_id: 'iron_ore', quantity: 50 } }, h.ctx)); out.sellIronReached = h.calls.some(c => c.cmd === 'sell') }
{ const h = harness(); out.orderUranium = String(await executeTool('game', { command: 'create_sell_order', args: { item_id: 'uranium_ore', quantity: 10, price_each: 500 } }, h.ctx)) }
{ const h = harness(); out.giftOutside = String(await executeTool('game', { command: 'send_gift', args: { recipient: 'Stranger Danger', item_id: 'uranium_ore', quantity: 10, source: 'cargo' } }, h.ctx)) }
{ const h = harness(); out.giftFleet = String(await executeTool('game', { command: 'send_gift', args: { recipient: 'Ledger Voss', item_id: 'uranium_ore', quantity: 10, source: 'cargo' } }, h.ctx)); out.giftFleetReached = h.calls.some(c => c.cmd === 'send_gift') }
{ const h = harness(); out.macro = String(await executeTool('sell_cargo', { exclude: [] }, h.ctx)); out.macroSold = h.calls.filter(c => c.cmd === 'sell').map(c => c.args?.item_id) }
console.log('__RESULT__' + JSON.stringify(out))
