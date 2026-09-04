/**
 * Briefing watch — validate what the fleet is being TOLD against what is TRUE.
 *
 * Every playbook entry carries a `kill_condition` in its own words, and until
 * now nothing evaluated them. Three entries were live and false on 2026-09-04:
 * a LAW stating railgun magazines are "7-10 rounds" (siege_railgun is 3), a
 * PATTERN saying ore bids were dead galaxy-wide (silver bid 95 at 24,000 depth),
 * and a PATTERN saying crimson pays 1,400+ for fuel cells (crimson bid 0).
 * All three surfaced only because an agent argued with its own prompt.
 *
 * Injected state outranks what an agent observes, so a false line here is worse
 * than no line. This emits ONE stdout line per finding and stays silent
 * otherwise — a watcher that cries wolf gets turned off, which is worse than
 * no watcher (see needs-admiral.ts for the same lesson).
 *
 * Usage: bun scripts/briefing-watch.ts [--once]
 */
import { Database } from 'bun:sqlite'

const DB = 'data/admiral.db'
const FEED = 'https://game.spacemolt.com/api/market'
// The server already maintains an ETag-validated catalog cache. Fetching the
// remote copy on every pass earned an HTTP 429, and because a failed fetch just
// skipped the magazine check, SILENCE meant "could not check" rather than
// "clean" — the precise failure this script's header warns about.
const CATALOG_CACHE = 'data/catalog-cache.json'
const ONCE = process.argv.includes('--once')
const INTERVAL_MS = 15 * 60 * 1000

type Row = Record<string, unknown>
const fired = new Set<string>()   // report each finding once per process

function emit(key: string, msg: string): void {
  if (fired.has(key)) return
  fired.add(key)
  console.log(msg)
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

/** Best bid and its depth per item, across all empires. */
function bidIndex(feed: unknown): Map<string, { bid: number; depth: number; empire: string }> {
  const out = new Map<string, { bid: number; depth: number; empire: string }>()
  const rows = Array.isArray(feed) ? feed : ((feed as Row)?.items as Row[]) ?? []
  for (const r of rows as Row[]) {
    const id = String(r.item_id ?? r.id ?? '')
    const bid = Number(r.best_bid ?? 0)
    const depth = Number(r.bid_quantity_at_best ?? 0)
    if (!id || bid <= 0) continue
    const cur = out.get(id)
    if (!cur || bid > cur.bid) out.set(id, { bid, depth, empire: String(r.empire ?? '') })
  }
  return out
}

async function runChecks(): Promise<void> {
  const db = new Database(DB, { readonly: true })
  const active = db.query(`SELECT id, class, title, body, evidence, kill_condition, last_verified
                           FROM playbook WHERE status = 'active'`).all() as Row[]

  const feed = await getJson(FEED)
  if (!feed) { console.log('[watch] market feed unreachable (rate limit?) — price checks SKIPPED this pass'); return }

  let catalogRaw: unknown = null
  try { catalogRaw = JSON.parse(await Bun.file(CATALOG_CACHE).text()) } catch { catalogRaw = null }
  const bids = bidIndex(feed)

  // --- 1. Asserted ORE PRICES, checked against the feed.
  //
  // Scoped to `_ore` deliberately. An earlier version also matched `_cell`, and
  // immediately misread "military_fuel_cell 100" — where 100 is the FUEL
  // RESTORE amount, not a price — as a collapsed bid. A watcher that cries wolf
  // gets turned off, which is strictly worse than no watcher. Consumable
  // restore values are covered by the catalog check and the conflict sweep.
  for (const e of active) {
    // Both fields: durable prose lives in `body`, but the dated figures that go
    // stale almost always live in `evidence`.
    const body = `${String(e.body ?? '')} ${String(e.evidence ?? '')}`
    for (const m of body.matchAll(/\b([a-z_]+_ore)\b[^.]{0,60}?\b(\d{2,5})\b/g)) {
      const item = m[1]
      const claimed = Number(m[2])
      const live = bids.get(item)
      if (!live || claimed < 20) continue
      // Only flag a collapse of an asserted price, not ordinary drift.
      if (live.bid * 4 < claimed) {
        emit(`price:${e.id}:${item}`,
          `[playbook ${e.id}] "${e.title}" claims ${item} near ${claimed} — live best bid is ${live.bid} (${live.empire}). Verify or demote.`)
      }
    }
  }

  // --- 2. Catalog-checkable magazine/effect claims.
  const catalog = catalogRaw as Row | null
  if (!catalog) console.log('[watch] catalog cache unreadable — magazine checks SKIPPED this pass')
  if (catalog) {
    const rawItems = catalog.items
    const items: Record<string, Row> = Array.isArray(rawItems)
      ? Object.fromEntries((rawItems as Row[]).filter(x => x?.id).map(x => [String(x.id), x]))
      : (rawItems as Record<string, Row>) ?? {}
    for (const e of active) {
      const body = String(e.body ?? '')
      // Magazine assertions, in BOTH orderings — "railgun_ii holds 7" and
      // "3 on a siege_railgun" are equally natural, and an earlier version only
      // looked forward from the model name, so it silently missed the second
      // form and misattributed the next model's number to the first. A
      // validator that reports phantom errors, or quietly misses real ones, is
      // the fastest way to get itself ignored.
      const pairs: Array<[string, number]> = []
      for (const m of body.matchAll(/\b(\d{1,3})\s*(?:-|to|\w{1,4}\s+){0,3}(?:a |an )?\b([a-z_]*railgun[a-z_]*)\b/g)) {
        pairs.push([m[2], Number(m[1])])            // number BEFORE the model
      }
      for (const m of body.matchAll(/\b([a-z_]*railgun[a-z_]*)\b[^.,;]{0,18}?\b(\d{1,3})\b/g)) {
        pairs.push([m[1], Number(m[2])])            // model BEFORE the number
      }
      for (const [model, claimed] of pairs) {
        const it = items[model]
        if (!it?.magazine_size) continue
        if (Number(it.magazine_size) !== claimed) {
          emit(`mag:${e.id}:${model}:${claimed}`,
            `[playbook ${e.id}] "${e.title}" states ${model} magazine ${claimed} — catalog says ${it.magazine_size}.`)
        }
      }
    }
  }

  // --- 3. Contradiction sweep: two ACTIVE entries asserting different numbers
  // for the same item. The fuel-cell pair (1 vs 20) sat contradicting for days.
  const claims = new Map<string, Array<{ id: number; n: number; title: string }>>()
  for (const e of active) {
    for (const m of String(e.body ?? '').matchAll(/\b([a-z_]{4,}_cell)\b[^.]{0,40}?\brestores? (\d{1,4})\b/gi)) {
      const k = m[1].toLowerCase()
      claims.set(k, [...(claims.get(k) ?? []), { id: Number(e.id), n: Number(m[2]), title: String(e.title) }])
    }
  }
  for (const [item, list] of claims) {
    const distinct = new Set(list.map(l => l.n))
    if (distinct.size > 1) {
      emit(`conflict:${item}`,
        `[playbook] CONFLICT on ${item}: ${list.map(l => `[${l.id}] says ${l.n}`).join(' vs ')}. Both are active and injected.`)
    }
  }

  // --- 4. Entries past their class TTL that the sweep has not yet demoted.
  for (const e of active) {
    const days = (Date.now() - Date.parse(String(e.last_verified))) / 86_400_000
    const ttl = e.class === 'PATTERN' ? 7 : e.class === 'TERRAIN' ? 21 : Infinity
    if (days > ttl) {
      emit(`ttl:${e.id}`,
        `[playbook ${e.id}] "${e.title}" is ${Math.floor(days)}d old (${e.class} TTL ${ttl}d) and still active.`)
    }
  }

  db.close()
}

await runChecks()
if (!ONCE) {
  setInterval(() => { runChecks().catch(() => {}) }, INTERVAL_MS)
  await new Promise(() => {})   // stay alive for the Monitor
}
