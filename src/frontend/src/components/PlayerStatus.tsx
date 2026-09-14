import { useState } from 'react'
import { Shield, Heart, Fuel, Package, Cpu, Zap, MapPin, DollarSign, Rocket } from 'lucide-react'

const LS_KEY = 'admiral-status-compact'

interface Props {
  data: Record<string, unknown> | null
}

export function PlayerStatus({ data }: Props) {
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })

  function toggle() {
    setCompact(v => {
      const next = !v
      try { localStorage.setItem(LS_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="text-[11px] text-muted-foreground italic">No player data -- connect and send get_status to fetch.</span>
      </div>
    )
  }

  const player = (data.player || {}) as Record<string, unknown>
  const ship = (data.ship || {}) as Record<string, unknown>
  const location = (data.location || {}) as Record<string, unknown>

  // slimGameState puts system/poi/credits/faction at top level; full state nests them under player/location
  const systemName = player.current_system || location.system_name || data.system || '?'
  const poiName = player.current_poi || location.poi_name || data.poi || '?'
  const credits = player.credits ?? data.credits ?? 0

  // Ship stats: slimGameState returns pre-formatted strings like "110/110",
  // full state returns separate numeric fields (hull, max_hull, etc.)
  function shipStat(current: string, max: string, slimKey: string): string {
    if (typeof ship[slimKey] === 'string' && (ship[slimKey] as string).includes('/')) {
      return ship[slimKey] as string
    }
    return `${ship[current] || 0}/${ship[max] || 0}`
  }

  // The hull the agent is ACTUALLY flying. `name` is the pilot's custom name and
  // falls back to the class name when they never set one, so show the class as the
  // sub-line only when it differs — otherwise an unnamed ship reads "Warmaul / Warmaul".
  const shipDisplayName = titleCase(
    firstString(ship.name, ship.class_name, ship.class, ship.class_id, ship.ship_name) ?? '',
  )
  const shipClassName = titleCase(firstString(ship.class_name, ship.class, ship.class_id) ?? '')

  const stats: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }[] = [
    {
      icon: <Rocket size={12} />, label: 'Ship',
      value: shipDisplayName || '—',
      sub: shipClassName && shipClassName !== shipDisplayName ? shipClassName : undefined,
      color: 'var(--smui-frost-2)',
    },
    { icon: <MapPin size={12} />, label: 'Location', value: `${systemName}`, sub: String(poiName) },
    { icon: <DollarSign size={12} />, label: 'Credits', value: Number(credits).toLocaleString(), color: 'var(--smui-yellow)' },
    { icon: <Heart size={12} />, label: 'Hull', value: shipStat('hull', 'max_hull', 'hull'), color: 'var(--destructive)' },
    { icon: <Shield size={12} />, label: 'Shield', value: shipStat('shield', 'max_shield', 'shield'), color: 'var(--primary)' },
    { icon: <Fuel size={12} />, label: 'Fuel', value: shipStat('fuel', 'max_fuel', 'fuel'), color: 'var(--smui-orange)' },
    { icon: <Package size={12} />, label: 'Cargo', value: shipStat('cargo_used', 'cargo_capacity', 'cargo'), color: 'var(--smui-green)' },
    { icon: <Cpu size={12} />, label: 'CPU', value: shipStat('cpu_used', 'cpu_capacity', 'cpu'), color: 'var(--smui-purple)' },
    { icon: <Zap size={12} />, label: 'Power', value: shipStat('power_used', 'power_capacity', 'power'), color: 'var(--smui-frost-3)' },
  ]

  if (compact) {
    return (
      <div
        className="flex items-center gap-3 px-3 py-1.5 bg-card border-b border-border cursor-pointer hover:opacity-80 transition-opacity overflow-x-auto"
        onClick={toggle}
      >
        {stats.map(s => (
          <span key={s.label} className="flex items-center gap-1 shrink-0">
            <span style={s.color ? { color: `hsl(${s.color})` } : undefined} className={s.color ? '' : 'text-muted-foreground'}>{s.icon}</span>
            <span className="text-[11px] text-foreground/80">{s.label === 'Location' ? `${s.value}${s.sub && s.sub !== '?' ? ` / ${s.sub}` : ''}` : s.value}</span>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div
      className="group/status grid grid-cols-3 lg:grid-cols-9 gap-[1px] bg-border border-b border-border cursor-pointer hover:opacity-80 transition-opacity"
      onClick={toggle}
    >
      {stats.map(s => <StatCard key={s.label} {...s} />)}
    </div>
  )
}

function StatCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-card p-2.5 px-3">
      <div className="flex items-center gap-1.5 mb-1">
        <span style={color ? { color: `hsl(${color})` } : undefined} className={color ? '' : 'text-muted-foreground'}>{icon}</span>
        <span className="text-[11px] text-muted-foreground tracking-[1.5px] uppercase">{label}</span>
      </div>
      <span
        className="text-lg font-medium tracking-tight block"
        style={color ? { color: `hsl(${color})` } : undefined}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] text-muted-foreground mt-0.5 block truncate">{sub}</span>}
    </div>
  )
}

/** First of the candidates that is a non-empty string. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** `gas_tanker` -> `Gas Tanker`. Ids and display names both arrive here. */
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * The status banner with its live/last-known/empty choice baked in.
 *
 * Both the editor (ProfileView) and the dossier (CharacterPage) show this row,
 * and they must not drift: an agent that reads "docked at War Citadel, hull
 * 500/500" on one page and something else on the other is worse than no banner.
 * So the fallback ladder lives HERE, once, rather than being copied per page.
 *
 * Live `playerData` wins. Otherwise the durable character sheet in
 * profile_last_state (refreshed ~20 min by the server's offline sweep) is
 * rendered under a "last known" label, so a parked agent can still be read
 * without connecting it. With neither, PlayerStatus draws its own empty state.
 */
export function PlayerStatusBanner(
  { profile, playerData }: { profile: Record<string, unknown>; playerData: Record<string, unknown> | null },
) {
  if (playerData) return <PlayerStatus data={playerData} />

  const ls = profile?.last_state as Record<string, unknown> | undefined
  if (!ls) return <PlayerStatus data={null} />

  const synth = {
    system: ls.system, poi: ls.poi, credits: ls.credits,
    ship: {
      // Keep the pilot's name and the hull class in SEPARATE fields — the Ship
      // cell shows the class as a sub-line only when it differs from the name.
      name: ls.ship_name || ls.ship_class,
      class_name: ls.ship_class,
      hull: ls.hull, fuel: ls.fuel, cargo: ls.cargo,
    },
  }
  return (
    <div>
      <div className="px-4 pt-1.5 text-[9px] text-muted-foreground/50 uppercase tracking-[1.5px]">
        last known — {String(ls.updated_at ?? '').slice(5, 16)}Z ({String(ls.ship_class || 'ship ?')})
      </div>
      <PlayerStatus data={synth} />
    </div>
  )
}
