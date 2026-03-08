import { useState } from 'react'
import { Shield, Heart, Fuel, Package, Cpu, Zap, MapPin, DollarSign, Flag } from 'lucide-react'

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
  const factionRaw = data.faction ?? player.faction
  const factionName = factionRaw && typeof factionRaw === 'object' ? (factionRaw as Record<string, unknown>).name : factionRaw
  const factionTag = data.faction_tag ?? (factionRaw && typeof factionRaw === 'object' ? (factionRaw as Record<string, unknown>).tag : undefined)

  // Ship stats: slimGameState returns pre-formatted strings like "110/110",
  // full state returns separate numeric fields (hull, max_hull, etc.)
  function shipStat(current: string, max: string, slimKey: string): string {
    if (typeof ship[slimKey] === 'string' && (ship[slimKey] as string).includes('/')) {
      return ship[slimKey] as string
    }
    return `${ship[current] || 0}/${ship[max] || 0}`
  }

  const stats: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }[] = [
    { icon: <MapPin size={12} />, label: 'Location', value: `${systemName}`, sub: String(poiName) },
    ...(factionName ? [{ icon: <Flag size={12} />, label: 'Faction', value: String(factionName), sub: factionTag ? `[${factionTag}]` : undefined, color: 'var(--smui-frost-2)' }] : []),
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
      className="group/status grid grid-cols-4 lg:grid-cols-8 gap-[1px] bg-border border-b border-border cursor-pointer hover:opacity-80 transition-opacity"
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
