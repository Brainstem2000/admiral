import {
  insertFactionLedger, recordFactionStorageSnapshot, recordFactionTreasurySnapshot, applyFactionStorageDelta,
  getProfileLastState, getMostRecentStation, getProfile, getKnownFactionId, listProfiles,
} from './db'
import type { FactionLedgerRow } from './db'

type R = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** faction_id/tag last seen in any faction payload, per profile — transfer results do not repeat them. */
const factionByProfile = new Map<string, { id: string | null; tag: string | null }>()

function rememberFaction(profileId: string, r: R): void {
  const id = str(r.faction_id) || null
  const tag = str(r.faction_tag) || null
  if (id || tag) factionByProfile.set(profileId, { id: id ?? factionByProfile.get(profileId)?.id ?? null, tag: tag ?? factionByProfile.get(profileId)?.tag ?? null })
}

/**
 * Ingest the faction's own AUDIT LOG, which rides along on every `view_faction_storage`
 * reply as `recent_activity` and which we threw away for the whole campaign.
 *
 * This is the only record of what faction members OUTSIDE the harness do. Admiral's
 * ledger is otherwise built from our own agents' command replies, so UMan — Quartermaster,
 * hand-played, not a profile here — deposited into the vault and left no row anywhere.
 * Brian asked three times why his deposits were missing. They were missing because nobody
 * read this array, not because the game withholds it: the faction docs say plainly that
 * "every deposit and withdrawal is written to an audit log the whole faction can review",
 * and `view_faction_storage` is where it is served.
 *
 * Two details that matter:
 *  - Entries are keyed by PLAYER NAME ("UMan"), not by profile id, because most of the
 *    faction is not us. The name is kept verbatim in raw_ref and mapped to a profile id
 *    only when it actually matches one of ours.
 *  - Quantities come with DISPLAY names ("Lead Ore"). The same reply carries the item
 *    list with both id and name, so the map is built from the payload itself and only
 *    falls back to slugifying when an item has since left the vault entirely.
 */
function ingestFactionAuditLog(
  entries: R[], station: string, fac: { id: string | null; tag: string | null }, items: R[] | null,
): number {
  const nameToId = new Map<string, string>()
  for (const i of items ?? []) {
    const id = str(i.item_id), nm = str(i.name) || str(i.item_name)
    if (id && nm) nameToId.set(nm.toLowerCase(), id)
  }
  const byName = new Map<string, string>()
  for (const p of listProfiles()) {
    // Game handles drop spaces and punctuation ("JunoFreight" for "Juno Freight - Trader").
    const base = p.name.split(' -')[0].trim()
    byName.set(base.toLowerCase(), p.id)
    byName.set(base.replace(/[^A-Za-z0-9]/g, '').toLowerCase(), p.id)
  }

  let rows = 0
  for (const e of entries) {
    const player = str(e.player)
    const action = str(e.action)
    const qty = num(e.quantity)
    const itemName = str(e.item)
    const ts = str(e.timestamp)
    if (!player || !qty || !itemName || !ts) continue
    const deposit = /deposit/i.test(action)
    const withdraw = /withdraw/i.test(action)
    if (!deposit && !withdraw) continue          // credits and admin entries are not stock

    const itemId = nameToId.get(itemName.toLowerCase())
      ?? itemName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    const profileId = byName.get(player.toLowerCase())
      ?? byName.get(player.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
      ?? null

    const ok = insertFactionLedger({
      timestamp: ts.replace('T', ' ').replace(/\..*$/, ''),
      faction_id: fac.id, faction_tag: fac.tag,
      kind: deposit ? 'lockbox_deposit' : 'lockbox_withdraw',
      profile_id: profileId,
      station_id: station,
      item_id: itemId,
      quantity: Math.abs(qty),
      credits_signed: null,
      source_command: 'audit_log',
      raw_ref: JSON.stringify({ source: 'faction_audit_log', player, action, item: itemName, quantity: qty }),
      tick: null,
      // Nanosecond stamps are unique per entry, so replays of the same view book once.
      dedupe_key: `audit:${player}:${action}:${itemId}:${qty}:${ts}`,
    })
    if (ok) rows += 1
  }
  return rows
}

function factionFor(profileId: string, r: R): { id: string | null; tag: string | null } {
  rememberFaction(profileId, r)
  const known = factionByProfile.get(profileId)
  const st = known?.id ? null : (getProfileLastState(profileId) as R | null)
  // Fall through every source rather than returning the first MAP HIT: a remembered entry can
  // carry a tag with a null id, and a null id here means the ledger row is written unattributed
  // and the vault delta keyed on it is skipped entirely. The disk-wide id is the last resort —
  // it is what makes movements survive a restart, which empties factionByProfile.
  const id = known?.id ?? (st ? str(st.faction_id) || null : null) ?? getKnownFactionId()
  const tag = known?.tag ?? (st ? str(st.faction_tag) || null : null)
  return { id, tag }
}

/** Where the agent is docked right now, for transfer results that omit base_id. */
function stationFor(profileId: string, args?: R, r?: R, hint?: string | null): string | null {
  if (hint) return hint
  const fromPayload = str(r?.base_id) || str(r?.station_id) || str(args?.base_id) || str(args?.station_id)
  if (fromPayload) return fromPayload
  const st = getProfileLastState(profileId) as R | null
  const docked = st ? (str(st.docked_at) || str(st.station_id) || str(st.base_id)) : ''
  if (docked) return docked
  return getMostRecentStation(profileId)
}

/** Unwrap {result:{...}} and lib_v2 {details:{...}} the same way the credit ledger does. */
function unwrap(data: unknown): { r: R; outer: R | null } {
  if (!data || typeof data !== 'object') return { r: {}, outer: null }
  let r = data as R
  if (!('action' in r) && r.result && typeof r.result === 'object') r = r.result as R
  let outer: R | null = null
  if (!('action' in r) && r.details && typeof r.details === 'object') { outer = r; r = r.details as R }
  return { r, outer }
}

function bare(command: string): string {
  return command.replace(/^spacemolt_/, '').replace(/^(?:storage|faction|faction_admin|social|transfer)_/, '')
}

function isError(data: unknown): boolean {
  return !!(data && typeof data === 'object' && (data as R).error)
}

export interface CaptureOptions { at?: string; source?: string; station?: string | null }

/**
 * Book faction treasury / lockbox movements and snapshots from one command result.
 * Called for EVERY successful result (queries included) on both the LLM tool path and
 * the manual command path. Must never throw. Returns the number of ledger rows written.
 */
export function captureFactionFromCommand(command: string, args: R | undefined, data: unknown, profileId: string, profileName: string, opts: CaptureOptions = {}): number {
  try {
    if (isError(data)) return 0
    const { r, outer } = unwrap(data)
    const cmd = bare(command)
    const action = str(r.action) || cmd
    const tick = num(outer?.tick) ?? num(r.tick) ?? num((data as R)?.tick) ?? null
    const source = opts.source ?? command
    let rows = 0
    let raw: string | null = null
    try { raw = JSON.stringify(r).slice(0, 200) } catch { /* ignore */ }
    const fac = factionFor(profileId, r)
    const stamp = opts.at ?? new Date().toISOString().slice(0, 16)   // minute granularity when no tick

    // 1) The lockbox listing (docked station) + the treasury balance it carries.
    if (action === 'view_faction_storage' || (cmd === 'view' && str(args?.target) === 'faction') || cmd === 'view_faction_storage') {
      const station = str(r.base_id) || stationFor(profileId, args, r, opts.station)
      const items = Array.isArray(r.items) ? (r.items as R[]) : null
      if (station && items && fac.id) {
        recordFactionStorageSnapshot(fac.id, station, items
          .filter((i) => i && typeof i.item_id === 'string' && typeof i.quantity === 'number')
          .map((i) => ({ item_id: String(i.item_id), item_name: str(i.name) || str(i.item_name), quantity: Number(i.quantity) })), profileName, opts.at)
      }
      const credits = num(r.credits)
      if (credits !== null) recordFactionTreasurySnapshot(fac.id, credits, profileName, source, opts.at)
      // The faction's own audit log rides along here. It is the ONLY record of members
      // outside the harness, so it is booked even though this branch is otherwise a
      // read — see ingestFactionAuditLog.
      const activity = Array.isArray(r.recent_activity) ? (r.recent_activity as R[]) : null
      if (station && activity && fac.id) return ingestFactionAuditLog(activity, station, fac, items)
      return 0
    }

    // 2) Lockbox item transfers. lib_v2 answers { action: transfer, source, destination, item_id, quantity }.
    if (action === 'transfer' || cmd === 'deposit' || cmd === 'deposit_items' || cmd === 'withdraw' || cmd === 'withdraw_items' || cmd === 'faction_deposit_items' || cmd === 'faction_withdraw_items') {
      const src = str(r.source) || str(args?.source)
      const dst = str(r.destination) || str(r.target) || str(args?.target)
      const toFaction = dst === 'faction' || cmd === 'faction_deposit_items'
      const fromFaction = src === 'faction' || cmd === 'faction_withdraw_items'
      if (!toFaction && !fromFaction) return 0
      const station = stationFor(profileId, args, r, opts.station)
      const lines: Array<{ item_id: string; quantity: number }> = []
      if (str(r.item_id) && num(r.quantity) !== null) lines.push({ item_id: str(r.item_id), quantity: Number(r.quantity) })
      else if (str(args?.item_id) && num(args?.quantity) !== null) lines.push({ item_id: str(args?.item_id), quantity: Number(args?.quantity) })
      else if (Array.isArray(args?.items)) {
        for (const it of args!.items as R[]) if (str(it.item_id) && num(it.quantity) !== null && Number(it.quantity) > 0) lines.push({ item_id: str(it.item_id), quantity: Number(it.quantity) })
      }
      // CREDITS MOVE AS AN ITEM. The transfer API refuses a bare `credits` argument
      // ("item_id is required for transfer. Use item_id=\"credits\"") so a treasury
      // draw is spelled withdraw{source:faction, item_id:"credits", quantity:N}.
      // Booking that as a lockbox ITEM lost 1,900,000 credits of real withdrawals
      // across three draws on 2026-09-15: they carried credits_signed NULL, so the
      // treasury statement could not attribute them and reported the money as
      // "unattributed outflow", and the vault would list "credits" as stock.
      // Route it to the treasury side instead, on both directions.
      const creditLine = lines.find((l) => l.item_id.toLowerCase() === 'credits')
      if (creditLine) {
        const kind: FactionLedgerRow['kind'] = toFaction ? 'treasury_deposit' : 'treasury_withdraw'
        const signed = toFaction ? Math.round(creditLine.quantity) : -Math.round(creditLine.quantity)
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind, profile_id: profileId, station_id: station,
          item_id: null, quantity: null, credits_signed: signed, source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:${kind}:${creditLine.quantity}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      const itemLines = lines.filter((l) => l.item_id.toLowerCase() !== 'credits')

      // Credits moved with deposit{credits,target:faction} are treasury, not lockbox.
      const creditsArg = num(args?.credits)
      if (creditsArg !== null && creditsArg > 0 && toFaction) {
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind: 'treasury_deposit', profile_id: profileId, station_id: station,
          item_id: null, quantity: null, credits_signed: Math.round(creditsArg), source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:treasury_deposit:${creditsArg}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      for (const l of itemLines) {
        const kind: FactionLedgerRow['kind'] = toFaction ? 'lockbox_deposit' : 'lockbox_withdraw'
        const signedQty = toFaction ? l.quantity : -l.quantity
        const booked = insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind, profile_id: profileId, station_id: station,
          item_id: l.item_id, quantity: signedQty, credits_signed: null, source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:${kind}:${l.item_id}:${l.quantity}:${tick ?? stamp}`, timestamp: opts.at })
        rows += booked ? 1 : 0
        // The vault inventory moves with the ledger, not only on the next view_faction_storage.
        // Gated on `booked` because that row's UNIQUE dedupe_key is the idempotency token — a
        // replayed result must not apply the delta twice. See applyFactionStorageDelta.
        if (booked && fac.id && station) applyFactionStorageDelta(fac.id, station, l.item_id, signedQty, profileName)
      }
      return rows
    }

    // 3) Treasury credits: gifts to faction:*, explicit deposits/withdrawals.
    if (action === 'faction_gift' || action === 'send_gift' || cmd === 'send_gift') {
      const recipient = str(r.recipient) || str(args?.recipient)
      const credits = num(r.credits_sent)
      if (credits !== null && credits > 0 && (action === 'faction_gift' || recipient.toLowerCase().startsWith('faction:'))) {
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag || (recipient.split(':')[1] ?? null), kind: 'treasury_gift', profile_id: profileId,
          station_id: stationFor(profileId, args, r, opts.station), item_id: null, quantity: null, credits_signed: Math.round(credits), source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:treasury_gift:${credits}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      return rows
    }
    if (action === 'faction_deposit_credits' || action === 'deposit_credits' || cmd === 'faction_deposit_credits') {
      const amount = num(r.amount) ?? num(r.credits_deposited) ?? num(r.deposited) ?? num(args?.amount)
      if (amount !== null && amount > 0) {
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind: 'treasury_deposit', profile_id: profileId, station_id: stationFor(profileId, args, r, opts.station),
          item_id: null, quantity: null, credits_signed: Math.round(amount), source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:treasury_deposit:${amount}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      const bal = num(r.treasury) ?? num(r.faction_treasury) ?? num(r.treasury_balance)
      if (bal !== null) recordFactionTreasurySnapshot(fac.id, bal, profileName, source, opts.at)
      return rows
    }
    if (action === 'faction_withdraw_credits' || action === 'withdraw_credits' || cmd === 'faction_withdraw_credits') {
      const amount = num(r.amount) ?? num(r.credits_withdrawn) ?? num(r.withdrawn) ?? num(args?.amount)
      if (amount !== null && amount > 0) {
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind: 'treasury_withdraw', profile_id: profileId, station_id: stationFor(profileId, args, r, opts.station),
          item_id: null, quantity: null, credits_signed: -Math.round(amount), source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:treasury_withdraw:${amount}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      const bal = num(r.treasury) ?? num(r.faction_treasury) ?? num(r.treasury_balance)
      if (bal !== null) recordFactionTreasurySnapshot(fac.id, bal, profileName, source, opts.at)
      return rows
    }

    // 4) Any other payload that states the treasury balance (faction info screens).
    const bal = num(r.treasury_balance) ?? num(r.faction_treasury) ?? (str(r.action).startsWith('faction') ? num(r.treasury) : null)
    if (bal !== null) recordFactionTreasurySnapshot(fac.id, bal, profileName, source, opts.at)
    return rows
  } catch { return 0 /* must never break game execution */ }
}

/** Name used for the actor in snapshots when only the id is known. */
export function displayNameFor(profileId: string): string {
  return getProfile(profileId)?.name ?? profileId
}
