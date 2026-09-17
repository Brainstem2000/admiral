/**
 * Ship-commission bill accounting.
 *
 * Kept out of the route because the interesting part is not HTTP — it is WHICH
 * STORAGE the yard can actually reach, which is the opposite of a facility build
 * and has cost this project real money when confused (plan §30):
 *
 *   facility_build     -> packages, FACTION STORAGE at the station, then cargo.
 *                         Never a personal locker.
 *   supply_commission  -> the pilot's CARGO, then the pilot's PERSONAL locker.
 *                         Never faction storage — that applies only at a station
 *                         the faction owns, and we own none.
 *
 * A part in the vault is therefore in the right station and the wrong pocket.
 * `commission_ready` counts cargo + locker ONLY; vault surfaces as an action.
 */

export type ShipLineStatus = 'ready' | 'withdraw' | 'withdraw_partial' | 'other_vault' | 'fetch' | 'short'

export interface ShipLine {
  item_id: string
  name: string
  needed: number
  cargo: number
  locker: number
  commission_ready: number
  vault: number
  elsewhere: number
  other_vaults: number
  short: number
  pct: number
  status: ShipLineStatus
}

export interface ShipBuildInput {
  bill: Array<{ item_id: string; quantity: number }>
  cargo: Map<string, number>
  locker: Map<string, number>
  vault: Map<string, number>
  /** Fleet stock outside this station — personal lockers AND other faction
   *  vaults. Consulted ONLY when the local picture cannot cover the line: a
   *  fleet-wide sum is the trap this module exists to avoid (see
   *  `scope-before-quoting`). */
  elsewhereFor: (itemId: string) => number
  /** Stock in OTHER faction vaults specifically. The faction holds stock at
   *  seven stations and every one is withdrawable, but only crimson_war_citadel
   *  accepts deposits — so this is a retrieval run, not a lookup. Reported apart
   *  from `elsewhere` because the action differs: a faction vault needs
   *  withdraw-at-source then deposit here, a personal locker needs its owner. */
  otherVaultsFor?: (itemId: string) => number
}

export interface ShipBuildResult {
  lines: ShipLine[]
  /** The BINDING ratio, not the average: a ship 100% stocked on sixteen lines and
   *  0% on the seventeenth cannot be commissioned at all. */
  pct: number
  binding: string | null
  ready_count: number
  withdraw_count: number
  total: number
}

export function computeShipBuild(input: ShipBuildInput): ShipBuildResult {
  const lines: ShipLine[] = input.bill.map(m => {
    const cargo = input.cargo.get(m.item_id) ?? 0
    const locker = input.locker.get(m.item_id) ?? 0
    const vault = input.vault.get(m.item_id) ?? 0
    const ready = cargo + locker
    const short = Math.max(0, m.quantity - ready)
    const elsewhere = short > 0 ? input.elsewhereFor(m.item_id) : 0
    const otherVaults = short > 0 && input.otherVaultsFor ? input.otherVaultsFor(m.item_id) : 0

    // Vault stock ALWAYS implies a withdrawal, even when it does not cover the
    // whole line. Reporting fury_alloy (116 vaulted, 120 needed) as merely
    // "fetch" would hide the 116 we are standing on and dispatch a hauler for
    // the full line.
    const status: ShipLineStatus =
        short === 0      ? 'ready'
      : vault >= short   ? 'withdraw'
      : vault > 0        ? 'withdraw_partial'
      : otherVaults > 0  ? 'other_vault'      // OURS, wrong station — a retrieval run
      : elsewhere > 0    ? 'fetch'
      :                    'short'

    return {
      item_id: m.item_id,
      name: String(m.item_id).replace(/_/g, ' '),
      needed: m.quantity,
      cargo, locker, commission_ready: ready, vault, elsewhere, other_vaults: otherVaults, short,
      pct: m.quantity > 0 ? Math.min(1, ready / m.quantity) : 1,
      status,
    }
  })

  return {
    lines,
    pct: lines.length ? Math.min(...lines.map(l => l.pct)) : 0,
    binding: lines.filter(l => l.short > 0).sort((a, b) => a.pct - b.pct)[0]?.item_id ?? null,
    ready_count: lines.filter(l => l.status === 'ready').length,
    withdraw_count: lines.filter(l => l.status === 'withdraw' || l.status === 'withdraw_partial').length,
    total: lines.length,
  }
}

/** Parse the live agent state's cargo strings ("item_id xN") into a map. */
export function parseCargoItems(raw: unknown[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of raw ?? []) {
    const m = /^(\S+)\s+x\s*(\d+)$/.exec(String(entry).trim())
    if (m) out.set(m[1], (out.get(m[1]) ?? 0) + Number(m[2]))
  }
  return out
}
