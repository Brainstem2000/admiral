/**
 * Action-log ingestion — inventory accounting from the game's own event stream.
 *
 * Why this exists: the storage/cargo ledger was snapshot-only, so it was correct
 * exactly at the moment somebody ran view_storage and decayed from there. A
 * reconciliation against live truth measured 89.7% accuracy, and the misses were
 * dominated by age rather than by bugs — a platinum transfer six minutes old had
 * already made two rows wrong. Snapshots cannot fix that; an event feed can.
 *
 * `get_action_log` is a FREE, paginated, `since_id`-cursored feed of every state
 * change the game recorded, with exact item deltas. This module mirrors it into
 * `action_events` and derives cargo movements from it.
 *
 * DESIGN — deliberately conservative about what it claims to know:
 *
 *   CARGO is derived exactly. Every cargo-affecting event names the item and
 *   quantity, and cargo is station-independent, so the arithmetic is unambiguous.
 *
 *   STORAGE is NOT derived from deposit/withdraw events. Those carry no station
 *   id, and Admiral keeps no position history to place them with. Guessing the
 *   station would produce confident fiction — the exact failure mode this whole
 *   effort exists to remove. Instead the agent is marked dirty and the next
 *   view_storage settles it. Events that DO carry `base_id`
 *   (trading.exchange_fill, faction.deposit/withdraw) adjust storage directly.
 */
import {
  recordActionEvents, getActionCursor, markStorageDirty,
  recordCargoSnapshot, getCargoForProfile, recordObligations, type ActionEvent,
} from './db'
import type { GameConnection } from './connections/interface'

/** Categories that can move items. `combat` is included for ship-loss cargo wipes.
 *  `other` carries the money nobody watches — rent_paid, tax.*, jettison, facility
 *  lifecycle. Its absence hid a 30-day facility rental that escalated 15 -> 433cr
 *  per cycle and consumed ~2M credits before a wallet audit caught it. */
const CATEGORIES = ['trading', 'storage', 'mining', 'crafting', 'combat', 'other'] as const

/** Signed cargo effect of one event, as [item_id, delta] pairs. */
export function cargoDeltas(e: ActionEvent): Array<[string, number]> {
  const d = e.data ?? {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const one = (sign: number): Array<[string, number]> => {
    const id = typeof d.item_id === 'string' ? d.item_id : null
    const q = num(d.quantity)
    return id && q ? [[id, sign * q]] : []
  }
  const bulk = (sign: number): Array<[string, number]> => {
    const items = d.items
    if (!items || typeof items !== 'object') return []
    return Object.entries(items as Record<string, unknown>)
      .map(([k, v]) => [k, sign * num(v)] as [string, number])
      .filter(([, q]) => q !== 0)
  }

  switch (e.event_type) {
    // --- into the hold ---
    case 'mining.yield': {
      const id = typeof d.resource_id === 'string' ? d.resource_id : null
      const q = num(d.quantity)
      return id && q ? [[id, q]] : []
    }
    case 'storage.withdraw_items': return one(+1)
    case 'storage.bulk_withdraw': return bulk(+1)

    // --- out of the hold ---
    case 'storage.deposit_items': return one(-1)
    case 'storage.bulk_deposit': return bulk(-1)

    // A gift sent from cargo leaves the hold; `source: "storage"` never touches it.
    case 'trading.gift_sent':
      return d.source === 'storage' ? [] : one(-1)

    // Jettisoned cargo is gone. Lived unseen in `other` until that category was swept.
    case 'other.jettison': return one(-1)

    // A received gift lands in STORAGE at the sender's station, never in cargo.
    case 'trading.gift_received': return []

    // Market fills move goods at a station: bought goods land in storage, sold
    // goods leave it. Handled by storageDeltas, not here.
    case 'trading.exchange_fill': return []

    default: return []
  }
}

/** Storage effect of events that actually name their station. */
export function storageDeltas(e: ActionEvent): Array<[string, string, number]> {
  const d = e.data ?? {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const base = typeof d.base_id === 'string' ? d.base_id : null
  const id = typeof d.item_id === 'string' ? d.item_id : null
  const q = num(d.quantity)
  if (!id || !q) return []
  switch (e.event_type) {
    case 'trading.exchange_fill':
      if (!base) return []
      return [[base, id, d.role === 'buyer' ? q : -q]]
    case 'faction.deposit':
      return base ? [[base, id, -q]] : []   // leaves personal storage for faction
    default: return []
  }
}

/** True if the event changed storage somewhere we cannot pin down. */
export function isUnplaceableStorageMove(e: ActionEvent): boolean {
  return e.event_type === 'storage.deposit_items'
    || e.event_type === 'storage.bulk_deposit'
    || e.event_type === 'storage.withdraw_items'
    || e.event_type === 'storage.bulk_withdraw'
    || e.event_type === 'trading.gift_received'
    || (e.event_type === 'trading.gift_sent' && e.data?.source === 'storage')
}

/** Ship loss empties the hold — insurance replaces the hull, not the contents. */
export function isCargoWipe(e: ActionEvent): boolean {
  return e.event_type === 'combat.ship_destroyed'
}

interface LogPage { entries?: Array<Record<string, unknown>>; has_more?: boolean; total?: number }

/**
 * Pull new events for one agent and fold them into the ledger.
 *
 * `backfillPages` > 1 walks history on a cold cursor; steady state fetches one
 * page. Returns a small summary for logging.
 */
export async function ingestActionLog(
  profileId: string,
  connection: GameConnection,
  opts: { backfillPages?: number; pageSize?: number } = {},
): Promise<{ added: number; cargoApplied: number; dirty: boolean }> {
  const pageSize = opts.pageSize ?? 100
  let added = 0
  let dirty = false
  const fresh: ActionEvent[] = []
  // A cold cursor means we are back-filling history. Those events are stored for
  // the audit trail but MUST NOT be replayed onto cargo: the feed is paginated and
  // finite, so a replay starting mid-history would apply half a story and invent a
  // hold that never existed. Cargo only advances from events observed live, on top
  // of a real get_cargo snapshot.
  let backfilling = false

  for (const category of CATEGORIES) {
    const cursor = getActionCursor(profileId, category)
    if (cursor === 0) backfilling = true
    // Cold start walks deep enough to bank the whole retained history — the
    // busiest category observed was ~2,100 events for a single agent. Paging stops
    // early on has_more=false, so this ceiling only binds on the heaviest accounts.
    const maxPages = cursor === 0 ? (opts.backfillPages ?? 30) : 1
    for (let page = 1; page <= maxPages; page++) {
      let resp: { structuredContent?: LogPage; result?: unknown; error?: unknown }
      try {
        resp = await connection.execute('get_action_log', {
          category, page_size: pageSize, page,
          ...(cursor ? { since_id: cursor } : {}),
        }) as typeof resp
      } catch { break }
      if (resp?.error) break
      const sc = resp?.structuredContent
      const entries = Array.isArray(sc?.entries) ? sc!.entries! : []
      if (entries.length === 0) break

      const parsed: ActionEvent[] = entries.map(x => ({
        event_id: Number(x.id ?? 0),
        created_at: String(x.created_at ?? ''),
        category,
        event_type: String(x.event_type ?? '?'),
        data: (x.data && typeof x.data === 'object' ? x.data : {}) as Record<string, unknown>,
      })).filter(x => x.event_id > 0)

      // Only events we had not already stored count as fresh for ledger purposes;
      // re-applying a delta we already applied would double-count it.
      const insertedIds = new Set(recordActionEvents(profileId, category, parsed))
      added += insertedIds.size
      const inserted = parsed.filter(p => insertedIds.has(p.event_id))
      for (const p of inserted) fresh.push(p)
      // Obligations fold on EVERY inserted event, backfill included — a rent paid
      // in July is still money gone, and the register exists precisely so that
      // history nobody watched still adds up. Dedupe is the INSERT OR IGNORE above.
      if (inserted.length) recordObligations(profileId, inserted)
      if (!sc?.has_more) break
      // Deep back-fills hammered the API with 429s once before; pace them.
      if (backfilling) await new Promise(r => setTimeout(r, 250))
    }
  }

  // Back-fill run: events are banked, but nothing is replayed onto the ledger.
  if (backfilling) return { added, cargoApplied: 0, dirty: false }

  // --- fold the new events into cargo ---
  fresh.sort((a, b) => a.event_id - b.event_id)
  const cargo = new Map<string, number>()
  for (const r of getCargoForProfile(profileId)) cargo.set(r.item_id, r.quantity)
  let cargoApplied = 0
  for (const e of fresh) {
    if (isCargoWipe(e)) { cargo.clear(); cargoApplied++; continue }
    for (const [item, delta] of cargoDeltas(e)) {
      cargo.set(item, Math.max(0, (cargo.get(item) ?? 0) + delta))
      cargoApplied++
    }
    if (isUnplaceableStorageMove(e)) dirty = true
  }
  if (cargoApplied > 0) {
    recordCargoSnapshot(profileId,
      [...cargo.entries()].filter(([, q]) => q > 0).map(([item_id, quantity]) => ({ item_id, quantity })))
  }
  if (dirty) markStorageDirty(profileId, 'deposit/withdraw/gift since last view_storage')
  return { added, cargoApplied, dirty }
}
