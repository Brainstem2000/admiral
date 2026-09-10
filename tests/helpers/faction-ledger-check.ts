/**
 * Subprocess helper for faction-ledger.test.ts (isolated DB — db.ts binds DB_PATH
 * from cwd at module load). Feeds captureFactionFromCommand the payload shapes
 * recorded live on 2026-09-06/10 and reads the tables back. Prints __RESULT__<json>.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs')
const { getDb, getFactionStorage, getFactionLedger, getFactionTreasurySummary, getFactionStorageQuantity, createProfile } = await import('../../src/server/lib/db')
const { captureFactionFromCommand } = await import('../../src/server/lib/faction-ledger')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) throw new Error(`db opened outside the temp workspace: ${opened}`)
createProfile({ id: 'p-fac', name: 'Faction Test', username: '', password: '', empire: 'crimson', player_id: '', provider: 'manual', model: '',
  planner_provider: null, planner_model: null, planning_interval: null, codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false,
  codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'lib_v2', server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' } as any)

const out: Record<string, unknown> = {}
// 1) lockbox listing + treasury (shape of `view target=faction`, 2026-09-06 / 2026-09-10)
const view = { action: 'view_faction_storage', base_id: 'crimson_war_citadel', credits: 2914065, faction_id: 'fd63', faction_name: 'Stellar Alliance', faction_tag: 'STLR',
  items: [{ item_id: 'shield_emitter', name: 'Shield Emitter', quantity: 172, size: 3 }, { item_id: 'hull_plating', name: 'Hull Plating', quantity: 195, size: 2 }] }
captureFactionFromCommand('view', { target: 'faction' }, view, 'p-fac', 'Faction Test')
out.storage = getFactionStorage('crimson_war_citadel').map(r => [r.item_id, r.quantity])
out.shield = getFactionStorageQuantity('shield_emitter')
// 2) lib_v2 transfer result (storage -> faction), exactly as logged 2026-09-10 11:36
const transfer = { result: { command: 'storage', tick: 1847090, details: { action: 'transfer', source: 'storage', destination: 'faction', item_id: 'reactor_fuel_assembly', quantity: 8, source_remaining: 0, dest_total: 8 } } }
const n1 = captureFactionFromCommand('deposit', { item_id: 'reactor_fuel_assembly', quantity: 8, source: 'storage', target: 'faction' }, transfer, 'p-fac', 'Faction Test', { station: 'crimson_war_citadel' })
const n1b = captureFactionFromCommand('deposit', { item_id: 'reactor_fuel_assembly', quantity: 8, source: 'storage', target: 'faction' }, transfer, 'p-fac', 'Faction Test', { station: 'crimson_war_citadel' })
out.transferRows = [n1, n1b]
// 3) withdrawal from faction with only the ship payload back (no transfer details): derive from args
const shipOnly = { result: { command: 'storage', tick: 1847100, details: { cargo: [{ item_id: 'weapon_core', quantity: 182 }], location: { docked_at: 'crimson_war_citadel' } } } }
const n2 = captureFactionFromCommand('withdraw', { item_id: 'weapon_core', quantity: 182, source: 'faction', target: 'self' }, shipOnly, 'p-fac', 'Faction Test', { station: 'crimson_war_citadel' })
out.withdrawRows = n2
// 4) treasury gift (the levy shape)
const gift = { action: 'faction_gift', recipient: 'faction:STLR', credits_sent: 50000, wallet_remaining: 1000 }
const n3 = captureFactionFromCommand('send_gift', { recipient: 'faction:STLR', credits: 50000 }, gift, 'p-fac', 'Faction Test')
// 5) a player-to-player gift must NOT book a treasury row
const p2p = { action: 'send_gift', recipient: 'CyberSpock', credits_sent: 50000, wallet_remaining: 1000 }
const n4 = captureFactionFromCommand('send_gift', { recipient: 'CyberSpock', credits: 50000 }, p2p, 'p-fac', 'Faction Test')
// 6) an errored result books nothing
const n5 = captureFactionFromCommand('deposit', { item_id: 'x', quantity: 1, target: 'faction' }, { error: { code: 'hazmat_required' } }, 'p-fac', 'Faction Test')
out.giftRows = [n3, n4, n5]
out.ledger = getFactionLedger({ limit: 50 }).map(r => [r.kind, r.item_id, r.quantity, r.credits_signed, r.station_id, r.faction_tag])
out.treasury = getFactionTreasurySummary()
console.log('__RESULT__' + JSON.stringify(out))
