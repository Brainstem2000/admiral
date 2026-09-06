/**
 * build-progress — how close the fleet actually is to a hull's gather list.
 *
 *   bun scripts/build-progress.ts [uranium_ore=882 fluorine_gas=148 ...]
 *
 * Counts BOTH personal station storage (the `storage_inventory` table) and
 * FACTION storage, which is not persisted anywhere — the Vault page reads it
 * live through an agent, so a query is the only way to see it.
 *
 * That gap made the overnight tracker report a flat line. On 2026-09-06
 * CyberSpock deposited 44 fluorine_gas into faction storage at Crimson War
 * Citadel — exactly where the orders said to put it — and the monitor kept
 * printing 11, because `storage_inventory` holds no faction rows at all. The
 * materials were arriving and the instrument said nothing was happening.
 */
import { Database } from 'bun:sqlite'

const API = 'http://127.0.0.1:3031'
const DEFAULTS: Record<string, number> = { uranium_ore: 882, fluorine_gas: 148, helium_ice: 10 }

const targets: Record<string, number> = {}
for (const a of Bun.argv.slice(2)) {
  const [k, v] = a.split('=')
  if (k && v) targets[k] = Number(v)
}
const want = Object.keys(targets).length ? targets : DEFAULTS

const db = new Database('data/admiral.db', { readonly: true })
const personalQ = db.query('SELECT COALESCE(SUM(quantity),0) q FROM storage_inventory WHERE item_id = ?')

/** Faction storage, read through any connected agent. Remote reads take a
 *  station_id, so the agent need not be docked there. */
async function factionAt(stationId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const profiles = await (await fetch(`${API}/api/profiles`)).json() as any[]
  const agent = profiles.find(p => p.running)
  if (!agent) return out
  const res = await fetch(`${API}/api/profiles/${agent.id}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'view_faction_storage', args: { station_id: stationId }, silent: true }),
    signal: AbortSignal.timeout(90_000),
  })
  const full = await res.json() as Record<string, unknown>
  // Scope to the STORAGE LISTING only. A game response also carries
  // `notifications` and `session`, and those blocks can hold cargo payloads —
  // walking the whole envelope counted whatever deposit notification happened
  // to be pending as faction stock, so this reported fluorine_gas at 87 when
  // faction storage held 44. An instrument that is intermittently high is
  // worse than one that is consistently wrong: it looks like progress.
  const sc = (full.structuredContent ?? full.result ?? full) as Record<string, unknown>
  const data: unknown = (sc && typeof sc === 'object' && 'items' in sc) ? sc.items : sc
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return }
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>
      if (typeof r.item_id === 'string' && typeof r.quantity === 'number') {
        out.set(r.item_id, (out.get(r.item_id) ?? 0) + r.quantity)
        return
      }
      for (const v of Object.values(r)) walk(v)
    }
  }
  walk(data)
  return out
}

// We own exactly one faction lockbox. Widen this list if that changes.
const LOCKBOXES = ['crimson_war_citadel']
const faction = new Map<string, number>()
for (const s of LOCKBOXES) {
  try {
    for (const [k, v] of await factionAt(s)) faction.set(k, (faction.get(k) ?? 0) + v)
  } catch { console.error(`  (faction read failed at ${s} — personal totals only)`) }
}

console.log('item                 personal   faction     total   target    remaining')
let done = 0
for (const [item, target] of Object.entries(want)) {
  const p = (personalQ.get(item) as { q: number }).q
  const f = faction.get(item) ?? 0
  const total = p + f
  const remaining = Math.max(0, target - total)
  if (remaining === 0) done++
  const bar = remaining === 0 ? 'DONE' : `${Math.round((100 * total) / target)}%`
  console.log(`${item.padEnd(20)} ${String(p).padStart(8)} ${String(f).padStart(9)} ${String(total).padStart(9)} ${String(target).padStart(8)} ${String(remaining).padStart(12)}  ${bar}`)
}
console.log(`\n${done}/${Object.keys(want).length} lines complete.`)
