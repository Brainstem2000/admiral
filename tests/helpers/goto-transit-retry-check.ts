/**
 * Subprocess helper for goto-transit-retry.test.ts. Fresh process + chdir before
 * import = an isolated database. Prints one __RESULT__<json> line.
 *
 * find_route answers `no_current_system` while a jump is still resolving (the
 * server has no origin to plot from). The macro must wait for arrival and ask
 * again rather than abort — Ledger Voss and Morg'Thar both aborted on it within
 * a minute of each other on 2026-09-12 04:19 CT, right after a WebSocket blip.
 */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs')
const { getDb } = await import('../../src/server/lib/db')
const { executeTool, gotoMacroTuning } = await import('../../src/server/lib/tools')
const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) throw new Error(`db opened outside the temp workspace: ${opened}`)
gotoMacroTuning.transitWaitMs = 5   // no real sleeping in tests

function scenario(pid: string, transitAnswers: number) {
  const calls: string[] = []
  const logs: string[] = []
  let routeCalls = 0
  let systemId: string | null = null   // unknown while mid-jump
  const conn = {
    mode: 'lib_v2',
    isConnected: () => true,
    supportsNotifications: () => false,
    onNotification: () => {},
    getLocalState: () => ({
      location: { system_id: systemId, system_name: systemId, docked_at: null, poi_id: null },
      ship: { fuel: 120, max_fuel: 180, cargo_used: 10, cargo_capacity: 450 },
      player: { credits: 1_000 },
    }),
    execute: async (command: string, args?: Record<string, unknown>) => {
      calls.push(command)
      if (command === 'find_route') {
        routeCalls++
        if (routeCalls <= transitAnswers) return { error: { code: 'no_current_system', message: 'No current system' } }
        systemId = 'epsilon_eridani'   // the jump landed while we waited
        return { result: { found: true, estimated_fuel: 4, fuel_available: 120, fuel_per_jump: 4, message: 'Route found: 1 jump(s).',
          route: [{ jumps: 0, system_id: 'epsilon_eridani', name: 'Epsilon Eridani' }, { jumps: 1, system_id: 'markab', name: 'Markab' }] } }
      }
      if (command === 'jump') { systemId = String(args?.target_system ?? ''); return { result: { action: 'jump', destination: systemId } } }
      return { result: 'ok' }
    },
  } as any
  const ctx = { connection: conn, profileId: pid, profileName: 'Test Miner', log: (type: string, summary: string) => { logs.push(`${type}:${summary}`) }, todo: '', memory: '' } as any
  return executeTool('goto_system', { target_system: 'markab' }, ctx).then((out) => ({ out: String(out), routeCalls, jumps: calls.filter((c) => c === 'jump').length, waits: logs.filter((l) => l.includes('mid-jump')).length }))
}

const arrives = await scenario('p-transit-arrives', 2)     // two "mid-jump" answers, then a route
const stuck = await scenario('p-transit-stuck', 99)        // never resolves within the retry budget
console.log('__RESULT__' + JSON.stringify({ arrives, stuck }))
