/**
 * Phase 0 smoke test for @spacemolt/lib (spacemolt-lib adoption evaluation).
 *
 * Logs in ONE account via the raw username/password path, verifies:
 *   1. connect + auth
 *   2. local state cache seeded (credits/location/cargo readable with no round-trip)
 *   3. a typed query (get_status / find_route)
 *   4. push-event subscription wiring
 * then disconnects. Read-only: no mutations are issued.
 *
 * Usage: bun run scripts/smoke-lib.ts <profile-name-substring>
 * Credentials come from data/admiral.db; nothing secret is printed.
 */
import { Database } from 'bun:sqlite'
import { Account, GENERATED_SPEC_VERSION, ACTIONS } from '@spacemolt/lib'

const nameFilter = process.argv[2] || 'Grit'

const db = new Database('data/admiral.db', { readonly: true })
const row = db
  .query<{ name: string; username: string; password: string }, [string]>(
    `SELECT name, username, password FROM profiles WHERE name LIKE '%' || ? || '%' LIMIT 1`,
  )
  .get(nameFilter)
db.close()

if (!row) {
  console.error(`no profile matching "${nameFilter}"`)
  process.exit(1)
}
console.log(`[0] profile: ${row.name} (username: ${row.username})`)
console.log(`[0] lib spec version: ${GENERATED_SPEC_VERSION}, actions in catalog: ${Object.keys(ACTIONS).length}`)

const account = new Account({ url: 'wss://game.spacemolt.com/ws/v2' })

let pass = true
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) pass = false
}

try {
  await account.connect()
  check('connect', true)

  await account.login({ username: row.username, password: row.password })
  check('auth (login)', true)

  // 2. Local state cache — should be seeded from get_status after auth
  const credits = account.credits
  const system = account.location?.system_id
  const cargoCount = (account.cargo ?? []).length
  check('state cache seeded', credits !== undefined && system !== undefined,
    `credits=${credits} system=${system} cargoItems=${cargoCount} docked=${account.location?.docked_at ?? 'no'}`)

  // 3. Typed query — get_status round-trip
  const status = await account.commands.spacemolt.get_status()
  const sc = status.structuredContent
  check('typed query get_status', sc?.player?.credits !== undefined,
    `server credits=${sc?.player?.credits} matches cache=${sc?.player?.credits === credits}`)

  // 3b. Second typed query with params — find_route (read-only)
  const route = await account.commands.spacemolt.find_route({ id: 'sol' })
  check('typed query find_route', route.structuredContent !== undefined,
    `found=${route.structuredContent?.found} hops=${route.structuredContent?.route?.length ?? 0}`)

  // 4. Push-event wiring — subscribe and confirm no throw (events may or may not arrive in window)
  let anyEvent = 0
  const off = account.onAny(() => { anyEvent++ })
  await new Promise((r) => setTimeout(r, 3000))
  off()
  check('event wiring', true, `${anyEvent} push frames in 3s window`)
} catch (err) {
  check('smoke', false, err instanceof Error ? err.message : String(err))
} finally {
  account.close()
  console.log(`\n${pass ? 'SMOKE PASS' : 'SMOKE FAIL'}`)
  process.exit(pass ? 0 : 1)
}
