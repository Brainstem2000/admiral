/** Subprocess helper for build-plan.test.ts — runs scripts/build-plan.ts against a seeded temp DB
 *  and fixture feeds (data/.cache), so no network and never data/admiral.db. chdir before import. */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data', '.cache'), { recursive: true })

// Fixture feeds: feed() in the script reads data/.cache/<name> when it is fresh, so a
// just-written file is used without any fetch.
const catalog = {
  ships: [{ id: 'testhull', name: 'Test Hull', shipyard_tier: 1, minimum_crew: 1,
    build_materials: [{ item_id: 'widget', quantity: 10 }, { item_id: 'gizmo', quantity: 4 }] }],
  items: [{ id: 'widget', extracted_by: 'mining' }, { id: 'gizmo' }, { id: 'sprocket' }, { id: 'cog' }],
  recipes: [{ id: 'forge_gizmo', outputs: [{ item_id: 'gizmo', quantity: 1 }], inputs: [{ item_id: 'cog', quantity: 2 }] }],
}
const market = [
  { item_id: 'widget', empire: 'testland', best_ask: 100, ask_quantity_at_best: 50 },
  { item_id: 'cog', empire: 'testland', best_ask: 10, ask_quantity_at_best: 100 },
]
fs.writeFileSync(path.join(workspace, 'data', '.cache', 'catalog.json'), JSON.stringify(catalog))
fs.writeFileSync(path.join(workspace, 'data', '.cache', 'market.json'), JSON.stringify(market))

const { getDb, createProfile, recordStorageSnapshot, recordFactionStorageSnapshot, setCommissionRequirements } = await import('../../src/server/lib/db')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
const base = { username: '', password: '', empire: 'crimson', player_id: '', provider: 'custom', model: 'gpt-oss', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-test', name: 'Tester', username: 'Tester' } as any)
// The trap this test exists for: plenty of stock at the WRONG station must not count.
recordStorageSnapshot('p-test', 'other_station', [{ item_id: 'widget', quantity: 100 }, { item_id: 'gizmo', quantity: 100 }])
recordStorageSnapshot('p-test', 'yard_station', [{ item_id: 'widget', quantity: 6 }])
recordFactionStorageSnapshot('fac', 'yard_station', [{ item_id: 'gizmo', quantity: 3 }], null)
recordFactionStorageSnapshot('fac', 'other_station', [{ item_id: 'sprocket', quantity: 50 }], null)
// Two requirement rows the yard also lists, plus one recorded-only intermediate.
setCommissionRequirements('testhull', [{ item_id: 'widget', quantity: 10 }, { item_id: 'gizmo', quantity: 4 }, { item_id: 'sprocket', quantity: 2 }], 'p-test')
db.close()

const script = path.resolve(import.meta.dir, '..', '..', 'scripts', 'build-plan.ts')
async function run(args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, script, ...args], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`build-plan exited ${code}: ${err}\n${out}`)
  return out
}
const out: Record<string, unknown> = {}
out.atYard = await run(['testhull', '--for', 'Tester', '--at', 'yard_station', '--faction'])
out.noYard = await run(['testhull', '--for', 'Tester'])
console.log('__RESULT__' + JSON.stringify(out))
