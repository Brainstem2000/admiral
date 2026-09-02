/**
 * Subprocess helper for the rental-lapse tests (see rental-obligation-lapse.test.ts).
 * Fresh process + chdir before import = isolated database (see nav-intel-check.ts).
 * Prints one __RESULT__<json> line for the parent to assert on.
 */
import type { Profile } from '../../src/shared/types'

const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)

const fs = await import('node:fs')
const {
  getDb, createProfile, recordObligations, listObligations, listActiveObligations,
  markObligationLapsed, markAllRentLapsed,
} = await import('../../src/server/lib/db')
const { FleetIntelCollector } = await import('../../src/server/lib/fleet-intel')
const { __setStationsFeedForTests } = await import('../../src/server/lib/stations-feed')
__setStationsFeedForTests(null) // keep the network out of it

const db = getDb()
const opened = fs.realpathSync((db as unknown as { filename: string }).filename)
if (!opened.startsWith(fs.realpathSync(workspace))) {
  throw new Error(`db opened outside the temp workspace: ${opened}`)
}

const NAME = "Morg'Thar - Hunter"
const profile: Omit<Profile, 'created_at' | 'updated_at'> = {
  id: 'morg', name: NAME, username: null, password: null, empire: '', player_id: null,
  provider: 'claude-max', model: 'claude-sonnet-4-5',
  planner_provider: 'claude-max', planner_model: 'claude-opus-4-8', planning_interval: 5,
  codex_executor_enabled: false, codex_executor_model: null,
  codex_planner_enabled: false, codex_planner_model: null,
  directive: '', todo: '', memory: '', context_budget: null,
  connection_mode: 'mcp_v2', server_url: 'https://game.spacemolt.com',
  autoconnect: false, enabled: true, sort_order: 0, group_name: '',
}
createProfile(profile)

const ev = (id: number, type: string, data: Record<string, unknown>, at: string) =>
  ({ event_id: id, created_at: at, category: 'other', event_type: type, data })
const rent = (id: number, base: string, facility: string, cost: number, at: string) =>
  ev(id, 'other.rent_paid', { base_id: base, facility, cost }, at)

const snap = () => listObligations('morg').map(o => `${o.obligation_type}:${o.facility || o.station_id}:${o.status}`).sort()
const active = () => listActiveObligations('morg').map(o => `${o.obligation_type}:${o.facility || o.station_id}`).sort()
const owned = (payload: unknown, command = 'facility_owned', who = NAME) =>
  FleetIntelCollector.processCommandResult(command, payload, who)

const out: Record<string, unknown> = {}

recordObligations('morg', [
  // The phantom: a foundry last billed on 2026-08-06 and never since.
  rent(1, 'confed_cc', 'lithium_cell_foundry', 433, '2026-08-06 10:00:00'),
  rent(2, 'starfall', 'crew_bunk', 15, '2026-09-01 10:00:00'),
  rent(3, 'starfall', 'ledger_desk', 20, '2026-09-01 10:00:00'),
  ev(4, 'tax.property_paid', { empire: 'solarian', paid: 100 }, '2026-09-01 10:00:00'),
])
out.initial = { all: snap(), active: active() }

// Age alone never lapses anything: a month-old row is still active until the game says otherwise.
out.lapsedOne = markObligationLapsed('morg', 'lithium_cell_foundry')
out.afterOne = { all: snap(), active: active() }
out.lapsedAgain = markObligationLapsed('morg', 'lithium_cell_foundry')

// The game enumerates starfall with only the bunk: the desk lapses, the bunk stays,
// and confed_cc (not enumerated) is untouched.
owned({ facilities: [{ base_id: 'starfall', type: 'crew_bunk', name: 'Crew Bunk' }] })
out.afterPartial = snap()

// A fresh rent bill revives a lapsed row.
recordObligations('morg', [rent(5, 'starfall', 'ledger_desk', 20, '2026-09-02 10:00:00')])
out.afterRevive = snap()

// "You own nothing" — in the action-argument spelling — lapses every rent row, taxes untouched.
owned({ action: 'owned', facilities: [] }, 'facility')
out.afterEmpty = { all: snap(), active: active() }

// A shape we do not understand must not lapse anything...
recordObligations('morg', [rent(6, 'starfall', 'crew_bunk', 15, '2026-09-02 11:00:00')])
owned({ message: 'no data' })
out.afterUnknownShape = snap()
// ...and neither may an answer from a name that is not a profile.
owned({ facilities: [] }, 'facility_owned', 'Nobody')
out.afterUnknownReporter = snap()

out.markAll = markAllRentLapsed('morg')
out.final = { all: snap(), active: active() }

console.log('__RESULT__' + JSON.stringify(out))
