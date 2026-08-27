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

const FEED_URL = 'https://game.spacemolt.com/api/market'
const FETCH_INTERVAL_MS = 10 * 60 * 1000
const RERENDER_THRESHOLD = 0.25
// Items whose sale Admiral blocks fleet-wide (Devastator feedstock) — showing
// them as "sellable" would walk agents straight into the guard.
const LOCKED = new Set(['iron_ore', 'titanium_ore', 'titanium_alloy', 'steel_plate', 'fury_crystal'])

interface EmpireQuote {
  empire: string
  bid: number
  depth: number // bid_quantity_reasonable: excludes predatory 1cr walls
}

// item_id -> best few empire quotes, refreshed each fetch
let quotes = new Map<string, EmpireQuote[]>()
// The throttled snapshot the briefing actually renders from
let snapshot = new Map<string, EmpireQuote>()
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
    for (const raw of items) {
      const it = raw as Record<string, unknown>
      const id = String(it.item_id ?? '')
      const bid = Number(it.best_bid ?? 0)
      const depth = Number(it.bid_quantity_reasonable ?? it.bid_quantity_at_best ?? 0)
      if (!id || bid <= 0 || depth <= 0) continue
      const arr = next.get(id) ?? []
      arr.push({ empire: String(it.empire ?? '?'), bid, depth })
      next.set(id, arr)
    }
    for (const arr of next.values()) arr.sort((a, b) => b.bid * Math.min(b.depth, 100) - a.bid * Math.min(a.depth, 100))
    quotes = next
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
  // Ore board: top sellable ores by value of a modest (70-unit) hold
  const ores = [...quotes.entries()]
    .filter(([id]) => id.endsWith('_ore') && !LOCKED.has(id))
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
export function galaxyMarketLines(cargoItemIds: string[]): string[] {
  if (lastFetchOk === 0) return []
  const lines: string[] = []
  const cargoLines: string[] = []
  for (const id of [...new Set(cargoItemIds)]) {
    if (id.startsWith('package:')) continue
    const q = snapshot.get(id)
    if (LOCKED.has(id)) {
      cargoLines.push(`${id}: BoM-LOCKED (vault it, unsellable)`)
    } else if (q) {
      cargoLines.push(`${id}: ${q.empire} bids ${q.bid} x${q.depth}`)
    } else {
      cargoLines.push(`${id}: NO real bids galaxy-wide`)
    }
  }
  if (cargoLines.length > 0) lines.push(`Galaxy bids for your cargo: ${cargoLines.join(' | ')}`)
  if (oreBoard.length > 0) {
    const board = oreBoard.map((e) => `${e.item} → ${e.q.empire} ${e.q.bid} x${e.q.depth}`)
    lines.push(`Best sellable ores galaxy-wide: ${board.join(' | ')} (empire-level — find the station with analyze_market/trade intel when docked)`)
  }
  return lines
}
