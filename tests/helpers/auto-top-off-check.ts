/**
 * Subprocess helper for auto-top-off.test.ts. Fresh process + chdir before import
 * = an isolated database (see nav-intel-check.ts). Prints one __RESULT__<json> line.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs')
const { getDb, setPreference } = await import('../../src/server/lib/db')
const { executeTool } = await import('../../src/server/lib/tools')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}

type RefuelBehaviour = { ok: true; fuel: number; cost: number } | { ok: false; code: string }

function stubConnection(refuel: RefuelBehaviour, calls: string[], shipFuel: { fuel: number; max: number }) {
  return {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'zosma', system_name: 'Zosma', docked_at: null },
      ship: { fuel: shipFuel.fuel, max_fuel: shipFuel.max },
      player: { credits: 50_000 },
    }),
    execute: async (command: string) => {
      calls.push(command)
      if (command === 'dock') return { result: { action: 'dock', base: 'Hex Wellspring', story: 'You dock.' } }
      if (command === 'refuel') {
        return refuel.ok
          ? { result: { action: 'refuel', source: 'station', fuel: refuel.fuel, cost: refuel.cost, credits: 50_000 - refuel.cost } }
          : { error: { code: refuel.code, message: `refuel failed: ${refuel.code}` } }
      }
      return { result: 'ok' }
    },
  } as any
}

async function scenario(pid: string, refuel: RefuelBehaviour, shipFuel: { fuel: number; max: number }) {
  const calls: string[] = []
  const logs: string[] = []
  const ctx = {
    connection: stubConnection(refuel, calls, shipFuel),
    profileId: pid, profileName: 'Test Hunter',
    log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) },
    todo: '', memory: '',
  } as any
  const out = await executeTool('game', { command: 'dock' }, ctx)
  const ledger = db.query('SELECT kind, quantity, amount_signed FROM financial_ledger WHERE profile_id = ? ORDER BY id').all(pid) as Array<Record<string, unknown>>
  // The briefing collector refreshes (get_nearby/get_system/get_ship) after any
  // action; only the mutations are under test here.
  const actions = calls.filter(c => c === 'dock' || c === 'refuel')
  return { calls: actions, allCalls: calls, note: String(out), logs: logs.filter(l => l.startsWith('system:')), ledger }
}

/**
 * The goto_system macro docks and tops off on its own. Its refuel used to go
 * through macroAction, which books nothing, so the 90cr top-up at War Citadel
 * on 2026-09-12 01:18Z left no fuel row and the NEXT command (complete_mission)
 * was booked as a -90 mission_reward when the wallet echo did not match the
 * last anchored balance. Sequence here: a manual dock anchors the balance, the
 * macro dock tops off again (90cr), then a mission completes with the wallet
 * unchanged since — the ledger must show two fuel rows and nothing else.
 */
async function macroScenario(pid: string) {
  const calls: string[] = []
  const logs: string[] = []
  let credits = 50_000
  const tops = [{ fuel: 143, cost: 286 }, { fuel: 15, cost: 90 }]
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: 'zosma', system_name: 'Zosma', docked_at: null, poi_id: 'zosma_star' },
      ship: { fuel: 207, max_fuel: 350 },
      player: { credits },
    }),
    execute: async (command: string) => {
      calls.push(command)
      if (command === 'dock') return { result: { action: 'dock', base: 'Hex Wellspring', story: 'You dock.' } }
      if (command === 'refuel') {
        const t = tops.shift() ?? { fuel: 0, cost: 0 }
        credits -= t.cost
        return { result: { action: 'refuel', source: 'station', fuel: t.fuel, cost: t.cost, credits } }
      }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: pid, profileName: 'Test Hunter', log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) }, todo: '', memory: '' } as any
  await executeTool('game', { command: 'dock' }, ctx)                                                   // anchors the balance at 49,714
  const out = await executeTool('goto_system', { target_system: 'zosma', dock_at_poi: 'hex_wellspring' }, ctx)  // macro dock + top-off (90cr)
  const { bookLedgerFromCommand } = await import('../../src/server/lib/tools')
  bookLedgerFromCommand('complete_mission', { id: 'm1' }, { player: { credits }, mission: { title: 'Grazer Cull' } }, 'Completed mission', pid, 'Test Hunter')
  const ledger = db.query('SELECT kind, quantity, amount_signed, balance_after, source_command FROM financial_ledger WHERE profile_id = ? ORDER BY id').all(pid) as Array<Record<string, unknown>>
  return { out: String(out), calls: calls.filter(c => ['dock', 'travel', 'refuel'].includes(c)), logs: logs.filter(l => l.startsWith('system:')), ledger, credits }
}

const basic = await scenario('p-topoff-basic', { ok: true, fuel: 143, cost: 286 }, { fuel: 207, max: 350 })
const macro = await macroScenario('p-topoff-macro')
const full = await scenario('p-topoff-full', { ok: true, fuel: 0, cost: 0 }, { fuel: 350, max: 350 })
const empty = await scenario('p-topoff-empty', { ok: false, code: 'station_fuel_empty' }, { fuel: 207, max: 350 })
setPreference('auto_top_off', 'off')
const off = await scenario('p-topoff-off', { ok: true, fuel: 143, cost: 286 }, { fuel: 207, max: 350 })
setPreference('auto_top_off', '')

console.log('__RESULT__' + JSON.stringify({ basic, full, empty, off, macro }))
