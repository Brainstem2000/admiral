/** Subprocess helper for craft-lock-feeds-commission.test.ts — isolated DB (chdir before import). */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const repoData = path.resolve(import.meta.dir, '..', '..', 'data')
for (const f of ['catalog-cache.json', 'catalog-etag.txt']) { const src = path.join(repoData, f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workspace, 'data', f)) }
const { getDb, createProfile, setCommissionRequirements, recordStorageSnapshot, clearStorageDirty } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const { startCatalogService } = await import('../../src/server/lib/catalog')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
startCatalogService()
const base = { username: '', password: '', empire: 'crimson', player_id: '', provider: 'manual', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-builder', name: 'Builder', username: 'Builder' } as any)
const STATION = 'blood_forge_smelting_works'
// Blood Forge stock as CyberSpock held it on 2026-09-10 18:40: the argon is one unit above the
// recorded line, so consuming any of it "breaks" the purified_argon line — but the recipe's
// OUTPUT (power_cell) is itself a recorded line the build is still short of.
recordStorageSnapshot('p-builder', STATION, [
  { item_id: 'purified_argon', quantity: 684 }, { item_id: 'circuit_board', quantity: 573 }, { item_id: 'copper_wiring', quantity: 751 },
  { item_id: 'uranium_ore', quantity: 488 },
])
clearStorageDirty('p-builder')

function harness() {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => ({ location: { system_id: 'blood_forge', docked_at: STATION }, ship: { hull: 100, max_hull: 100, fuel: 100, max_fuel: 130, cargo_used: 0, cargo_capacity: 750 }, player: { credits: 80_000 }, cargo: [] }),
    execute: async (cmd: string, args?: any) => { calls.push({ cmd, args }); return { result: { action: cmd, ok: true } } },
  } as any
  const ctx = { connection: conn, profileId: 'p-builder', profileName: 'Builder', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}
const out: Record<string, unknown> = {}
// 1. Lines at two depths: purified_argon (input) and power_cell (output, short) — the craft must pass.
setCommissionRequirements('juggernaut', [{ item_id: 'purified_argon', quantity: 683 }, { item_id: 'power_cell', quantity: 529 }], 'p-builder')
{ const h = harness(); out.powerCells = String(await executeTool('game', { command: 'craft', args: { recipe_id: 'synthesize_argon_power_cell', quantity: 137 } }, h.ctx)); out.powerCellsReached = h.calls.some(c => c.cmd === 'craft') }
// 2. Same input line, but the output is NOT a recorded line — the lock must still hold.
setCommissionRequirements('juggernaut', [{ item_id: 'uranium_ore', quantity: 762 }], 'p-builder')
{ const h = harness(); out.concentrateNoLine = String(await executeTool('game', { command: 'craft', args: { recipe_id: 'concentrate_uranium', quantity: 122 } }, h.ctx)); out.concentrateNoLineReached = h.calls.some(c => c.cmd === 'craft') }
// 3. Record the output as a line too (what record-juggernaut-requirements.ts now does) — the craft passes.
setCommissionRequirements('juggernaut', [{ item_id: 'uranium_ore', quantity: 762 }, { item_id: 'uranium_concentrate', quantity: 122 }], 'p-builder')
{ const h = harness(); out.concentrateWithLine = String(await executeTool('game', { command: 'craft', args: { recipe_id: 'concentrate_uranium', quantity: 122 } }, h.ctx)); out.concentrateWithLineReached = h.calls.some(c => c.cmd === 'craft') }
// 4. The output line is already satisfied — converting more of the input would only erode it; blocked.
recordStorageSnapshot('p-builder', STATION, [{ item_id: 'uranium_ore', quantity: 488 }, { item_id: 'uranium_concentrate', quantity: 122 }])
clearStorageDirty('p-builder')
{ const h = harness(); out.concentrateSatisfied = String(await executeTool('game', { command: 'craft', args: { recipe_id: 'concentrate_uranium', quantity: 122 } }, h.ctx)); out.concentrateSatisfiedReached = h.calls.some(c => c.cmd === 'craft') }
// 5. withdraw(item, qty) spelled with the default source/target: the game rejects "source=storage target=cargo",
//    so the arguments are dropped before the wire (CyberSpock, Blood Forge, 2026-09-10 19:27).
{ const h = harness(); await executeTool('game', { command: 'withdraw', args: { item_id: 'uranium_ore', quantity: 355, source: 'storage', target: 'cargo' } }, h.ctx)
  const call = h.calls.find(c => c.cmd === 'withdraw'); out.withdrawArgs = call?.args ?? null }
{ const h = harness(); await executeTool('game', { command: 'withdraw', args: { item_id: 'uranium_ore', quantity: 10, source: 'faction', target: 'self' } }, h.ctx)
  const call = h.calls.find(c => c.cmd === 'withdraw'); out.withdrawFactionArgs = call?.args ?? null }
console.log('__RESULT__' + JSON.stringify(out))
