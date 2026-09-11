/**
 * Subprocess helper for deposit-quantity-guard.test.ts. Fresh process + chdir
 * before import = an isolated database (db.ts binds DB_PATH from cwd at module
 * load), so the profiles this seeds and anything the result path records never
 * touch data/admiral.db. The catalog cache is copied in so codexGet resolves
 * item sizes without network. Prints one __RESULT__<json> line.
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
const { getDb, createProfile } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const { startCatalogService, codexGet } = await import('../../src/server/lib/catalog')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}
startCatalogService()

const STATION = 'crimson_war_citadel'
const LOCATION = { system_id: 'krynn', system_name: 'Krynn', poi_id: 'war_citadel', docked_at: STATION }

/** The envelope CyberSpock received three times on 2026-09-10, verbatim in shape. */
function failedEnvelope(itemId: string, asked: number, held: number) {
  return {
    cargo: [{ item_id: itemId, quantity: held, size: 2 }],
    location: LOCATION,
    details: {
      action: 'bulk_deposit', target: 'self', requested: 1, succeeded: 0, failed: 1,
      results: [{ item_id: itemId, quantity: asked, success: false, error: 'insufficient_cargo',
        message: `You only have ${held} x ${itemId} in cargo.` }],
    },
  }
}

function successEnvelope(lines: Array<{ item_id: string; quantity: number }>, action = 'bulk_deposit') {
  return {
    cargo: [{ item_id: 'iron_ore', quantity: 12, size: 1 }],
    location: LOCATION,
    details: {
      action, target: 'self', requested: lines.length, succeeded: lines.length, failed: 0,
      results: lines.map((l) => ({ ...l, success: true })),
    },
  }
}

type Cargo = Array<{ item_id: string; quantity: number; size?: number }> | undefined
type Reply = (cmd: string, args: any) => any

let n = 0
/** A fake lib_v2 connection whose live state carries `cargo` (or not), answering deposits with `reply`. */
function harness(cargo: Cargo, reply: Reply) {
  const calls: Array<{ cmd: string; args: any }> = []
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: LOCATION,
      ship: { hull: 100, max_hull: 100, fuel: 100, max_fuel: 130, cargo_used: 360, cargo_capacity: 400 },
      player: { credits: 5000 },
      ...(cargo ? { cargo } : {}),
    }),
    execute: async (cmd: string, args?: any) => {
      // Snapshot the args at call time: the guard mutates the object it was handed.
      calls.push({ cmd, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) })
      return reply(cmd, args)
    },
  } as any
  const id = `p-deposit-clamp-${++n}`
  createProfile({
    id, name: `Deposit Clamp Test ${n}`, username: '', password: '', empire: 'crimson', player_id: '',
    provider: 'manual', model: '', planner_provider: null, planner_model: null, planning_interval: null,
    codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '',
    directive: '', todo: '', memory: '', connection_mode: 'lib_v2', server_url: '', autoconnect: false, enabled: true,
    context_budget: null, sort_order: 0, group_name: '',
  } as any)
  const logs: string[] = []
  const ctx = {
    connection: conn, profileId: id, profileName: 'Test', todo: '', memory: '',
    log: (type: string, summary: string) => { logs.push(`${type}: ${summary}`) },
  } as any
  return { ctx, calls, logs }
}

const okReply: Reply = (cmd, args) => {
  if (cmd === 'deposit_items' || cmd === 'deposit' || cmd === 'faction_deposit_items') {
    const lines = Array.isArray(args?.items) ? args.items : [{ item_id: args?.item_id, quantity: args?.quantity }]
    return { result: successEnvelope(lines) }
  }
  return { result: 'ok' }
}

async function run(cargo: Cargo, reply: Reply, command: string, args: Record<string, unknown>, repeat = 1) {
  const { ctx, calls, logs } = harness(cargo, reply)
  let out = ''
  for (let i = 0; i < repeat; i++) {
    out = String(await executeTool('game', { command, args: JSON.parse(JSON.stringify(args)) }, ctx))
  }
  const sent = calls.filter((c) => c.cmd === command).map((c) => c.args)
  return { out, sent, logs: logs.filter((l) => l.includes('[deposit-clamp]')) }
}

const HELD = [{ item_id: 'uranium_ore', quantity: 180, size: 2 }, { item_id: 'iron_ore', quantity: 12, size: 1 }]

const result = {
  catalogSize: (codexGet('item', 'uranium_ore') as any)?.size ?? null,

  // The incident: 360 asked (the cargo-unit figure), 180 held.
  clampBulk: await run(HELD, okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 360 }] }),
  clampSingle: await run(HELD, okReply, 'deposit', { item_id: 'uranium_ore', quantity: 360 }),
  clampFactionForm: await run(HELD, okReply, 'faction_deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 360 }] }),

  // An exact or under-ask is left alone — no note, nothing rewritten.
  exactAsk: await run(HELD, okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 180 }] }),

  // The hold has none of the item: refused locally, no round trip.
  blockedMissing: await run([{ item_id: 'iron_ore', quantity: 50 }], okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 100 }] }),
  blockedSingle: await run([{ item_id: 'iron_ore', quantity: 50 }], okReply, 'deposit', { item_id: 'uranium_ore', quantity: 100 }),
  // The same call straight back after a refusal is handed to the game (a cache
  // can be wrong; a guard that traps an agent is worse than a spent tick).
  blockedThenPassthrough: await run([{ item_id: 'iron_ore', quantity: 50 }], okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 100 }] }, 2),

  // Bulk with one present and one absent line: the absent one is dropped, the rest goes.
  partialBulk: await run(HELD, okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 100 }, { item_id: 'gold_ore', quantity: 5 }] }),

  // Not from cargo: the hold is irrelevant and must not be consulted.
  sourceStorage: await run([{ item_id: 'iron_ore', quantity: 50 }], okReply, 'deposit', { item_id: 'uranium_ore', quantity: 100, source: 'storage', target: 'faction' }),
  creditGift: await run([{ item_id: 'iron_ore', quantity: 50 }], okReply, 'deposit', { credits: 500, target: 'faction' }),

  // No live cargo array at all: the call goes out unchanged and the game's
  // buried failure is lifted to the first line.
  noLiveCargoFailure: await run(undefined, () => ({ result: failedEnvelope('uranium_ore', 360, 180) }), 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 360 }] }),
  // The DB cargo snapshot is empty for this brand-new profile; that must never block.
  noLiveCargoSuccess: await run(undefined, okReply, 'deposit_items', { items: [{ item_id: 'uranium_ore', quantity: 180 }] }),

  // A withdraw envelope gets the WITHDRAW verb.
  withdrawFailure: await run(undefined, () => ({ result: {
    cargo: [], location: LOCATION,
    details: { action: 'bulk_withdraw', target: 'self', requested: 2, succeeded: 1, failed: 1,
      results: [{ item_id: 'iron_ore', quantity: 5, success: true },
                { item_id: 'uranium_ore', quantity: 50, success: false, error: 'insufficient_storage', message: 'You only have 20 x uranium_ore in storage.' }] },
  } }), 'withdraw_items', { items: [{ item_id: 'iron_ore', quantity: 5 }, { item_id: 'uranium_ore', quantity: 50 }] }),

  // The single-item form fails as a real error; the hint names the unit.
  singleFormError: await run(undefined, () => ({ error: { code: 'insufficient_cargo', message: 'You only have 180 x uranium_ore in cargo.' } }), 'deposit', { item_id: 'uranium_ore', quantity: 360 }),
}
console.log('__RESULT__' + JSON.stringify(result))
