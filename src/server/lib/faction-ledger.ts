import {
  insertFactionLedger, recordFactionStorageSnapshot, recordFactionTreasurySnapshot,
  getProfileLastState, getMostRecentStation, getProfile,
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

function factionFor(profileId: string, r: R): { id: string | null; tag: string | null } {
  rememberFaction(profileId, r)
  const known = factionByProfile.get(profileId)
  if (known) return known
  const st = getProfileLastState(profileId) as R | null
  const id = st ? str(st.faction_id) || null : null
  const tag = st ? str(st.faction_tag) || null : null
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
      // Credits moved with deposit{credits,target:faction} are treasury, not lockbox.
      const creditsArg = num(args?.credits)
      if (creditsArg !== null && creditsArg > 0 && toFaction) {
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind: 'treasury_deposit', profile_id: profileId, station_id: station,
          item_id: null, quantity: null, credits_signed: Math.round(creditsArg), source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:treasury_deposit:${creditsArg}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
      }
      for (const l of lines) {
        const kind: FactionLedgerRow['kind'] = toFaction ? 'lockbox_deposit' : 'lockbox_withdraw'
        rows += insertFactionLedger({ faction_id: fac.id, faction_tag: fac.tag, kind, profile_id: profileId, station_id: station,
          item_id: l.item_id, quantity: toFaction ? l.quantity : -l.quantity, credits_signed: null, source_command: source, raw_ref: raw, tick,
          dedupe_key: `${profileId}:${kind}:${l.item_id}:${l.quantity}:${tick ?? stamp}`, timestamp: opts.at }) ? 1 : 0
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
