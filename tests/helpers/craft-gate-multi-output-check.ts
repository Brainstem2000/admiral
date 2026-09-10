/**
 * Subprocess helper for craft-gate-multi-output.test.ts. Fresh process + chdir
 * before import = an isolated database (db.ts binds DB_PATH from cwd at module
 * load), so the profile and storage rows this seeds never touch data/admiral.db.
 * The catalog cache is copied in so codexGet resolves recipes without network.
 * Prints one __RESULT__<json> line.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs')
const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const repoData = path.resolve(import.meta.dir, '..', '..', 'data')
for (const f of ['catalog-cache.json', 'catalog-etag.txt']) {
  const src = path.join(repoData, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workspace, 'data', f))
}
const { getDb, createProfile, recordStorageSnapshot } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const { startCatalogService, codexGet } = await import('../../src/server/lib/catalog')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}
startCatalogService()

const STATION = 'crimson_war_citadel'
let n = 0
function harness() {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'krynn', docked_at: STATION },
      ship: { hull: 100, max_hull: 100 },
      player: { credits: 1000 },
    }),
    execute: async (cmd: string, args?: any) => { calls.push({ cmd, args }); return { result: 'ok' } },
  } as any
  const id = `p-craft-multi-${++n}`
  createProfile({
    id, name: `Craft Gate Test ${n}`, username: '', password: '', empire: 'crimson', player_id: '',
    provider: 'manual', model: '', planner_provider: null, planner_model: null, planning_interval: null,
    codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '',
    directive: '', todo: '', memory: '', connection_mode: 'lib_v2', server_url: '', autoconnect: false, enabled: true,
    context_budget: null, sort_order: 0, group_name: '',
  } as any)
  const ctx = { connection: conn, profileId: id, profileName: 'Test', log: () => {}, todo: '', memory: '' } as any
  return { ctx, calls }
}

async function attempt(recipe_id: string, quantity: number, seed: Array<{ item_id: string; quantity: number }>) {
  const { ctx, calls } = harness()
  recordStorageSnapshot(ctx.profileId, STATION, seed)
  const out = await executeTool('game', { command: 'craft', args: { recipe_id, quantity } }, ctx)
  return { out: String(out), reached: calls.some(c => c.cmd === 'craft') }
}

const argonRecipe = codexGet('recipe', 'purify_argon') as any
const wiringRecipe = codexGet('recipe', 'process_copper_wiring') as any
const result = {
  argon: { in: argonRecipe?.inputs?.[0], out: argonRecipe?.outputs?.[0] },
  wiring: { in: wiringRecipe?.inputs?.[0], out: wiringRecipe?.outputs?.[0] },
  argon680: await attempt('purify_argon', 680, [{ item_id: 'argon_gas', quantity: 1241 }]),
  argon760: await attempt('purify_argon', 760, [{ item_id: 'argon_gas', quantity: 1241 }]),
  wiring382: await attempt('process_copper_wiring', 382, [{ item_id: 'copper_ore', quantity: 767 }]),
  wiring384: await attempt('process_copper_wiring', 384, [{ item_id: 'copper_ore', quantity: 767 }]),
  iron5: await attempt('basic_iron_smelting', 5, []),
}
console.log('__RESULT__' + JSON.stringify(result))
