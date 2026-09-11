/** Subprocess helper for plan-queue.test.ts — isolated DB (chdir before import). */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const { getDb, createProfile, getProfile, addLogEntry, insertPlanStep, getPlanStep, listPlanSteps, recordStorageSnapshot, clearStorageDirty } = await import('../../src/server/lib/db')
const { advancePlanQueue, applyPlanStep, describePlanQueue } = await import('../../src/server/lib/plan-queue')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')
const base = { username: '', password: '', empire: 'crimson', player_id: '', provider: 'custom', model: 'gpt-oss', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: 'LOOP: mine silicon at Subra, sell at Nova Terra.', todo: 'old todo', memory: '', connection_mode: 'lib_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
createProfile({ ...base, id: 'p-ledger', name: 'Ledger', username: 'Ledger Voss' } as any)

function conn(state: Record<string, unknown>) {
  return { mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => state, execute: async () => ({ result: 'ok' }) } as any
}
const out: Record<string, unknown> = {}

// Step 1: the tritium expedition, gated on a sell_cargo DONE at Nova Terra and being docked there.
insertPlanStep({ id: 's1', profile_id: 'p-ledger', plan_id: 'tritium', plan_name: 'Tritium', seq: 1, title: 'Expedition', directive: 'EXPEDITION: fly to Tarazed.', todo: 'go now',
  condition_json: JSON.stringify({ docked_at: 'nova_terra_central', result_matches: 'sell_cargo DONE' }), completion_json: JSON.stringify({ result_matches: 'deposit_items DONE' }), restore_on_done: 1, notes: '' })
// Step 2: needs the Admiral's explicit go.
insertPlanStep({ id: 's2', profile_id: 'p-ledger', plan_id: 'tritium', plan_name: 'Tritium', seq: 2, title: 'Commission', directive: 'COMMISSION: place the order.', todo: null,
  condition_json: JSON.stringify({ admiral_go: true }), completion_json: null, restore_on_done: 0, notes: '' })

// (a) docked at the right station but no matching result yet -> nothing happens
out.a = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'nova_terra', docked_at: 'nova_terra_central' }, player: { credits: 5 } }) })
out.aDirective = getProfile('p-ledger')!.directive
out.aWaiting = (await describePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'nova_terra', docked_at: 'nova_terra_central' } }) })).map(s => [s.id, s.status, s.waiting_on])
// (b) the result arrives but the agent is in space -> still nothing (docked gate)
addLogEntry('p-ledger', 'tool_result', 'sell_cargo DONE: +120,000cr from 450 silicon_ore')
out.b = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'nova_terra', docked_at: null }, player: { credits: 5 } }) })
// (c) docked again -> step 1 applies: directive + TODO replaced, old directive kept as restore_to
const c = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'nova_terra', docked_at: 'nova_terra_central' }, player: { credits: 5 } }) })
out.cApplied = c?.applied?.id ?? null
const pc = getProfile('p-ledger')!; out.cDirective = pc.directive; out.cTodo = pc.todo
const s1 = getPlanStep('s1')!; out.cStatus = s1.status; out.cRestoreTo = s1.restore_to
out.cLog = (db.query("SELECT summary FROM log_entries WHERE profile_id = 'p-ledger' AND type = 'system' ORDER BY id DESC LIMIT 1").get() as any)?.summary ?? null
// (d) a result from BEFORE the step fired must not complete it; one after it does, and restores the loop directive
out.dEarly = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'tarazed', docked_at: null } }) })
addLogEntry('p-ledger', 'tool_result', 'deposit_items DONE: 160 tritium_ice into the lockbox')
const d = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'krynn', docked_at: 'crimson_war_citadel' } }) })
out.dCompleted = d?.completed?.id ?? null; out.dApplied = d?.applied?.id ?? null
out.dDirective = getProfile('p-ledger')!.directive; out.dStatus = getPlanStep('s1')!.status
// (e) the admiral_go step never applies on its own, even docked with everything else true...
out.e = await advancePlanQueue({ profileId: 'p-ledger', connection: conn({ location: { system_id: 'krynn', docked_at: 'crimson_war_citadel' }, player: { credits: 2_000_000 } }) })
out.eStatus = getPlanStep('s2')!.status
// ...but the Admiral can fire it
applyPlanStep('s2', 'fired')
out.fDirective = getProfile('p-ledger')!.directive; out.fStatus = getPlanStep('s2')!.status
out.fLog = (db.query("SELECT summary FROM log_entries WHERE profile_id = 'p-ledger' AND type = 'system' ORDER BY id DESC LIMIT 1").get() as any)?.summary ?? null
// (g) storage threshold reads the snapshot: below -> waits, above -> applies
insertPlanStep({ id: 's3', profile_id: 'p-ledger', plan_id: 'craft', plan_name: 'Craft', seq: 1, title: 'Craft phase', directive: 'CRAFT: run the recipes.', todo: null,
  condition_json: JSON.stringify({ docked_at: 'blood_forge_smelting_works', storage_at_least: { station_id: 'blood_forge_smelting_works', item_id: 'uranium_ore', qty: 366 } }), completion_json: null, restore_on_done: 0, notes: '' })
recordStorageSnapshot('p-ledger', 'blood_forge_smelting_works', [{ item_id: 'uranium_ore', quantity: 234 }]); clearStorageDirty('p-ledger')
const bf = conn({ location: { system_id: 'blood_forge', docked_at: 'blood_forge_smelting_works' } })
out.gLow = await advancePlanQueue({ profileId: 'p-ledger', connection: bf })
recordStorageSnapshot('p-ledger', 'blood_forge_smelting_works', [{ item_id: 'uranium_ore', quantity: 488 }]); clearStorageDirty('p-ledger')
out.gHigh = (await advancePlanQueue({ profileId: 'p-ledger', connection: bf }))?.applied?.id ?? null
out.count = listPlanSteps('p-ledger').length
console.log('__RESULT__' + JSON.stringify(out))
