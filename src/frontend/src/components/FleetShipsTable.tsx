import { Rocket } from 'lucide-react'
import { Chip, DISPLAY, ageOf, parseTs } from './character/dossier-shared'

/**
 * One row of GET /api/inventory/ships.
 *
 * `class` is the catalog class_id exactly as list_ships / get_ship report it.
 * The hull fields (`class_name`, `tier`, `hull_class`, `category`, `faction`)
 * are a catalog join keyed on that id; they are null when the catalog has no
 * entry for it, and the table shows "—" for those rather than guessing.
 */
export interface FleetShip {
  profile_id: string
  agent: string
  ship_id: string
  class: string
  custom_name: string
  station_id: string
  module_count: number
  updated_at: string
  is_active?: boolean
  class_name?: string | null
  tier?: number | null
  hull_class?: string | null
  category?: string | null
  faction?: string | null
}

/** The ledger marks the hull an agent is flying with this station id. */
const ACTIVE_STATION = '__active__'
const isActive = (s: FleetShip) => s.is_active ?? s.station_id === ACTIVE_STATION

/**
 * Tier → theme colour, as the HSL-triplet var Chip expects. The catalog runs
 * T0–T5 (24 hulls sit at T5), so T5 gets its own step above the gold T4;
 * T0/T1 stay grey so the higher hulls are the ones that stand out.
 */
const TIER_COLOR: Record<number, string> = {
  5: 'var(--smui-red)',
  4: 'var(--smui-yellow)',
  3: 'var(--smui-purple)',
  2: 'var(--smui-frost-2)',
}
const tierColor = (tier: number) => TIER_COLOR[tier] ?? 'var(--muted-foreground)'

const STALE_MS = 24 * 3600_000

/** Profile names are "Owner - Role"; the listing keys on the owner half. */
const ownerOf = (s: FleetShip) => s.agent.split(' - ')[0]
const roleOf = (s: FleetShip) => s.agent.split(' - ').slice(1).join(' - ')
const hullName = (s: FleetShip) => s.class_name || s.class.replace(/_/g, ' ') || s.ship_id

/** Station ids are readable slugs except player bases, which are 32-hex hashes. */
function whereLabel(stationId: string): string {
  if (/^[0-9a-f]{24,}$/i.test(stationId)) return `base ${stationId.slice(0, 8)}…`
  return stationId.replace(/_/g, ' ') || '—'
}

const TH = 'text-left px-3 py-1.5 text-[10px] uppercase tracking-[1.5px] text-muted-foreground font-medium whitespace-nowrap'

/** Fleet-wide hull roster: grouped by owner, the flying hull first and in green, higher tiers next. */
export function FleetShipsTable({ ships }: { ships: FleetShip[] }) {
  const rows = ships.slice().sort((a, b) =>
    ownerOf(a).localeCompare(ownerOf(b))
    || Number(isActive(b)) - Number(isActive(a))
    || (b.tier ?? -1) - (a.tier ?? -1)
    || hullName(a).localeCompare(hullName(b)))
  const ownerCount = new Set(rows.map(ownerOf)).size
  const unknownCount = rows.filter(s => s.tier == null).length

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[11.5px] tabular-nums">
          <thead style={DISPLAY}>
            <tr className="border-b border-border">
              <th className={TH}>Owner</th>
              <th className={TH}>Ship</th>
              <th className={TH} title="Catalog tier and class of the hull">Tier · Class</th>
              <th className={TH}>Where</th>
              <th className={`${TH} text-right`} title="Fitted modules">Fit</th>
              <th className={`${TH} text-right`} title="When the ledger last saw this hull">Seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => {
              const active = isActive(s)
              const firstOfOwner = i === 0 || ownerOf(rows[i - 1]) !== ownerOf(s)
              const seenTs = parseTs(s.updated_at)
              const stale = seenTs > 0 && Date.now() - seenTs > STALE_MS
              const rowTone = active ? 'text-[hsl(var(--smui-green))]' : 'text-muted-foreground'
              return (
                <tr
                  key={`${s.profile_id}-${s.ship_id}-${s.station_id}`}
                  className={`${firstOfOwner && i > 0 ? 'border-t border-border' : 'border-t border-border/30'} ${rowTone} ${active ? 'bg-[hsl(var(--smui-green)/0.05)]' : ''}`}
                >
                  <td className={`px-3 py-1.5 border-l-2 ${active ? 'border-l-[hsl(var(--smui-green))]' : 'border-l-transparent'}`}>
                    {firstOfOwner && (
                      <>
                        <div className="font-semibold text-foreground whitespace-nowrap" style={DISPLAY}>{ownerOf(s)}</div>
                        {roleOf(s) && <div className="text-[9.5px] text-muted-foreground/70">{roleOf(s)}</div>}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={`font-medium ${active ? '' : 'text-foreground'}`}>{hullName(s)}</span>
                    {s.custom_name && <span className="ml-1.5 italic">“{s.custom_name}”</span>}
                    {s.class_name && s.class && (
                      <span className="ml-1.5 text-[9.5px] font-jetbrains text-muted-foreground/60" title="catalog class id">{s.class}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {s.tier != null ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Chip
                          label={`T${s.tier}`}
                          color={tierColor(s.tier)}
                          filled
                          title={[s.category, s.faction].filter(Boolean).join(' · ') || undefined}
                        />
                        <span className={active ? '' : 'text-foreground'}>{s.hull_class ?? '—'}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60" title={`no catalog entry for class id "${s.class}"`}>—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap" title={s.station_id}>
                    {active ? (
                      <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-[10.5px]">
                        <Rocket size={10} />
                        Active · flying
                      </span>
                    ) : whereLabel(s.station_id)}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {s.module_count} <span className="text-[9.5px] opacity-70">mod</span>
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right whitespace-nowrap ${stale ? 'text-[hsl(var(--smui-orange))]' : ''}`}
                    title={`${s.updated_at}Z${stale ? ' — not seen in over a day' : ''}`}
                  >
                    {ageOf(s.updated_at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 border-t border-border/40 text-[9.5px] text-muted-foreground">
        <span>
          {rows.length} hulls · {ownerCount} owners
          {unknownCount > 0 && <> · {unknownCount} not in catalog (—)</>}
        </span>
        <span className="text-[hsl(var(--smui-green))] font-semibold">green = the hull the agent is flying now</span>
        <span className="inline-flex items-center gap-1">
          {[5, 4, 3, 2, 1].map(t => <Chip key={t} label={t === 1 ? 'T0–1' : `T${t}`} color={tierColor(t)} filled />)}
        </span>
      </div>
    </div>
  )
}
