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
 * `action_events` and derives cargo AND storage movements from it.
 *
 * DESIGN — deliberately conservative about what it claims to know:
 *
 *   CARGO is derived exactly. Every cargo-affecting event names the item and
 *   quantity, and cargo is station-independent, so the arithmetic is unambiguous.
 *
 *   STORAGE events (deposit/withdraw/gift) name the item and quantity but NOT
 *   the station. Until 2026-09-12 that meant "mark the agent dirty and wait for
 *   the next view_storage" — and the table told the Admiral CyberSapper held 4
 *   focused_crystal at War Citadel while the live view showed 0 and 766
 *   fury_crystal. Now each event is (a) matched to the `storage_ledger` row the
 *   COMMAND result already wrote (same profile, item, signed quantity, within
 *   ±3 minutes) and merely attached to it; else (b) placed from
 *   `position_history` — the newest docked observation at or before the event
 *   within 10 minutes (gifts received: the SENDER's position, since a gift lands
 *   in the recipient's storage at the sender's base) or the crafting job's
 *   facility; else (c) journaled as 'unplaced' with station NULL, not applied,
 *   and the profile marked dirty exactly as before. An event older than the
 *   station's last authoritative snapshot is already inside that snapshot and is
 *   skipped rather than applied twice. Every application goes through
 *   `applyStorageDelta`, inside the same transaction as the event insert.
 *
 *   Spot market fills are NOT applied from the event: `trading.exchange_fill`
 *   cannot tell cargo from storage delivery (a spot buy lands in cargo unless
 *   the hold is full or deliver_to=storage was passed), while the buy/sell
 *   command result says exactly (`delivered_to_storage`), so the command hook
 *   in tools.ts owns those. Order fills (source '' / 'sweep') for the BUYER land
 *   in storage at the order's station, which `own_order_fills` knows.
 */
import {
  recordActionEvents, getActionCursor, markStorageDirty, seedBattlesFromEvents, enrichBattle,
  recordCargoSnapshot, getCargoForProfile, recordObligations, type ActionEvent,
  applyStorageDelta, attachStorageLedgerEvent, positionAt, stationStorageObservedAt, findProfileByPlayer, getDb,
  type StorageLedgerConfidence,
} from './db'
import { codexGet } from './catalog'
import { swallow } from './swallow'
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

    // Market fills: a spot buy lands in cargo (or storage when the hold is full /
    // deliver_to=storage) and the event cannot tell which — the buy/sell command
    // result can, so tools.ts owns spot fills; storageEffects owns order fills.
    case 'trading.exchange_fill': return []

    default: return []
  }
}

/** True if the event changed storage somewhere the event itself cannot pin down. */
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

// ─── Storage effects of action-log events ────────────────────────────────────

/** One storage movement an event implies, with how sure we are about WHERE. */
export interface StorageEffect {
  item_id: string
  delta: number
  station_id: string | null
  confidence: StorageLedgerConfidence
}

export interface StorageEffectDeps {
  /** Recipe lookup (inputs/outputs per run). Defaults to the codex; tests inject. */
  recipe?: (recipeId: string) => { inputs?: Array<{ item_id: string; quantity: number }>; outputs?: Array<{ item_id: string; quantity: number }> } | null
  /** Where the agent was at a moment — position_history by default; tests inject. */
  position?: (profileId: string, atIso: string) => string | null | undefined
  /** Station of an own order, by order id (own_order_fills). */
  orderStation?: (profileId: string, orderId: string) => string | null
  /** Stations of the agent's open BUY orders for an item — unique answer places an order fill. */
  buyOrderStations?: (profileId: string, itemId: string) => string[]
  /** The queued event for a job id — its facility/station places completions and cancels. */
  queuedJob?: (profileId: string, jobId: string) => ActionEvent | null
}

/** `workshop:<player>:<station>` names its station; a bare facility uuid does not. */
export function facilityStation(facilityId: unknown): string | null {
  const s = typeof facilityId === 'string' ? facilityId : ''
  if (!s.startsWith('workshop:')) return null
  const seg = s.split(':')
  const station = seg[seg.length - 1]?.trim()
  return station && /^[a-z0-9_]+$/i.test(station) ? station : null
}

/** position_history lookup: a station id, null = last seen undocked, undefined = nothing recent. */
function defaultPosition(profileId: string, atIso: string): string | null | undefined {
  const p = positionAt(profileId, atIso)
  if (!p) return undefined
  return p.station_id ?? null
}

function defaultOrderStation(profileId: string, orderId: string): string | null {
  try {
    const r = getDb().query('SELECT station FROM own_order_fills WHERE profile_id = ? AND order_id = ?').get(profileId, orderId) as { station: string | null } | null
    return r?.station ?? null
  } catch { return null }
}

function defaultBuyOrderStations(profileId: string, itemId: string): string[] {
  try {
    const rows = getDb().query(`SELECT DISTINCT station FROM own_order_fills
      WHERE profile_id = ? AND item_id = ? AND order_type = 'buy' AND station IS NOT NULL AND station <> ''
      ORDER BY closed ASC, updated_at DESC`).all(profileId, itemId) as Array<{ station: string }>
    // Open orders first; if any are open, only those count.
    const open = getDb().query(`SELECT DISTINCT station FROM own_order_fills
      WHERE profile_id = ? AND item_id = ? AND order_type = 'buy' AND closed = 0 AND station IS NOT NULL AND station <> ''`).all(profileId, itemId) as Array<{ station: string }>
    return (open.length ? open : rows).map(r => r.station)
  } catch { return [] }
}

function defaultQueuedJob(profileId: string, jobId: string): ActionEvent | null {
  try {
    const r = getDb().query(`SELECT event_id, created_at, category, event_type, data FROM action_events
      WHERE profile_id = ? AND event_type = 'crafting.queued' AND data LIKE ? ORDER BY event_id DESC LIMIT 1`)
      .get(profileId, `%"job_id":"${jobId}"%`) as Record<string, string | number> | null
    if (!r) return null
    return { event_id: Number(r.event_id), created_at: String(r.created_at), category: String(r.category), event_type: String(r.event_type), data: JSON.parse(String(r.data)) }
  } catch { return null }
}

function defaultRecipe(recipeId: string) {
  const r = codexGet('recipe', recipeId) as { inputs?: Array<{ item_id: string; quantity: number }>; outputs?: Array<{ item_id: string; quantity: number }> } | null
  return r ?? null
}

/**
 * What one event does to STORAGE, and where. `dirty` names a change we know
 * happened but cannot quantify or place (the caller marks the profile dirty).
 */
export function storageEffects(profileId: string, e: ActionEvent, deps: StorageEffectDeps = {}): { effects: StorageEffect[]; dirty: string | null } {
  const d = e.data ?? {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const position = deps.position ?? defaultPosition
  const recipe = deps.recipe ?? defaultRecipe
  const orderStation = deps.orderStation ?? defaultOrderStation
  const buyOrderStations = deps.buyOrderStations ?? defaultBuyOrderStations
  const queuedJob = deps.queuedJob ?? defaultQueuedJob

  /** Place at the agent's own docked position at the event time. */
  const here = (): { station_id: string | null; confidence: StorageLedgerConfidence } => {
    const st = position(profileId, e.created_at)
    return st ? { station_id: st, confidence: 'placed' } : { station_id: null, confidence: 'unplaced' }
  }
  const lines = (pairs: Array<[string, number]>, at: { station_id: string | null; confidence: StorageLedgerConfidence }): StorageEffect[] =>
    pairs.filter(([id, q]) => id && q !== 0).map(([item_id, delta]) => ({ item_id, delta, ...at }))
  const one = (sign: number): Array<[string, number]> => {
    const id = str(d.item_id)
    const q = num(d.quantity)
    return id && q ? [[id, sign * q]] : []
  }
  const bulk = (sign: number): Array<[string, number]> => {
    const items = d.items
    if (!items || typeof items !== 'object') return []
    return Object.entries(items as Record<string, unknown>).map(([k, v]) => [k, sign * num(v)] as [string, number])
  }
  const none = { effects: [] as StorageEffect[], dirty: null as string | null }
  // Placement failures travel as confidence 'unplaced' on the effect itself; the
  // applier reports them only if the effect is actually journaled unplaced (an
  // effect that matches a command row is attached instead, and is not a problem).
  const unplacedDirty = (effects: StorageEffect[]) => ({ effects, dirty: null as string | null })

  switch (e.event_type) {
    case 'storage.deposit_items': return unplacedDirty(lines(one(+1), here()))
    case 'storage.bulk_deposit': return unplacedDirty(lines(bulk(+1), here()))
    case 'storage.withdraw_items': return unplacedDirty(lines(one(-1), here()))
    case 'storage.bulk_withdraw': return unplacedDirty(lines(bulk(-1), here()))

    case 'trading.gift_sent':
      // From storage: leaves the sender's storage at the sender's base. From cargo: cargoDeltas.
      return d.source === 'storage' ? unplacedDirty(lines(one(-1), here())) : none

    case 'trading.gift_received': {
      // Lands in the RECIPIENT's storage at the SENDER's base (game docs). Only a
      // fleet sender's position is known; an outsider's gift stays unplaced.
      const sender = findProfileByPlayer(str(d.sender))
      const st = sender ? position(sender.id, e.created_at) : null
      return unplacedDirty(lines(one(+1), st ? { station_id: st, confidence: 'placed' } : { station_id: null, confidence: 'unplaced' }))
    }

    case 'trading.exchange_fill': {
      // Spot fills: the buy/sell command result says whether goods hit storage
      // (delivered_to_storage); the event cannot, so the command hook owns them.
      if (str(d.source) === 'spot') return none
      if (str(d.role) !== 'buyer') return none          // a seller's escrow left storage/cargo at listing time
      const id = str(d.item_id)
      const q = num(d.quantity)
      if (!id || !q) return none
      const base = str(d.base_id)
      if (base) return { effects: [{ item_id: id, delta: q, station_id: base, confidence: 'exact' }], dirty: null }
      const stations = [...new Set(buyOrderStations(profileId, id))]
      if (stations.length === 1) return { effects: [{ item_id: id, delta: q, station_id: stations[0], confidence: 'placed' }], dirty: null }
      return unplacedDirty([{ item_id: id, delta: q, station_id: null, confidence: 'unplaced' }])
    }

    case 'trading.order_cancelled': {
      // "Sell orders: remaining items returned to station storage" — at the order's station.
      if (str(d.order_type) !== 'sell') return none
      const id = str(d.item_id)
      const q = num(d.quantity)
      if (!id || !q) return none
      const st = orderStation(profileId, str(d.order_id))
      return unplacedDirty([{ item_id: id, delta: q, station_id: st || null, confidence: st ? 'placed' : 'unplaced' }])
    }

    case 'trading.trade_completed':
      // Player-to-player trade at the same POI: the event renders items as prose
      // ("6x Focused Crystal") and does not say cargo or storage. Do not guess.
      return { effects: [], dirty: 'trade_completed: item exchange, storage effect unknown' }

    case 'crafting.queued':
    case 'crafting.completed':
    case 'crafting.cancelled': {
      const storage = str(d.storage)
      const queued = e.event_type === 'crafting.queued' ? e : queuedJob(profileId, str(d.job_id))
      const bucket = storage || str(queued?.data?.storage)
      if (bucket === 'faction') return none                 // the faction lockbox — faction_ledger's domain
      if (bucket !== 'station') return { effects: [], dirty: `${e.event_type}: storage bucket unknown` }
      const direction = str(d.direction) || 'forward'
      const rec = recipe(str(d.recipe_id) || str(queued?.data?.recipe_id))
      if (!rec) return { effects: [], dirty: `${e.event_type}: recipe ${str(d.recipe_id)} unknown` }
      // Inputs are escrowed from station storage at enqueue (game docs); outputs
      // are delivered on completion; a cancel refunds the unconsumed runs.
      const runs = e.event_type === 'crafting.cancelled' ? num(d.runs_remaining) : num(d.runs)
      if (!runs) return none
      const consumed = direction === 'reverse' ? rec.outputs ?? [] : rec.inputs ?? []
      const produced = direction === 'reverse' ? null : rec.outputs ?? []   // a recycle recovers an unknown fraction
      // Where: the workshop id names its station; a private/faction facility's
      // uuid does not, so fall back to where the agent was when the job was QUEUED
      // (crafting requires docking there; a completion can fire after they left).
      const fac = facilityStation(d.facility_id) ?? facilityStation(queued?.data?.facility_id)
      let at: { station_id: string | null; confidence: StorageLedgerConfidence }
      if (fac) at = { station_id: fac, confidence: 'exact' }
      else {
        const st = position(profileId, queued?.created_at ?? e.created_at)
        at = st ? { station_id: st, confidence: 'placed' } : { station_id: null, confidence: 'unplaced' }
      }
      if (e.event_type === 'crafting.queued') return unplacedDirty(lines(consumed.map(i => [i.item_id, -i.quantity * runs]), at))
      if (e.event_type === 'crafting.cancelled') return unplacedDirty(lines(consumed.map(i => [i.item_id, i.quantity * runs]), at))
      if (!produced) return { effects: [], dirty: 'recycle completed: recovered fraction unknown' }
      return unplacedDirty(lines(produced.map(o => [o.item_id, o.quantity * runs]), at))
    }

    default: return none
  }
}

/** Parse the ledger's ISO stamps and SQLite's 'YYYY-MM-DD HH:MM:SS' alike. */
function stampMs(s: string | null | undefined): number {
  if (!s) return NaN
  return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`)
}

export interface StorageApplySummary {
  /** deltas applied to storage_inventory from events */
  applied: number
  /** events that matched a command-time ledger row and were attached, not re-applied */
  attached: number
  /** journaled with station NULL — the profile is marked dirty */
  unplaced: number
  /** older than the station's last snapshot, so already counted */
  reflected: number
  dirtyReasons: string[]
}

/**
 * Fold one agent's NEW events into the storage ledger. Idempotent by
 * construction: it runs only on events recordActionEvents just inserted, inside
 * that insert's transaction. Never throws — a defect in one event's handling is
 * reported via swallow() and the rest proceed.
 */
export function applyStorageEvents(profileId: string, events: ActionEvent[], deps: StorageEffectDeps = {}): StorageApplySummary {
  const s: StorageApplySummary = { applied: 0, attached: 0, unplaced: 0, reflected: 0, dirtyReasons: [] }
  for (const e of [...events].sort((a, b) => a.event_id - b.event_id)) {
    try {
      const { effects, dirty } = storageEffects(profileId, e, deps)
      if (dirty) s.dirtyReasons.push(dirty)
      for (const fx of effects) {
        // (a) the command result already applied this: attach the event, do not re-apply.
        if (attachStorageLedgerEvent(profileId, fx.item_id, fx.delta, e.created_at, e.event_id)) { s.attached++; continue }
        if (fx.station_id && fx.confidence !== 'unplaced') {
          // A snapshot taken after the event already contains its effect.
          const obs = stampMs(stationStorageObservedAt(profileId, fx.station_id))
          const at = stampMs(e.created_at)
          if (Number.isFinite(obs) && Number.isFinite(at) && obs >= at) { s.reflected++; continue }
          applyStorageDelta(profileId, fx.station_id, fx.item_id, fx.delta, { source: 'action_log', ref: e.event_type, confidence: fx.confidence, eventId: e.event_id })
          s.applied++
        } else {
          // (c) journal it unplaced; the next view_storage settles the station.
          applyStorageDelta(profileId, null, fx.item_id, fx.delta, { source: 'action_log', ref: e.event_type, confidence: 'unplaced', eventId: e.event_id })
          s.unplaced++
          s.dirtyReasons.push(`${e.event_type} could not be placed at a station`)
        }
      }
    } catch (err) {
      swallow('action-log.applyStorageEvents', err)
      s.dirtyReasons.push(`${e.event_type}: applier error`)
    }
  }
  if (s.unplaced > 0 || s.dirtyReasons.length) {
    markStorageDirty(profileId, s.dirtyReasons[0] ?? 'storage event could not be placed since last view_storage')
  }
  return s
}

/**
 * MONEY THE GAME TAKES ON ITS OWN CLOCK.
 *
 * Taxes, rent, bounty settlements and facility bills are charged server-side
 * between commands. Nothing in the harness is watching the wallet at that
 * moment, so the next command that happens to report a balance finds the wallet
 * lower than the ledger expected and books the whole gap against ITSELF: on
 * 2026-09-13 Ledger Voss's weekly assessment — 305,759 income tax, 4,246
 * property tax, rent — surfaced as a single "unexplained -310,449" pinned to a
 * 66-credit refuel. The money was real and the balance was right; only the
 * reason was lost, which is the one thing an operator actually needs.
 *
 * The game's own action log carries each of these with an exact figure, so book
 * them from there under their own kind. They are `INSERT OR IGNORE`d on
 * (profile_id, order_id, kind) with the event id as the order_id, so a replay
 * or a backfill can never double-charge.
 */
export function moneyRow(e: ActionEvent): { kind: string; amount: number; counterparty: string | null } | null {
  const d = e.data ?? {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const empire = typeof d.empire === 'string' ? d.empire : null
  switch (e.event_type) {
    case 'tax.income_paid': {
      const paid = n(d.paid); return paid ? { kind: 'tax_income', amount: -paid, counterparty: empire } : null
    }
    case 'tax.property_paid': {
      const paid = n(d.paid); return paid ? { kind: 'tax_property', amount: -paid, counterparty: empire } : null
    }
    case 'tax.sales_paid': {
      const paid = n(d.paid) ?? n(d.amount); return paid ? { kind: 'tax_sales', amount: -paid, counterparty: empire } : null
    }
    case 'tax.prepaid': {
      const a = n(d.amount); return a ? { kind: 'tax_prepaid', amount: -a, counterparty: empire } : null
    }
    case 'tax.prepay_refunded': {
      const a = n(d.amount); return a ? { kind: 'tax_refund', amount: a, counterparty: empire } : null
    }
    case 'other.rent_paid': {
      const c = n(d.cost); return c ? { kind: 'rent', amount: -c, counterparty: typeof d.facility === 'string' ? d.facility : null } : null
    }
    case 'other.facility_built':
    case 'other.facility_restored': {
      const c = n(d.cost); return c ? { kind: 'facility', amount: -c, counterparty: typeof d.facility === 'string' ? d.facility : null } : null
    }
    case 'bounty.paid': {
      // Only a settlement from the WALLET moves credits; a released bond does not.
      const a = n(d.amount)
      return a && d.paid_from === 'wallet' ? { kind: 'bounty_paid', amount: -a, counterparty: empire } : null
    }
    default: return null
  }
}

/** Book every money event in `events` that is not already on the ledger. */
export function applyMoneyEvents(profileId: string, events: ActionEvent[]): number {
  let booked = 0
  for (const e of events) {
    try {
      const row = moneyRow(e)
      if (!row || !row.amount) continue
      const res = getDb().query(`
        INSERT OR IGNORE INTO financial_ledger
          (profile_id, kind, item_id, quantity, unit_price, amount_signed, counterparty, order_id, source_command, raw_ref)
        VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
      `).run(profileId, row.kind, Math.round(row.amount), row.counterparty,
             `evt:${e.event_id}`, e.event_type, JSON.stringify(e.data).slice(0, 200))
      if (Number(res.changes ?? 0) > 0) booked++
    } catch (err) { swallow('action-log.applyMoneyEvents', err) }
  }
  return booked
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
): Promise<{ added: number; cargoApplied: number; dirty: boolean; storage: StorageApplySummary; money: number }> {
  const pageSize = opts.pageSize ?? 100
  let added = 0
  let money = 0
  let dirty = false
  const fresh: ActionEvent[] = []
  const storage: StorageApplySummary = { applied: 0, attached: 0, unplaced: 0, reflected: 0, dirtyReasons: [] }
  // A cold cursor means we are back-filling history. Those events are stored for
  // the audit trail but MUST NOT be replayed onto cargo: the feed is paginated and
  // finite, so a replay starting mid-history would apply half a story and invent a
  // hold that never existed. Cargo only advances from events observed live, on top
  // of a real get_cargo snapshot.
  let backfilling = false

  for (const category of CATEGORIES) {
    const cursor = getActionCursor(profileId, category)
    if (cursor === 0) backfilling = true
    // Storage deltas follow the same rule PER CATEGORY: a cold category is history
    // and is banked only; a warm one delivers events that happened since the last
    // ingest, which is exactly what the ledger must absorb.
    const coldCategory = cursor === 0
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
      // re-applying a delta we already applied would double-count it. The storage
      // applier runs inside the insert transaction (see recordActionEvents).
      const insertedIds = new Set(recordActionEvents(profileId, category, parsed, coldCategory ? undefined : (inserted) => {
        const r = applyStorageEvents(profileId, inserted)
        storage.applied += r.applied; storage.attached += r.attached; storage.unplaced += r.unplaced; storage.reflected += r.reflected
        storage.dirtyReasons.push(...r.dirtyReasons)
      }))
      added += insertedIds.size
      const inserted = parsed.filter(p => insertedIds.has(p.event_id))
      for (const p of inserted) fresh.push(p)
      // Obligations fold on EVERY inserted event, backfill included — a rent paid
      // in July is still money gone, and the register exists precisely so that
      // history nobody watched still adds up. Dedupe is the INSERT OR IGNORE above.
      if (inserted.length) recordObligations(profileId, inserted)
      // Same reasoning as obligations: money the game took is money gone whether
      // or not anyone was watching, so book it on backfills too.
      if (inserted.length) money += applyMoneyEvents(profileId, inserted)
      if (!sc?.has_more) break
      // Deep back-fills hammered the API with 429s once before; pace them.
      if (backfilling) await new Promise(r => setTimeout(r, 250))
    }
  }
  if (storage.unplaced > 0 || storage.dirtyReasons.length > 0) dirty = true

  // Back-fill run: events are banked, but nothing is replayed onto the ledger.
  if (backfilling) return { added, cargoApplied: 0, dirty, storage, money }

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
  }
  if (cargoApplied > 0) {
    recordCargoSnapshot(profileId,
      [...cargo.entries()].filter(([, q]) => q > 0).map(([item_id, quantity]) => ({ item_id, quantity })))
  }

  // Kill ledger: seed base rows for fresh battles and enrich them right away via
  // the free `summary` query while the connection is warm. Cap per ingest so a
  // burst of battles cannot stall the turn; the /api/combat enrich endpoint and
  // later ingests pick up any remainder.
  const battles = fresh.filter(e => e.event_type === 'combat.battle_ended').slice(0, 3)
  if (battles.length) {
    try {
      seedBattlesFromEvents(profileId)
      for (const e of battles) {
        const battleId = String(e.data?.battle_id ?? '')
        if (!battleId) continue
        try {
          const r = await connection.execute('summary', { id: battleId }) as { structuredContent?: Record<string, any> }
          const sc = r?.structuredContent
          if (sc?.battle_id) {
            const players = new Set((Array.isArray(sc.player_names) ? sc.player_names : []).map((x: unknown) => String(x)))
            const opponents = (Array.isArray(sc.sides) ? sc.sides : [])
              .flatMap((s: any) => (Array.isArray(s.participants) ? s.participants : []))
              .filter((n: string) => !players.has(n))
            enrichBattle(battleId, {
              category: sc.category, outcome: sc.outcome, system_name: sc.system_name,
              destroyed_names: sc.destroyed_names ?? [], opponents,
              ships_destroyed: sc.ships_destroyed,
            })
          }
        } catch { /* summary unavailable — /api/combat enrich retries later */ }
      }
    } catch { /* ledger never blocks the turn */ }
  }

  return { added, cargoApplied, dirty, storage, money }
}
