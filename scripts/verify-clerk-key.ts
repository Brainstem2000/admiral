/**
 * Phase 4 pre-check: does the SPACEMOLT_CLERK_API_KEY env var see our agents?
 *
 * Lists the players the key owns and diffs against the profiles in admiral.db.
 * Read-only; never prints the key.
 *
 * Usage: bun run scripts/verify-clerk-key.ts
 */
import { Database } from 'bun:sqlite'
import { SpacemoltClient } from '@spacemolt/lib'

const apiKey = process.env.SPACEMOLT_CLERK_API_KEY
if (!apiKey) {
  console.error('SPACEMOLT_CLERK_API_KEY is not set in this environment.')
  process.exit(1)
}
console.log(`key present (${apiKey.length} chars, not shown)`)

const db = new Database('data/admiral.db', { readonly: true })
const profiles = db
  .query<{ name: string; username: string; player_id: string | null }, []>(
    `SELECT name, username, player_id FROM profiles ORDER BY name`,
  )
  .all()
db.close()

const client = new SpacemoltClient({ clerkApiKey: apiKey })
const owned = await client.listOwnedPlayers()
console.log(`\nClerk key owns ${owned.length} player(s):`)
for (const p of owned) console.log(`  ${p.username}  (id=${p.id}, empire=${p.empire}${p.hidden ? ', hidden' : ''})`)

console.log(`\nAdmiral profiles vs owned players:`)
const ownedByName = new Map(owned.map((p) => [p.username.toLowerCase(), p]))
const ownedById = new Map(owned.map((p) => [p.id, p]))
let matched = 0
for (const prof of profiles) {
  const hit = ownedByName.get(prof.username.toLowerCase()) ?? (prof.player_id ? ownedById.get(prof.player_id) : undefined)
  console.log(`  ${hit ? 'MATCH  ' : 'MISSING'} ${prof.name} (username: ${prof.username})`)
  if (hit) matched++
}
console.log(`\n${matched}/${profiles.length} Admiral profiles are owned by this key.`)
process.exit(0)
