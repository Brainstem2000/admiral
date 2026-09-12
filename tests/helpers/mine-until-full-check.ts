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
/**
 * keep=silicon_ore: the belt yields silicon and iron alternately; when the hold fills the
 * macro must jettison the iron (this POI holds an iron deposit, so it settles back) and
 * keep mining until the hold is all silicon. A second variant has a POI with no silicon
 * deposit (abort), and a third stops yielding silicon after the first dump (progress stop).
 */
function keepHarness(opts: { capacity: number; deposits: string[]; yields: string[]; stopSiliconAfterDump?: boolean }) {
  const cargo: Array<{ item_id: string; quantity: number }> = []
  const used = () => cargo.reduce((a, c) => a + c.quantity, 0)
  let mines = 0; let dumps = 0
  const jettisoned: Array<{ item_id: string; quantity: number }> = []
  const add = (id: string, q: number) => { const c = cargo.find(x => x.item_id === id); if (c) c.quantity += q; else cargo.push({ item_id: id, quantity: q }) }
  const conn = {
    mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'subra', poi_id: 'silicon_flats_subra', docked_at: null, in_transit: false, resources: opts.deposits.map(d => ({ item_id: d, remaining: 5000 })) },
      ship: { cargo_used: used(), cargo_capacity: opts.capacity, hull: 100, max_hull: 100, fuel: 100, max_fuel: 180 }, player: { credits: 1000 },
      cargo: cargo.map(c => ({ ...c })),
    }),
    execute: async (cmd: string, args?: any) => {
      if (cmd === 'mine') {
        mines++
        let ore = opts.yields[(mines - 1) % opts.yields.length]
        if (opts.stopSiliconAfterDump && dumps > 0 && ore === 'silicon_ore') ore = 'iron_ore'
        add(ore, Math.min(2, opts.capacity - used()))
        return { result: { action: 'mine', mined: 2 } }
      }
      if (cmd === 'jettison') {
        dumps++
        const c = cargo.find(x => x.item_id === args.item_id)
        if (!c) return { error: { code: 'not_in_cargo', message: 'nothing to dump' } }
        jettisoned.push({ item_id: args.item_id, quantity: args.quantity })
        c.quantity -= Math.min(c.quantity, Number(args.quantity))
        return { result: { action: 'jettison', item_id: args.item_id, quantity: args.quantity } }
      }
      return { result: { action: cmd } }
    },
  } as any
  const ctx = { connection: conn, profileId: 'p-miner', profileName: 'Miner', log: () => {}, todo: '', memory: '' } as any
  return { ctx, mines: () => mines, cargo, jettisoned }
}

const out: Record<string, unknown> = {}
{ const h = keepHarness({ capacity: 12, deposits: ['silicon_ore', 'iron_ore'], yields: ['silicon_ore', 'iron_ore'] })
  out.keepText = String(await executeTool('mine_until_full', { keep: 'silicon_ore' }, h.ctx)); out.keepMines = h.mines(); out.keepCargo = h.cargo.filter(c => c.quantity > 0); out.keepJettisoned = h.jettisoned }
{ const h = keepHarness({ capacity: 12, deposits: ['iron_ore', 'copper_ore'], yields: ['iron_ore'] })
  out.keepAbortText = String(await executeTool('mine_until_full', { keep: 'silicon_ore' }, h.ctx)); out.keepAbortMines = h.mines() }
{ const h = keepHarness({ capacity: 12, deposits: ['silicon_ore', 'iron_ore'], yields: ['silicon_ore', 'iron_ore'], stopSiliconAfterDump: true })
  out.keepStallText = String(await executeTool('mine_until_full', { keep: 'silicon_ore' }, h.ctx)); out.keepStallJettisoned = h.jettisoned.length }
{ const h = harness({ capacity: 12, perMine: 2 }); out.fullText = String(await executeTool('mine_until_full', { resource: 'silicon_ore' }, h.ctx)); out.fullMines = h.mines(); out.fullCargo = h.state.cargo_used }
{ const h = harness({ capacity: 12, perMine: 2 }); out.capText = String(await executeTool('mine_until_full', { resource: 'silicon_ore', max_mines: 2 }, h.ctx)); out.capMines = h.mines() }
{ const h = harness({ capacity: 100, perMine: 2, hullDropAfter: 2 }); out.hullText = String(await executeTool('mine_until_full', { resource: 'silicon_ore' }, h.ctx)); out.hullMines = h.mines() }
{ const h = harness({ capacity: 100, perMine: 2 }); let n = 0; h.ctx.interruptPending = () => (h.mines() >= 2 ? 'Admiral nudge pending' : null); out.interruptText = String(await executeTool('mine_until_full', { resource: 'silicon_ore' }, h.ctx)); out.interruptMines = h.mines(); void n }
console.log('__RESULT__' + JSON.stringify(out))
