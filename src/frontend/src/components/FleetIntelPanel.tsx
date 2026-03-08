import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, TrendingUp, Globe, RefreshCw } from 'lucide-react'
import type { FleetIntelData, MarketIntel, SystemIntel, ThreatIntel } from '@shared/fleet-intel-types'

type Tab = 'market' | 'systems' | 'threats'

export function FleetIntelPanel() {
  const [expanded, setExpanded] = useState(true)
  const [tab, setTab] = useState<Tab>('market')
  const [data, setData] = useState<FleetIntelData | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchIntel = useCallback(async () => {
    try {
      setLoading(true)
      const resp = await fetch('/api/fleet-intel')
      if (resp.ok) {
        setData(await resp.json())
      }
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchIntel()
    const interval = setInterval(fetchIntel, 30000)
    return () => clearInterval(interval)
  }, [fetchIntel])

  const threatCount = data?.threats.length || 0

  return (
    <div className="absolute top-3 left-3 z-20 bg-card/95 border border-border backdrop-blur-sm min-w-[280px] max-w-[360px]">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/30 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-[11px] text-muted-foreground uppercase tracking-[1.5px] font-medium">Fleet Intel</span>
        {threatCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-orange-400 ml-auto">
            <AlertTriangle size={10} /> {threatCount}
          </span>
        )}
        {!threatCount && (
          <span className="text-[10px] text-muted-foreground/50 ml-auto">
            {data ? `${data.market.length} prices · ${data.systems.length} systems` : '...'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border">
          {/* Tabs */}
          <div className="flex border-b border-border">
            {([
              { id: 'market' as Tab, label: 'Market', icon: TrendingUp },
              { id: 'systems' as Tab, label: 'Systems', icon: Globe },
              { id: 'threats' as Tab, label: 'Threats', icon: AlertTriangle },
            ]).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${
                  tab === t.id
                    ? 'text-primary border-b border-primary -mb-px'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <t.icon size={10} />
                {t.label}
                {t.id === 'threats' && threatCount > 0 && (
                  <span className="text-orange-400 font-bold">{threatCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="max-h-[300px] overflow-y-auto">
            {!data || loading ? (
              <div className="flex items-center justify-center py-6 text-[11px] text-muted-foreground">
                <RefreshCw size={12} className={loading ? 'animate-spin mr-2' : 'mr-2'} />
                {loading ? 'Loading...' : 'No intel yet'}
              </div>
            ) : tab === 'market' ? (
              <MarketTab data={data.market} />
            ) : tab === 'systems' ? (
              <SystemsTab data={data.systems} />
            ) : (
              <ThreatsTab data={data.threats} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MarketTab({ data }: { data: MarketIntel[] }) {
  if (data.length === 0) {
    return <Empty message="No market data. Agents will collect prices as they visit stations." />
  }

  // Group by station, show most recent first
  const byStation = new Map<string, MarketIntel[]>()
  for (const m of data) {
    const key = m.station_name || m.station_id
    if (!byStation.has(key)) byStation.set(key, [])
    byStation.get(key)!.push(m)
  }

  return (
    <div className="divide-y divide-border/30">
      {[...byStation.entries()].slice(0, 8).map(([station, items]) => (
        <div key={station} className="px-3 py-2">
          <div className="text-[11px] font-medium text-foreground mb-1">{station}</div>
          <div className="text-[10px] text-muted-foreground/60 mb-1">{items[0].system_name}</div>
          <div className="space-y-0.5">
            {items.slice(0, 5).map(item => (
              <div key={item.item_id} className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">{formatItemName(item.item_id)}</span>
                <span className="font-mono">
                  {item.best_sell != null && <span className="text-green-400">{item.best_sell}↓</span>}
                  {item.best_sell != null && item.best_buy != null && <span className="text-muted-foreground/30 mx-0.5">/</span>}
                  {item.best_buy != null && <span className="text-blue-400">{item.best_buy}↑</span>}
                </span>
              </div>
            ))}
            {items.length > 5 && (
              <div className="text-[9px] text-muted-foreground/40">+{items.length - 5} more</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function SystemsTab({ data }: { data: SystemIntel[] }) {
  if (data.length === 0) {
    return <Empty message="No system intel. Agents will map systems as they explore." />
  }

  return (
    <div className="divide-y divide-border/30">
      {data.slice(0, 20).map(sys => (
        <div key={sys.system_id} className="px-3 py-1.5 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-foreground">{sys.system_name}</span>
              {sys.empire && (
                <span className="text-[9px] text-muted-foreground/60 capitalize">{sys.empire}</span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
              <span>{sys.poi_count} POIs</span>
              {sys.has_station && <span className="text-green-400/80">⬡ Station</span>}
              {sys.resources && <span className="truncate">{sys.resources}</span>}
            </div>
            {sys.station_services && (
              <div className="text-[9px] text-muted-foreground/50 mt-0.5 truncate">
                {sys.station_services}
              </div>
            )}
          </div>
          <div className="text-[9px] text-muted-foreground/40 shrink-0">{sys.discovered_by}</div>
        </div>
      ))}
    </div>
  )
}

function ThreatsTab({ data }: { data: ThreatIntel[] }) {
  if (data.length === 0) {
    return <Empty message="No active threats. All clear." />
  }

  return (
    <div className="divide-y divide-border/30">
      {data.map(threat => (
        <div key={threat.id} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <AlertTriangle size={10} className="text-orange-400 shrink-0" />
            <span className="text-[11px] font-medium text-foreground">{threat.system_name}</span>
            <span className="text-[9px] text-muted-foreground/60 capitalize ml-auto">{threat.threat_type}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 pl-[18px]">{threat.description}</div>
          <div className="text-[9px] text-muted-foreground/40 mt-0.5 pl-[18px]">
            {threat.reported_by} · {formatAge(threat.reported_at)}
          </div>
        </div>
      ))}
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <div className="px-3 py-6 text-center text-[10px] text-muted-foreground/50">
      {message}
    </div>
  )
}

function formatItemName(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
