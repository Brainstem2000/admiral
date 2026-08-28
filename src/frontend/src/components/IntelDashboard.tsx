import { useCallback, useEffect, useState } from 'react'
import { Globe, Radar, TrendingUp, Users, Gem, Factory, Crosshair, AlertTriangle, Skull, RefreshCw } from 'lucide-react'

interface FeedRow { kind: string; name: string; detail: string; by: string; at: string }
interface LeaderRow { by: string; total: number; last_24h: number; systems: number; market: number; players: number; deposits: number; facilities: number }
interface DashData {
  coverage: Record<string, number>
  fresh: Record<string, number>
  feed: FeedRow[]
  leaderboard: LeaderRow[]
  generated_at?: string
}

const KIND_META: Record<string, { icon: typeof Globe; color: string; label: string }> = {
  system:   { icon: Globe,         color: 'text-sky-400',     label: 'system' },
  player:   { icon: Users,         color: 'text-violet-400',  label: 'player' },
  deposit:  { icon: Gem,           color: 'text-emerald-400', label: 'deposit' },
  facility: { icon: Factory,       color: 'text-amber-400',   label: 'facility' },
  threat:   { icon: AlertTriangle, color: 'text-orange-400',  label: 'threat' },
  wreck:    { icon: Skull,         color: 'text-red-400',     label: 'wreck' },
  killzone: { icon: Crosshair,     color: 'text-red-400',     label: 'killzone' },
}

function age(iso: string): string {
  const diff = Date.now() - new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function IntelDashboard() {
  const [data, setData] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(false)
  const [kindFilter, setKindFilter] = useState<string | null>(null)

  const fetchDash = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const resp = await fetch('/api/fleet-intel/dashboard')
      if (resp.ok) setData(await resp.json())
    } catch { /* keep last */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchDash()
    const interval = setInterval(() => fetchDash(true), 30000)
    return () => clearInterval(interval)
  }, [fetchDash])

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        <RefreshCw size={14} className="animate-spin mr-2" /> Loading intelligence…
      </div>
    )
  }

  const c = data.coverage
  const f = data.fresh
  const surveyPct = c.galaxy_charted ? Math.round((c.systems_surveyed / c.galaxy_charted) * 100) : 0
  const feed = kindFilter ? data.feed.filter(r => r.kind === kindFilter) : data.feed

  const cards: Array<{ label: string; value: string; sub: string; icon: typeof Globe; hot?: boolean }> = [
    { label: 'Galaxy surveyed', value: `${c.systems_surveyed} / ${c.galaxy_charted}`, sub: `${surveyPct}% ground-truthed · ${f.systems_24h} updated 24h`, icon: Globe, hot: f.systems_24h > 0 },
    { label: 'Market coverage', value: `${c.stations_priced} stations`, sub: `${c.market_quotes} quotes · ${c.items_priced} items · ${f.market_fresh_30m} fresh <30m`, icon: TrendingUp, hot: f.market_fresh_30m > 0 },
    { label: 'Player census', value: String(c.players_sighted), sub: `${f.sightings_24h} seen in 24h`, icon: Users, hot: f.sightings_24h > 0 },
    { label: 'Resource deposits', value: String(c.deposits), sub: `${f.deposits_24h} surveyed 24h`, icon: Gem, hot: f.deposits_24h > 0 },
    { label: 'Facilities mapped', value: String(c.facilities), sub: `${f.facilities_24h} confirmed 24h`, icon: Factory },
    { label: 'Hazards', value: `${c.threats_active} threats`, sub: `${c.killzones} killzones · ${c.wrecks} wrecks`, icon: AlertTriangle, hot: c.threats_active > 0 },
  ]

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="flex items-center gap-2 text-[12px] uppercase tracking-[2px] text-muted-foreground font-medium">
          <Radar size={13} /> Central Intelligence
        </h2>
        <span className="text-[10px] text-muted-foreground/60">auto-refreshes every 30s · sourced passively from every agent's game traffic</span>
      </div>

      {/* Coverage cards */}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {cards.map(card => (
          <div key={card.label} className="bg-card border border-border px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <card.icon size={10} className={card.hot ? 'text-primary' : ''} /> {card.label}
            </div>
            <div className="text-lg font-semibold tabular-nums leading-tight mt-0.5">{card.value}</div>
            <div className="text-[10px] text-muted-foreground/70 tabular-nums">{card.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr] items-start">
        {/* Discovery feed */}
        <div className="bg-card border border-border">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
            <span className="text-[11px] uppercase tracking-[1.5px] text-muted-foreground font-medium">Discovery feed</span>
            <div className="flex gap-1 ml-auto flex-wrap">
              <button onClick={() => setKindFilter(null)}
                className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border ${!kindFilter ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                all
              </button>
              {Object.entries(KIND_META).map(([k, m]) => (
                <button key={k} onClick={() => setKindFilter(kindFilter === k ? null : k)}
                  className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border ${kindFilter === k ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[480px] overflow-y-auto divide-y divide-border/50">
            {feed.length === 0 && (
              <div className="py-8 text-center text-[11px] text-muted-foreground">Nothing yet — discoveries appear as agents explore.</div>
            )}
            {feed.map((r, i) => {
              const m = KIND_META[r.kind] ?? KIND_META.system
              return (
                <div key={i} className="flex items-baseline gap-2 px-3 py-1.5 text-[12px]">
                  <m.icon size={11} className={`${m.color} flex-none self-center`} />
                  <span className="font-medium whitespace-nowrap">{r.name}</span>
                  <span className="text-muted-foreground truncate min-w-0">{r.detail}</span>
                  <span className="ml-auto flex-none text-[10px] text-muted-foreground/60 whitespace-nowrap">
                    {r.by ? `${r.by.split(' - ')[0]} · ` : ''}{age(r.at)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Leaderboard */}
        <div className="bg-card border border-border">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-[11px] uppercase tracking-[1.5px] text-muted-foreground font-medium">Contribution leaderboard</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left px-3 py-1.5">Agent</th>
                  <th className="text-right px-2 py-1.5">24h</th>
                  <th className="text-right px-2 py-1.5">Sys</th>
                  <th className="text-right px-2 py-1.5">Mkt</th>
                  <th className="text-right px-2 py-1.5">Plr</th>
                  <th className="text-right px-2 py-1.5">Dep</th>
                  <th className="text-right px-2 py-1.5">Fac</th>
                  <th className="text-right px-3 py-1.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.leaderboard.map(row => (
                  <tr key={row.by} className="border-t border-border/50">
                    <td className="px-3 py-1.5 font-medium whitespace-nowrap">{row.by.split(' - ')[0]}</td>
                    <td className={`text-right px-2 ${row.last_24h > 0 ? 'text-primary font-semibold' : 'text-muted-foreground/50'}`}>{row.last_24h}</td>
                    <td className="text-right px-2">{row.systems}</td>
                    <td className="text-right px-2">{row.market}</td>
                    <td className="text-right px-2">{row.players}</td>
                    <td className="text-right px-2">{row.deposits}</td>
                    <td className="text-right px-2">{row.facilities}</td>
                    <td className="text-right px-3 font-semibold">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 text-[10px] text-muted-foreground/60 border-t border-border/50">
            Rows = intel records attributed to each agent. Bulk map refreshes credit the fetching agent; per-visit surveys, sightings and deposits are genuine field work.
          </div>
        </div>
      </div>
    </div>
  )
}
