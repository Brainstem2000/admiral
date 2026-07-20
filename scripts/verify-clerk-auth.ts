/**
 * Phase 4 verification: LibV2Connection authenticates via the Clerk API key
 * with NO password — proving the stored plaintext password is no longer needed
 * for lib_v2 auth. Requires SPACEMOLT_CLERK_API_KEY in the environment.
 *
 * Usage: bun run scripts/verify-clerk-auth.ts
 */
import { LibV2Connection } from '../src/server/lib/connections/lib_v2'

if (!process.env.SPACEMOLT_CLERK_API_KEY) {
  console.error('SPACEMOLT_CLERK_API_KEY not set'); process.exit(1)
}

const conn = new LibV2Connection('https://game.spacemolt.com')
await conn.connect()
// Empty password: only the clerk path can succeed.
const login = await conn.login('Grit Vane', '')
console.log(`login via clerk (no password): success=${login.success} player_id=${login.player_id ?? '?'} ${login.error ?? ''}`)

if (login.success) {
  const state = conn.getLocalState?.()
  const player = (state?.player ?? {}) as Record<string, unknown>
  console.log(`state cache: credits=${player.credits} authenticated=${conn.isConnected()}`)
  const resp = await conn.execute('get_status')
  console.log(`get_status: ${resp.error ? `ERROR ${resp.error.code}` : 'OK'}`)
}
await conn.disconnect()
console.log(login.success ? 'CLERK AUTH PASS' : 'CLERK AUTH FAIL')
process.exit(login.success ? 0 : 1)
