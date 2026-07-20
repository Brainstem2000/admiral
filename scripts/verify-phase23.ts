/**
 * Phase 2+3 verification (no LLM involved).
 *
 * Connects Grit via LibV2Connection, then:
 *  - Phase 2: refreshBriefingData uses getLocalState (status/cargo/missions with
 *    zero round-trips) and buildSituationalBriefing renders from it.
 *  - Phase 3: macro tools run through executeTool with harmless cases:
 *      goto_system(current system)  -> "already in" (no actions)
 *      sell_cargo (empty cargo)     -> "nothing to sell" (no actions)
 *      mine_until_full at a station -> bounded error abort (1 failed action)
 *
 * Usage: bun run scripts/verify-phase23.ts
 */
import { Database } from 'bun:sqlite'
import { LibV2Connection } from '../src/server/lib/connections/lib_v2'
import { refreshBriefingData, buildSituationalBriefing } from '../src/server/lib/briefing'
import { executeTool } from '../src/server/lib/tools'

const db = new Database('data/admiral.db', { readonly: true })
const row = db
  .query<{ id: string; name: string; username: string; password: string; server_url: string }, []>(
    `SELECT id, name, username, password, server_url FROM profiles WHERE name LIKE '%Grit%' LIMIT 1`,
  )
  .get()
db.close()
if (!row) { console.error('no Grit profile'); process.exit(1) }

let pass = true
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) pass = false
}

const conn = new LibV2Connection(row.server_url || 'https://game.spacemolt.com')
await conn.connect()
const login = await conn.login(row.username, row.password)
check('lib_v2 connect+login', login.success, login.error)

// ── Phase 2: local state + briefing fast path ──
const local = conn.getLocalState?.()
check('getLocalState returns snapshot', !!local && typeof local === 'object' && 'player' in (local as object),
  local ? `credits=${(local.player as Record<string, unknown>)?.credits} pending=${local.has_pending_action}` : 'null')

await refreshBriefingData(row.id, conn)
const briefing = buildSituationalBriefing(row.id)
check('briefing built from local state', briefing.length > 0 && briefing.includes('Wallet'),
  briefing.split('\n').slice(0, 3).join(' | '))

// ── Phase 3: macro tools through executeTool ──
const ctx = {
  connection: conn,
  profileId: row.id,
  profileName: row.name,
  log: (type: string, summary: string) => console.log(`   [log:${type}] ${summary.slice(0, 110)}`),
  todo: '',
  memory: '',
}

const state = conn.getLocalState?.() ?? {}
const systemId = ((state.location as Record<string, unknown>)?.system_id ?? '?') as string
console.log(`\n-- goto_system to CURRENT system (${systemId}) — expect no-op --`)
const goto1 = await executeTool('goto_system', { target_system: systemId }, ctx)
check('goto_system no-op', goto1.includes('already in'), goto1.slice(0, 100))

console.log('\n-- sell_cargo — expect empty-cargo no-op or per-item report --')
const sell1 = await executeTool('sell_cargo', { exclude: ['iron_ore', 'titanium_ore'] }, ctx)
check('sell_cargo bounded', sell1.startsWith('sell_cargo DONE') || sell1.startsWith('MACRO ABORT'), sell1.split('\n')[0])

console.log('\n-- mine_until_full at a station — expect bounded abort/error --')
const mine1 = await executeTool('mine_until_full', { max_mines: 2 }, ctx)
check('mine_until_full bounded', mine1.includes('DONE') || mine1.includes('ABORT'), mine1.slice(0, 140))

await conn.disconnect()
console.log(`\n${pass ? 'VERIFY PASS' : 'VERIFY FAIL'}`)
process.exit(pass ? 0 : 1)
