/** Subprocess helper for mine-until-full-one-call.test.ts — isolated DB (chdir before import). */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const { getDb, createProfile } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
const base = { username: '', password: '', empire: 'solarian', player_id: '', provider: 'custom', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-miner', name: 'Miner', username: 'Ledger Voss' } as any)

function harness(opts: { capacity: number; perMine: number; hullDropAfter?: number }) {
  const state = { cargo_used: 0, cargo_capacity: opts.capacity, hull: 100, max_hull: 100 }
  let mines = 0
  const conn = {
    mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => ({ location: { system_id: 'subra', poi_id: 'silicon_flats_subra', docked_at: null }, ship: { ...state, fuel: 100, max_fuel: 180 }, player: { credits: 1000 }, cargo: [] }),
    execute: async (cmd: string) => {
      if (cmd === 'mine') {
        mines++
        state.cargo_used = Math.min(state.cargo_capacity, state.cargo_used + opts.perMine)
        if (opts.hullDropAfter && mines >= opts.hullDropAfter) state.hull = 40
        return { result: { action: 'mine', mined: opts.perMine } }
      }
      return { result: { action: cmd, ship: { ...state } } }
    },
  } as any
  const ctx = { connection: conn, profileId: 'p-miner', profileName: 'Miner', log: () => {}, todo: '', memory: '' } as any
  return { ctx, mines: () => mines, state }
}
const out: Record<string, unknown> = {}
{ const h = harness({ capacity: 12, perMine: 2 }); out.fullText = String(await executeTool('mine_until_full', { resource: 'silicon_ore' }, h.ctx)); out.fullMines = h.mines(); out.fullCargo = h.state.cargo_used }
{ const h = harness({ capacity: 12, perMine: 2 }); out.capText = String(await executeTool('mine_until_full', { resource: 'silicon_ore', max_mines: 2 }, h.ctx)); out.capMines = h.mines() }
{ const h = harness({ capacity: 100, perMine: 2, hullDropAfter: 2 }); out.hullText = String(await executeTool('mine_until_full', { resource: 'silicon_ore' }, h.ctx)); out.hullMines = h.mines() }
console.log('__RESULT__' + JSON.stringify(out))
