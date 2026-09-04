/**
 * Galaxy-wide market intel from the public per-empire feed.
 *
 * Agents have no HTTP access — their view of prices is limited to stations they
 * have personally docked at (fleet_intel_market). This module gives every
 * briefing a galaxy-level answer ("does ANYTHING pay real money for what I
 * hold / mine?") by polling https://game.spacemolt.com/api/market, which
 * carries best_bid/best_ask WITH depth per empire. Built 2026-08-26 after Grit
 * spent turns hunting for a palladium market that does not exist.
 *
 * Two cadences on purpose:
 *  - FETCH every 10 min into memory (cheap; endpoint rate-limits, so back off
 *    on 429 using its retry_after).
 *  - The briefing SECTION re-renders only when a value moves >25% or the item
 *    set changes. The briefing is baked into the cached system prompt, and the
 *    local-model serving stack (exact-append KV cache) pays a full re-prefill
 *    on ANY system-prompt byte change — per-fetch churn would cost far more
 *    than the intel is worth.
 */

import { getCommissionRequirement } from './db'

const FEED_URL = 'https://game.spacemolt.com/api/market'
const FETCH_INTERVAL_MS = 10 * 60 * 1000
const RERENDER_THRESHOLD = 0.25

/** Is this item reserved by an OPEN commission of this agent's own?
 *
 *  This used to be a hardcoded Set of Devastator feedstock — iron_ore,
 *  titanium_ore, titanium_alloy, steel_plate, fury_crystal. That commission was
 *  placed and paid on 2026-08-28 and `SELL_CARGO_ALWAYS_EXCLUDE` in tools.ts was
 *  emptied the same day on the Admiral's order, but this second, parallel list
 *  was missed. For a week afterwards the briefing told every agent their ore was
 *  "BoM-LOCKED (vault it, unsellable)" while the actual sell guard let it
 *  through — 36,027 units fleet-wide, 12,167 of them Morg'Thar's. Injected state
 *  outranks what the agent observes, so they vaulted ore they could have sold and
 *  reported the lock back as fact.
 *
 *  Two lock lists could disagree, so now there is one source of truth: the live
 *  `commission_requirements` table, which is what the craft guard already reads.
 *  It is also scoped per agent — another agent's open commission must never
 *  reserve your stock, because commissions consume only the commissioning
 *  player's own storage. */
function isLocked(itemId: string, profileId?: string): boolean {
  if (!profileId) return false   // unknown caller: never invent a lock
  try {
    return getCommissionRequirement(itemId, profileId) > 0
  } catch {
    return false
  }
}

interface EmpireQuote {
  empire: string
  bid: number
  depth: number // bid_quantity_reasonable: excludes predatory 1cr walls
}

interface EmpireAsk {
  empire: string
  ask: number
  depth: number // ask_quantity_reasonable
}

// item_id -> best few empire quotes, refreshed each fetch
let quotes = new Map<string, EmpireQuote[]>()
// Ask side (cheapest first). Kept since 2026-08-28: the bid-only feed left
// buy-leg agents blind (Morg flew the flex circuit's sell hub with an empty
// hold on 40-min-old directive numbers).
let askQuotes = new Map<string, EmpireAsk[]>()
// The throttled snapshots the briefing actually renders from
let snapshot = new Map<string, EmpireQuote>()
let askSnapshot = new Map<string, EmpireAsk>()
let oreBoard: Array<{ item: string; q: EmpireQuote }> = []
let lastFetchOk = 0
let timer: ReturnType<typeof setInterval> | null = null

async function fetchFeed(): Promise<void> {
  try {
    const res = await fetch(FEED_URL)
    if (!res.ok) return
    const data = (await res.json()) as unknown
    const items = Array.isArray(data) ? data : (data as Record<string, unknown>)?.items
    if (!Array.isArray(items)) return // rate-limited shell or shape change — keep old data
    const next = new Map<string, EmpireQuote[]>()
    const nextAsks = new Map<string, EmpireAsk[]>()
    for (const raw of items) {
      const it = raw as Record<string, unknown>
      const id = String(it.item_id ?? '')
      if (!id) continue
      // Pirate-empire quotes are unusable temptation: the fleet is barred from
      // pirate space, so a 4,914 pirate bid relayed as "best" sends an unarmed
      // hauler toward forbidden systems (Morg, 2026-08-28). Exclude entirely.
      if (String(it.empire ?? '') === 'pirates') continue
      const bid = Number(it.best_bid ?? 0)
      const depth = Number(it.bid_quantity_reasonable ?? it.bid_quantity_at_best ?? 0)
      if (bid > 0 && depth > 0) {
        const arr = next.get(id) ?? []
        arr.push({ empire: String(it.empire ?? '?'), bid, depth })
        next.set(id, arr)
      }
      const ask = Number(it.best_ask ?? 0)
      const askDepth = Number(it.ask_quantity_reasonable ?? it.ask_quantity_at_best ?? 0)
      if (ask > 0 && askDepth > 0) {
        const arr = nextAsks.get(id) ?? []
        arr.push({ empire: String(it.empire ?? '?'), ask, depth: askDepth })
        nextAsks.set(id, arr)
      }
    }
    for (const arr of next.values()) arr.sort((a, b) => b.bid * Math.min(b.depth, 100) - a.bid * Math.min(a.depth, 100))
    for (const arr of nextAsks.values()) arr.sort((a, b) => a.ask - b.ask) // cheapest source first
    quotes = next
    askQuotes = nextAsks
    lastFetchOk = Date.now()
    maybeRefreshSnapshot()
  } catch {
    /* network blip — keep serving the previous snapshot */
  }
}

function changed(a: EmpireQuote | undefined, b: EmpireQuote | undefined): boolean {
  if (!a || !b) return true
  if (a.empire !== b.empire) return true
  const move = (x: number, y: number) => Math.abs(x - y) / Math.max(x, 1)
  return move(a.bid, b.bid) > RERENDER_THRESHOLD || move(a.depth, b.depth) > RERENDER_THRESHOLD
}

function maybeRefreshSnapshot(): void {
  // Ore board: top sellable ores by value of a modest (70-unit) hold.
  // No lock filter here: this snapshot is global and has no agent context, while
  // a commission reservation is per-agent and is surfaced on that agent's own
  // cargo lines instead. The old hardcoded filter hid iron_ore and titanium_ore
  // from every agent for a week after the commission they belonged to had closed.
  const ores = [...quotes.entries()]
    .filter(([id]) => id.endsWith('_ore'))
    .map(([id, arr]) => ({ item: id, q: arr[0] }))
    .filter((e) => e.q.bid >= 30 && e.q.depth >= 50)
    .sort((a, b) => b.q.bid * Math.min(b.q.depth, 70) - a.q.bid * Math.min(a.q.depth, 70))
    .slice(0, 3)

  const oreChanged =
    ores.length !== oreBoard.length ||
    ores.some((e, i) => e.item !== oreBoard[i]?.item || changed(e.q, oreBoard[i]?.q))

  const nextSnap = new Map<string, EmpireQuote>()
  for (const [id, arr] of quotes) nextSnap.set(id, arr[0])
  // Only swap the per-item snapshot entries that moved past the threshold, so
  // briefing lines for stable items stay byte-identical between fetches.
  let itemChanged = false
  for (const [id, q] of nextSnap) {
    if (changed(snapshot.get(id), q)) {
      snapshot.set(id, q)
      itemChanged = true
    }
  }
  if (oreChanged) oreBoard = ores
  if (oreChanged || itemChanged) {
    // nothing else to do — buildSituationalBriefing re-renders lazily
  }

  // Ask-side snapshot, same per-item threshold so stable prices stay byte-identical.
  for (const [id, arr] of askQuotes) {
    const q = arr[0]
    const prev = askSnapshot.get(id)
    const move = (x: number, y: number) => Math.abs(x - y) / Math.max(x, 1)
    if (!prev || prev.empire !== q.empire || move(prev.ask, q.ask) > RERENDER_THRESHOLD || move(prev.depth, q.depth) > RERENDER_THRESHOLD) {
      askSnapshot.set(id, q)
    }
  }
}

export function startGalaxyMarketCollector(): void {
  if (timer) return
  void fetchFeed()
  timer = setInterval(() => void fetchFeed(), FETCH_INTERVAL_MS)
  console.log('[GalaxyMarket] collector started (10-min fetch, threshold-rendered)')
}

export function stopGalaxyMarketCollector(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * Briefing lines: galaxy best bid for each cargo item the agent holds, plus a
 * compact sellable-ore board. Empty array when the feed has never succeeded.
 */
/** @param opts.oreBoard render the galaxy-wide sellable-ore board (default true).
 *  Hunters carry no mining laser, so for them it is noise that reads as a plan. */
export function galaxyMarketLines(
  cargoItemIds: string[],
  opts: { oreBoard?: boolean; profileId?: string } = {},
): string[] {
  if (lastFetchOk === 0) return []
  const lines: string[] = []
  const cargoLines: string[] = []
  for (const id of [...new Set(cargoItemIds)]) {
    if (id.startsWith('package:')) continue
    const q = snapshot.get(id)
    if (isLocked(id, opts.profileId)) {
      cargoLines.push(`${id}: reserved by YOUR open commission (do not sell)`)
    } else if (q) {
      cargoLines.push(`${id}: ${q.empire} bids ${q.bid} x${q.depth}`)
    } else {
      cargoLines.push(`${id}: NO real bids galaxy-wide`)
    }
  }
  if (cargoLines.length > 0) lines.push(`Galaxy bids for your cargo: ${cargoLines.join(' | ')}`)
  if (oreBoard.length > 0 && opts.oreBoard !== false) {
    const board = oreBoard.map((e) => `${e.item} → ${e.q.empire} ${e.q.bid} x${e.q.depth}`)
    lines.push(`Best sellable ores galaxy-wide: ${board.join(' | ')} (empire-level — find the station with analyze_market/trade intel when docked)`)
  }
  return lines
}

/**
 * Both-sides galaxy quotes for items the agent's DIRECTIVE names. A buy-leg
 * agent holds nothing, so the cargo-keyed relay above tells it nothing — this
 * keys on the mission text instead, so directive numbers self-refresh instead
 * of aging into wrong ones. Rendered from the same threshold-throttled
 * snapshots (prompt-cache safe). Empty when the feed has never succeeded.
 */
export function directiveMarketLines(directiveText: string): string[] {
  if (lastFetchOk === 0 || !directiveText) return []
  const mentioned = new Set<string>()
  for (const id of new Set([...snapshot.keys(), ...askSnapshot.keys()])) {
    if (id.length >= 5 && directiveText.includes(id)) mentioned.add(id)
    if (mentioned.size >= 8) break
  }
  const parts: string[] = []
  for (const id of mentioned) {
    const a = askSnapshot.get(id)
    const b = snapshot.get(id)
    const side: string[] = []
    if (a) side.push(`cheapest ask ${a.empire} ${a.ask} x${a.depth}`)
    if (b) side.push(`best bid ${b.empire} ${b.bid} x${b.depth}`)
    if (side.length) parts.push(`${id}: ${side.join(', ')}`)
  }
  return parts.length ? [`Galaxy quotes for your directive items (empire-level, ~10min): ${parts.join(' | ')}`] : []
}
