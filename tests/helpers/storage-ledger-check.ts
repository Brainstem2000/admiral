/**
 * Subprocess helper for storage-ledger.test.ts. Fresh process + chdir before
 * import = an isolated database (db.ts binds DB_PATH from cwd at module load),
 * so nothing here can touch data/admiral.db. Prints one __RESULT__<json> line.
 *
 * Exercises the storage ledger end to end: command-time hooks through
 * executeTool (deposit, withdraw) and the shared hook function (gift, buy,
 * switch_ship, craft, create_sell_order), action-log dedupe/placement/unplaced
 * handling, crafting events, the snapshot-clock guard, and reconciliation.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs')
const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const { Database } = await import('bun:sqlite')
const db_ = await import('../../src/server/lib/db')
const { getDb, createProfile, recordStorageSnapshot, getStorageQuantity, getStorageLedger, isStorageDirty, clearStorageDirty,
  recordPosition, positionAt, stationStorageObservedAt, describeStorageDrift, getStorageForProfile, storageSnapshotAgeMs } = db_
const { executeTool, recordStorageMutationFromCommand, recordStorageFromCommand } = await import('../../src/server/lib/tools')
const { applyStorageEvents, storageEffects, ingestActionLog, facilityStation } = await import('../../src/server/lib/action-log')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) throw new Error(`db opened outside the temp workspace: ${opened}`)

const STATION = 'crimson_war_citadel'
const LOCATION = { system_id: 'krynn', system_name: 'Krynn', poi_id: 'war_citadel', docked_at: STATION }
const base = { password: '', empire: 'crimson', player_id: '', provider: 'manual', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '',
  connection_mode: 'lib_v2', server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }
const mk = (id: string, name: string, username: string) => createProfile({ ...base, id, name, username } as any)
mk('p-sapper', 'CyberSapper - Smuggler', 'CyberSapper')
mk('p-morg', "Morg'Thar - Warrior", "Morg'Thar")
mk('p-dep', 'Deposit Test', 'DepTest')
mk('p-wd', 'Withdraw Test', 'WdTest')
mk('p-place', 'Placement Test', 'PlaceTest')
mk('p-lost', 'Unplaced Test', 'LostTest')
mk('p-craft', 'Craft Test', 'CraftTest')
mk('p-snap', 'Snapshot Test', 'SnapTest')
mk('p-ingest', 'Ingest Test', 'IngestTest')
mk('p-misc', 'Misc Hooks', 'MiscTest')

const ledgerOf = (pid: string, item?: string) => getStorageLedger(pid, { itemId: item, limit: 50 })
  .map(r => ({ station: r.station_id, item: r.item_id, delta: r.delta, source: r.source, ref: r.ref, confidence: r.confidence, event_id: r.event_id }))
  .reverse()

function conn(reply: (cmd: string, args?: any) => any, state: Record<string, unknown> = {}) {
  const calls: Array<{ cmd: string; args: any }> = []
  return {
    calls,
    c: {
      mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
      getLocalState: () => ({ location: LOCATION, ship: { hull: 100, max_hull: 100, fuel: 100, max_fuel: 130 }, player: { credits: 5000 }, ...state }),
      execute: async (cmd: string, args?: any) => { calls.push({ cmd, args }); return reply(cmd, args) },
    } as any,
  }
}
const ctxFor = (pid: string, c: any) => ({ connection: c, profileId: pid, profileName: pid, todo: '', memory: '', log: (t: string, s: string) => { logs.push(`${pid} ${t}: ${s}`) } } as any)
const logs: string[] = []
const out: Record<string, unknown> = {}

// ── 1. deposit through executeTool, lib_v2 shape (delta as structuredContent, details inside) ──
{
  const details = { action: 'deposit_items', item_id: 'fury_alloy', quantity: 10, storage_total: 10, cargo_remaining: 0, cargo_space: 94 }
  const { c } = conn((cmd) => cmd === 'deposit' || cmd === 'deposit_items'
    ? { result: { command: 'storage', tick: 1752314, details }, structuredContent: { ship: { hull: 100 }, cargo: [], location: LOCATION, details } }
    : { result: 'ok' })
  const text = await executeTool('game', { command: 'deposit', args: { item_id: 'fury_alloy', quantity: 10 } }, ctxFor('p-dep', c))
  out.deposit = { text: String(text).slice(0, 80), qty: getStorageQuantity('p-dep', STATION, 'fury_alloy'), ledger: ledgerOf('p-dep'), dirty: isStorageDirty('p-dep') }
}

// ── 2. withdraw through executeTool, v1 http shape (bare result) after a seeded snapshot ──
{
  recordStorageSnapshot('p-wd', STATION, [{ item_id: 'steel_plate', quantity: 100 }])
  const { c } = conn((cmd) => cmd === 'withdraw' || cmd === 'withdraw_items'
    ? { result: { action: 'withdraw_items', item_id: 'steel_plate', quantity: 40, storage_remaining: 60, cargo_total: 40, cargo_space: 0 } }
    : { result: 'ok' })
  await executeTool('game', { command: 'withdraw', args: { item_id: 'steel_plate', quantity: 40 } }, ctxFor('p-wd', c))
  out.withdraw = { qty: getStorageQuantity('p-wd', STATION, 'steel_plate'), ledger: ledgerOf('p-wd') }
}

// ── 3. item gift from storage: sender −, fleet recipient + at the sender's base (base_id in the result) ──
{
  recordStorageSnapshot('p-sapper', STATION, [{ item_id: 'fury_crystal', quantity: 766 }])
  const r = recordStorageMutationFromCommand('send_gift', { recipient: "Morg'Thar", item_id: 'fury_crystal', quantity: 30, source: 'storage' },
    { action: 'send_gift', recipient: "Morg'Thar", base_id: STATION, source: 'storage', item_id: 'fury_crystal', quantity: 30, storage_remaining: 736 },
    { profileId: 'p-sapper', station: STATION })
  out.gift = { rows: r.rows, mirrored: r.mirrored, sender: getStorageQuantity('p-sapper', STATION, 'fury_crystal'), recipient: getStorageQuantity('p-morg', STATION, 'fury_crystal'),
    senderLedger: ledgerOf('p-sapper', 'fury_crystal'), recipientLedger: ledgerOf('p-morg', 'fury_crystal') }
  // A gift from CARGO leaves the sender's storage alone but still lands in the recipient's storage.
  const r2 = recordStorageMutationFromCommand('send_gift', { recipient: "Morg'Thar", item_id: 'processing_core', quantity: 9 },
    { action: 'send_gift', recipient: "Morg'Thar", base_id: STATION, item_id: 'processing_core', quantity: 9, cargo_remaining: 0 }, { profileId: 'p-sapper', station: STATION })
  out.giftFromCargo = { rows: r2.rows, sender: getStorageQuantity('p-sapper', STATION, 'processing_core'), recipient: getStorageQuantity('p-morg', STATION, 'processing_core') }
  // A gift to an outsider mirrors nothing.
  const r3 = recordStorageMutationFromCommand('send_gift', { recipient: 'SomeStranger', item_id: 'fury_crystal', quantity: 1, source: 'storage' },
    { action: 'send_gift', recipient: 'SomeStranger', base_id: STATION, source: 'storage', item_id: 'fury_crystal', quantity: 1, storage_remaining: 735 }, { profileId: 'p-sapper', station: STATION })
  out.giftOutsider = { rows: r3.rows, mirrored: r3.mirrored.length, sender: getStorageQuantity('p-sapper', STATION, 'fury_crystal') }
}

// ── 4. action-log events that match command rows are ATTACHED, never applied twice ──
{
  const now = new Date().toISOString()
  const sent = applyStorageEvents('p-sapper', [{ event_id: 101, created_at: now, category: 'trading', event_type: 'trading.gift_sent',
    data: { item_id: 'fury_crystal', quantity: 30, recipient: "Morg'Thar", sender: 'CyberSapper', source: 'storage' } }])
  const recv = applyStorageEvents('p-morg', [{ event_id: 202, created_at: now, category: 'trading', event_type: 'trading.gift_received',
    data: { item_id: 'fury_crystal', quantity: 30, recipient: "Morg'Thar", sender: 'CyberSapper', source: 'storage' } }])
  const dep = applyStorageEvents('p-dep', [{ event_id: 303, created_at: now, category: 'storage', event_type: 'storage.deposit_items', data: { item_id: 'fury_alloy', quantity: 10 } }])
  out.dedupe = { sent, recv, depSummary: dep,
    sender: getStorageQuantity('p-sapper', STATION, 'fury_crystal'), recipient: getStorageQuantity('p-morg', STATION, 'fury_crystal'), depQty: getStorageQuantity('p-dep', STATION, 'fury_alloy'),
    senderLedger: ledgerOf('p-sapper', 'fury_crystal'), recipientLedger: ledgerOf('p-morg', 'fury_crystal'),
    depDirty: isStorageDirty('p-dep'), sapperDirty: isStorageDirty('p-sapper'), morgDirty: isStorageDirty('p-morg') }
}

// ── 5. an unmatched event is placed from position_history (newest docked observation before it, within 10 min) ──
{
  const t0 = Date.now() - 5 * 60_000
  recordPosition('p-place', STATION, new Date(t0).toISOString())
  const ev = { event_id: 404, created_at: new Date(t0 + 60_000).toISOString(), category: 'storage', event_type: 'storage.bulk_deposit', data: { items: { gas_harvester_iii: 1, rad_harvester_i: 2 } } }
  const s = applyStorageEvents('p-place', [ev])
  const placeDirtyAfterS = isStorageDirty('p-place')
  // ...but an event AFTER the agent was seen undocked is not pinned to the station left behind.
  recordPosition('p-place', null, new Date(t0 + 120_000).toISOString())
  const s2 = applyStorageEvents('p-place', [{ event_id: 405, created_at: new Date(t0 + 180_000).toISOString(), category: 'storage', event_type: 'storage.deposit_items', data: { item_id: 'iron_ore', quantity: 5 } }])
  // and a stale observation (older than 10 minutes) places nothing.
  recordPosition('p-lost', STATION, new Date(Date.now() - 30 * 60_000).toISOString())
  const s3 = applyStorageEvents('p-lost', [{ event_id: 406, created_at: new Date(Date.now() - 60_000).toISOString(), category: 'storage', event_type: 'storage.withdraw_items', data: { item_id: 'iron_ore', quantity: 5 } }])
  out.placed = { s, s2, s3, gas: getStorageQuantity('p-place', STATION, 'gas_harvester_iii'), rad: getStorageQuantity('p-place', STATION, 'rad_harvester_i'),
    iron: getStorageQuantity('p-place', STATION, 'iron_ore'), ledger: ledgerOf('p-place'), placeDirty: placeDirtyAfterS, placeDirtyAfterUndock: isStorageDirty('p-place'), lostDirty: isStorageDirty('p-lost'), lostLedger: ledgerOf('p-lost'),
    positionAt: positionAt('p-place', new Date(t0 + 60_000).toISOString())?.station_id ?? null,
    throttled: (recordPosition('p-place', 'x_station'), recordPosition('p-place', 'x_station') === false) }
}

// ── 6. a received gift from an OUTSIDER cannot be placed: journaled unplaced, profile dirty, nothing applied ──
{
  clearStorageDirty('p-morg')
  const s = applyStorageEvents('p-morg', [{ event_id: 507, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.gift_received',
    data: { item_id: 'gold_ore', quantity: 12, recipient: "Morg'Thar", sender: 'SomeStranger' } }])
  out.unplaced = { s, qty: getStorageQuantity('p-morg', STATION, 'gold_ore'), dirty: isStorageDirty('p-morg'), row: ledgerOf('p-morg', 'gold_ore') }
}

// ── 7. a snapshot RECONCILES: drift rows explain every correction, dirty clears, observed_at is stamped ──
{
  recordStorageMutationFromCommand('deposit', { item_id: 'fury_alloy', quantity: 10 }, { action: 'deposit_items', item_id: 'fury_alloy', quantity: 10, storage_total: 10, cargo_remaining: 0, cargo_space: 90 }, { profileId: 'p-snap', station: STATION })
  applyStorageEvents('p-snap', [{ event_id: 608, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.gift_received', data: { item_id: 'x', quantity: 1, sender: 'Nobody' } }])
  const before = { qty: getStorageQuantity('p-snap', STATION, 'fury_alloy'), dirty: isStorageDirty('p-snap'), observed: stationStorageObservedAt('p-snap', STATION) }
  const snap = recordStorageFromCommand('view', { action: 'view_storage', base_id: STATION, items: [
    { item_id: 'fury_alloy', name: 'Fury Alloy', quantity: 7, size: 1 }, { item_id: 'fury_crystal', name: 'Fury Crystal', quantity: 766, size: 1 }] }, 'p-snap')
  out.reconcile = { before, drift: snap?.drift, line: snap ? describeStorageDrift(snap.station, snap.drift) : null,
    after: getStorageForProfile('p-snap').map(r => ({ item: r.item_id, qty: r.quantity, observed: !!r.observed_at })),
    dirty: isStorageDirty('p-snap'), ledger: ledgerOf('p-snap'), ageMs: storageSnapshotAgeMs('p-snap', STATION),
    noDrift: recordStorageFromCommand('view_storage', { action: 'view_storage', base_id: STATION, items: [{ item_id: 'fury_alloy', quantity: 7 }, { item_id: 'fury_crystal', quantity: 766 }] }, 'p-snap')?.drift.length,
    emptyStationClock: (recordStorageFromCommand('view_storage', { action: 'view_storage', base_id: 'empty_station', items: [] }, 'p-snap'), stationStorageObservedAt('p-snap', 'empty_station') !== null) }
}

// ── 8. crafting: queued consumes inputs×runs at the workshop's station; completed produces outputs; cancel refunds; snapshot-clock guard ──
{
  const recipe = () => ({ inputs: [{ item_id: 'creature_carapace', quantity: 2 }], outputs: [{ item_id: 'carapace_plating', quantity: 1 }] })
  recordStorageSnapshot('p-craft', STATION, [{ item_id: 'creature_carapace', quantity: 20 }])
  const t = Date.now() + 1000   // after the snapshot above (the guard compares against its clock)
  const fac = 'workshop:63184a55500e4fc66c610aa0ed24276f:crimson_war_citadel'
  const queued = { event_id: 701, created_at: new Date(t).toISOString(), category: 'crafting', event_type: 'crafting.queued',
    data: { direction: 'forward', facility_id: fac, job_id: 'job1', mode: 'craft', quantity: 3, recipe: 'Carapace Plating', recipe_id: 'carapace_plating', runs: 3, storage: 'station', venue: 'Station Workshop' } }
  const q = applyStorageEvents('p-craft', [queued], { recipe })
  const done = applyStorageEvents('p-craft', [{ event_id: 702, created_at: new Date(t + 50_000).toISOString(), category: 'crafting', event_type: 'crafting.completed',
    data: { direction: 'forward', facility_id: fac, job_id: 'job1', mode: 'craft', recipe: 'Carapace Plating', recipe_id: 'carapace_plating', runs: 3, storage: 'station', venue: 'Station Workshop' } }], { recipe })
  const cancel = applyStorageEvents('p-craft', [{ event_id: 703, created_at: new Date(t + 60_000).toISOString(), category: 'crafting', event_type: 'crafting.cancelled',
    data: { direction: 'forward', facility_id: fac, job_id: 'job1', recipe_id: 'carapace_plating', runs_done: 2, runs_remaining: 1, runs_total: 3, venue: 'Station Workshop' } }], { recipe, queuedJob: () => queued as any })
  // faction-bucket jobs are the faction ledger's business; an unknown recipe marks dirty instead of guessing.
  const faction = storageEffects('p-craft', { ...queued, event_id: 704, data: { ...queued.data, storage: 'faction' } } as any, { recipe })
  const unknown = storageEffects('p-craft', { ...queued, event_id: 705, data: { ...queued.data, recipe_id: 'mystery' } } as any, { recipe: () => null })
  // a private facility (bare uuid) is placed from where the agent was when the job was queued
  const priv = storageEffects('p-craft', { ...queued, event_id: 706, data: { ...queued.data, facility_id: 'ae6775bb3c8b6d9899c47cc6e2bb9259' } } as any, { recipe, position: () => 'the_obsidian_well' })
  // snapshot-clock guard: a completion OLDER than the station's last view is already in that view
  const stale = applyStorageEvents('p-craft', [{ event_id: 707, created_at: new Date(t - 5_000).toISOString(), category: 'crafting', event_type: 'crafting.completed',
    data: { direction: 'forward', facility_id: fac, job_id: 'job0', recipe_id: 'carapace_plating', runs: 1, storage: 'station' } }], { recipe })
  out.crafting = { q, done, cancel, stale, faction, unknown, priv: priv.effects, facilityStation: [facilityStation(fac), facilityStation('ae6775bb3c8b6d9899c47cc6e2bb9259')],
    carapace: getStorageQuantity('p-craft', STATION, 'creature_carapace'), plating: getStorageQuantity('p-craft', STATION, 'carapace_plating'), ledger: ledgerOf('p-craft') }
}

// ── 9. exchange fills: spot fills are the command hook's (buy says delivered_to_storage); order fills place at the order's station ──
{
  const spot = storageEffects('p-misc', { event_id: 801, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.exchange_fill',
    data: { base_id: 'the_rampart_checkpoint', item_id: 'processing_core', price: 2137, quantity: 4, role: 'buyer', source: 'spot', total: 8548 } })
  const order = storageEffects('p-misc', { event_id: 802, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.exchange_fill',
    data: { item_id: 'fluorine_gas', price: 80, quantity: 5, role: 'buyer', total: 400 } }, { buyOrderStations: () => ['grand_exchange_station'] })
  const ambiguous = storageEffects('p-misc', { event_id: 803, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.exchange_fill',
    data: { item_id: 'fluorine_gas', price: 80, quantity: 5, role: 'buyer', total: 400 } }, { buyOrderStations: () => ['a', 'b'] })
  const sellerFill = storageEffects('p-misc', { event_id: 804, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.exchange_fill',
    data: { item_id: 'carbon_ore', price: 2, quantity: 20, role: 'seller', total: 40 } })
  const cancelled = storageEffects('p-misc', { event_id: 805, created_at: new Date().toISOString(), category: 'trading', event_type: 'trading.order_cancelled',
    data: { item_id: 'vanadium_ore', order_id: 'o1', order_type: 'sell', quantity: 48 } }, { orderStation: () => 'nova_terra_central' })
  out.fills = { spot: spot.effects, order: order.effects, ambiguous: [ambiguous.effects.map(e => e.confidence), ambiguous.dirty], sellerFill: sellerFill.effects, cancelled: cancelled.effects }
}

// ── 10. the other command hooks: buy delivered_to_storage, switch_ship cargo_to_storage, craft escrow, create_sell_order from_storage, install_mod ignored ──
{
  const buy = recordStorageMutationFromCommand('buy', { item_id: 'steel_plate', quantity: 8 }, { action: 'buy', item_id: 'steel_plate', quantity: 8, total_cost: 16000, fills: [], level_up: false, delivered_to_cargo: 5, delivered_to_storage: 3 }, { profileId: 'p-misc', station: STATION })
  const buyCargo = recordStorageMutationFromCommand('buy', { item_id: 'steel_plate', quantity: 2 }, { action: 'buy', item_id: 'steel_plate', quantity: 2, total_cost: 4000, fills: [], level_up: false, delivered_to_cargo: 2 }, { profileId: 'p-misc', station: STATION })
  const sw = recordStorageMutationFromCommand('switch_ship', { ship_id: 'abc' }, { result: { command: 'switch_ship', tick: 5, details: { message: 'ok', active_ship_id: 'abc', active_ship_class: 'gauntlet', stored_ship_id: 'def', stored_ship_class: 'prospect',
    cargo_to_storage: [{ item_id: 'weapon_housing', name: 'Weapon Housing', quantity: 7 }] } } }, { profileId: 'p-misc', station: STATION })
  const craft = recordStorageMutationFromCommand('craft', { recipe_id: 'carapace_plating', quantity: 2 }, { cargo: [], location: LOCATION, details: { action: 'craft', kind: 'job', job_id: 'j9', facility_id: 'workshop:x:crimson_war_citadel', recipe: 'Carapace Plating', runs: 2, mode: 'craft', venue: 'Station Workshop', venue_type: 'workshop', effective_time_per_run: 10, est_completion_tick: 99, message: 'queued',
    escrowed: { inputs: [{ item_id: 'creature_carapace', name: 'Creature Carapace', quantity: 4 }], fee: 0, labor: 0 } } }, { profileId: 'p-misc', station: STATION })
  const sell = recordStorageMutationFromCommand('create_sell_order', { item_id: 'vanadium_ore', quantity: 100, price_each: 5 }, { action: 'create_sell_order', kind: 'single', item: 'Vanadium Ore', item_id: 'vanadium_ore', quantity: 100, price_each: 5, listing_fee: 5, message: 'listed', from_cargo: 60, from_storage: 40 }, { profileId: 'p-misc', station: STATION })
  const mod = recordStorageMutationFromCommand('install_mod', { module_id: 'mining_laser_i' }, { message: 'installed', module_id: 'mining_laser_i', quality: 1, quality_grade: 'A', cpu_used: 4, power_used: 10 }, { profileId: 'p-misc', station: STATION })
  const supply = recordStorageMutationFromCommand('supply_commission', { commission_id: 'c1', item_id: 'circuit_board', quantity: 35 }, { all_sourced: false, commission_id: 'c1', commission_status: 'sourcing', item_id: 'circuit_board', item_name: 'Circuit Board', materials: [], message: 'ok', supplied: 35 }, { profileId: 'p-misc', station: STATION })
  const undocked = recordStorageMutationFromCommand('deposit', { item_id: 'iron_ore', quantity: 3 }, { action: 'deposit_items', item_id: 'iron_ore', quantity: 3, storage_total: 3, cargo_remaining: 0, cargo_space: 1 }, { profileId: 'p-misc', station: null })
  const errored = recordStorageMutationFromCommand('deposit', { item_id: 'iron_ore', quantity: 3 }, { error: { code: 'not_docked', message: 'no' } }, { profileId: 'p-misc', station: STATION })
  out.hooks = { buy: buy.rows, buyCargo: buyCargo.rows, sw: sw.rows, craft: craft.rows, sell: sell.rows, mod: mod.rows, supplyDirty: supply.dirty, undocked: { rows: undocked.rows, dirty: undocked.dirty }, errored: errored.rows,
    steel: getStorageQuantity('p-misc', STATION, 'steel_plate'), housing: getStorageQuantity('p-misc', STATION, 'weapon_housing'), carapace: getStorageQuantity('p-misc', STATION, 'creature_carapace'),
    vanadium: getStorageQuantity('p-misc', STATION, 'vanadium_ore'), ledger: ledgerOf('p-misc') }
}

// ── 11. ingestActionLog end to end: a cold category is banked only; the next (warm) page is applied inside the insert transaction ──
{
  recordPosition('p-ingest', STATION)
  let page = 0
  const pages: Array<Array<Record<string, unknown>>> = [
    [{ id: 1, created_at: new Date(Date.now() - 120_000).toISOString(), event_type: 'storage.deposit_items', data: { item_id: 'old_ore', quantity: 99 } }],
    [{ id: 2, created_at: new Date().toISOString(), event_type: 'storage.deposit_items', data: { item_id: 'new_ore', quantity: 7 } }],
  ]
  const c = { mode: 'lib_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {}, getLocalState: () => ({ location: LOCATION }),
    execute: async (cmd: string, args?: any) => {
      if (cmd !== 'get_action_log') return { result: 'ok' }
      if (args?.category !== 'storage') return { structuredContent: { entries: [], has_more: false } }
      const entries = pages[page] ?? []
      return { structuredContent: { entries: args?.since_id ? entries.filter(e => Number(e.id) > Number(args.since_id)) : entries, has_more: false } }
    } } as any
  const first = await ingestActionLog('p-ingest', c)
  page = 1
  const second = await ingestActionLog('p-ingest', c)
  const third = await ingestActionLog('p-ingest', c)   // same page again: INSERT OR IGNORE, nothing applied twice
  out.ingest = { first: { added: first.added, storage: first.storage }, second: { added: second.added, storage: second.storage }, third: { added: third.added, storage: third.storage },
    oldOre: getStorageQuantity('p-ingest', STATION, 'old_ore'), newOre: getStorageQuantity('p-ingest', STATION, 'new_ore'), ledger: ledgerOf('p-ingest') }
}

// ── 12. schema: the migration added observed_at and the versioned step recorded itself ──
{
  const ro = new Database(path.join(workspace, 'data', 'admiral.db'), { readonly: true })
  out.schema = {
    cols: (ro.query('PRAGMA table_info(storage_inventory)').all() as Array<{ name: string }>).map(c => c.name),
    tables: (ro.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('storage_ledger','storage_snapshots','position_history') ORDER BY name").all() as Array<{ name: string }>).map(t => t.name),
    migrated: (ro.query('SELECT version FROM schema_migrations WHERE version = 7').get() as { version: number } | null)?.version ?? null,
  }
  ro.close()
}
out.logs = logs.filter(l => l.includes('storage reconciled') || l.includes('ledger:'))
console.log('__RESULT__' + JSON.stringify(out))
