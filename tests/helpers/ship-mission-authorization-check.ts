/** Subprocess helper for ship-mission-authorization.test.ts — isolated DB (chdir before import). */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const { getDb, createProfile, updateProfile } = await import('../../src/server/lib/db')
const { checkDoctrineGuards } = await import('../../src/server/lib/tools')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
const base = { username: '', password: '', empire: 'nebula', player_id: '', provider: 'custom', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-cs', name: 'CyberSpock', username: 'CyberSpock' } as any)
const out: Record<string, unknown> = {}
const set = (d: string) => updateProfile('p-cs', { directive: d })
set('## Courier run. Deliver the load to Morg, post DONE and stay docked.')
out.shipIdle = checkDoctrineGuards('buy_listed_ship', { id: 'c5ee72d0' }, 'p-cs', 'arneb')
out.missionIdle = checkDoctrineGuards('accept_mission', { id: 'leviathan_bounty' }, 'p-cs', 'arneb')
set('## Refit. Buy a Gas Tanker hull at War Citadel (max 60,000) and fit the laser.')
out.shipAuthorized = checkDoctrineGuards('buy_listed_ship', { id: 'c5ee72d0' }, 'p-cs', 'krynn')
set('## Morg — raise Crimson reputation by completing Crimson contracts. Boards: War Citadel, Iron Reach.')
out.missionAuthorized = checkDoctrineGuards('accept_mission', { id: 'crimson_escort' }, 'p-cs', 'krynn')
set('## Recall. Accept no missions — abandon the Leviathan Bounty and never take another.')
out.missionForbidden = checkDoctrineGuards('accept_mission', { id: 'another' }, 'p-cs', 'arneb')
console.log('__RESULT__' + JSON.stringify(out))
