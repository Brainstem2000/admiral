import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ArrowDown, Loader2, Clock, DollarSign, Cpu, Users } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Profile, LogEntry, LogType } from '@/types'

type Tab = 'timeline' | 'financial' | 'tokens'

const BADGE_CLASS: Record<string, string> = {
  connection: 'log-badge-connection',
  error: 'log-badge-error',
  llm_call: 'log-badge-llm_call',
  llm_thought: 'log-badge-llm_thought',
  tool_call: 'log-badge-tool_call',
  tool_result: 'log-badge-tool_result',
  server_message: 'log-badge-server_message',
  notification: 'log-badge-notification',
  system: 'log-badge-system',
}

const TYPE_LABELS: Record<string, string> = {
  connection: 'CONNECT', error: 'ERROR', llm_call: 'CALL',
  llm_thought: 'LLM', tool_call: 'TOOL', tool_result: 'RESULT',
  server_message: 'SERVER', notification: 'NOTIFY', system: 'SYSTEM',
}

// Distinct colors for agents in the timeline
const AGENT_COLORS = [
  'hsl(var(--smui-primary))',
  'hsl(var(--smui-green))',
  'hsl(var(--smui-orange))',
  'hsl(var(--smui-frost-1))',
  'hsl(var(--smui-yellow))',
  '#c084fc', '#f472b6', '#67e8f9',
]

interface Props {
  profiles: Profile[]
  statuses: Record<string, { connected: boolean; running: boolean }>
}

export function AnalyticsPane({ profiles, statuses }: Props) {
  const [tab, setTab] = useState<Tab>('timeline')

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'timeline', label: 'Timeline', icon: <Clock size={12} /> },
    { key: 'financial', label: 'Financial', icon: <DollarSign size={12} /> },
    { key: 'tokens', label: 'Token Economics', icon: <Cpu size={12} /> },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 bg-card border-b border-border px-2 py-1.5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
              tab === t.key
                ? 'text-primary bg-primary/10 border border-primary/30'
                : 'text-muted-foreground hover:text-foreground border border-transparent'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === 'timeline' && <TimelineTab profiles={profiles} statuses={statuses} />}
        {tab === 'financial' && <FinancialTab profiles={profiles} />}
        {tab === 'tokens' && <TokensTab profiles={profiles} />}
      </div>
    </div>
  )
}

// ---- Timeline Tab ----

function TimelineTab({ profiles, statuses }: { profiles: Profile[]; statuses: Record<string, { connected: boolean; running: boolean }> }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [filterProfiles, setFilterProfiles] = useState<Set<string>>(() => new Set(profiles.map(p => p.id)))
  const scrollRef = useRef<HTMLDivElement>(null)

  const profileMap = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>()
    profiles.forEach((p, i) => m.set(p.id, { name: p.name, color: AGENT_COLORS[i % AGENT_COLORS.length] }))
    return m
  }, [profiles])

  useEffect(() => {
    const es = new EventSource('/api/analytics/timeline?stream=true')

    es.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry
        setEntries(prev => {
          if (prev.some(e => e.id === entry.id)) return prev
          const next = [...prev, entry].sort((a, b) => a.id - b.id)
          if (next.length > 1000) return next.slice(-800)
          return next
        })
      } catch { /* heartbeat */ }
    }

    return () => es.close()
  }, [])

  const filtered = useMemo(() =>
    filterProfiles.size === profiles.length
      ? entries
      : entries.filter(e => filterProfiles.has(e.profile_id)),
    [entries, filterProfiles, profiles.length]
  )

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 20,
    getItemKey: (index) => filtered[index]?.id ?? index,
  })

  useEffect(() => {
    if (autoScroll && filtered.length > 0) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
      })
    }
  }, [filtered.length, autoScroll])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40)
  }, [])

  function toggleProfile(id: string) {
    setFilterProfiles(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full relative">
      {/* Agent filter chips */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50 flex-wrap">
        <Users size={11} className="text-muted-foreground mr-1" />
        {profiles.map((p, i) => {
          const color = AGENT_COLORS[i % AGENT_COLORS.length]
          const active = filterProfiles.has(p.id)
          return (
            <button
              key={p.id}
              onClick={() => toggleProfile(p.id)}
              className={`flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${
                active ? 'border-current' : 'border-transparent opacity-40'
              }`}
              style={{ color }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
              {p.name}
              {statuses[p.id]?.running && <Loader2 size={8} className="animate-spin" />}
            </button>
          )
        })}
      </div>

      {/* Virtualized timeline */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto text-xs">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            No activity yet. Connect agents to see the unified timeline.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const entry = filtered[virtualRow.index]
              const agent = profileMap.get(entry.profile_id)
              return (
                <div
                  key={entry.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="border-b border-border/30 hover:bg-secondary/20">
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: agent?.color || '#888' }}
                        title={agent?.name || entry.profile_id}
                      />
                      <span className="text-[10px] font-medium shrink-0 w-20 truncate" style={{ color: agent?.color || '#888' }}>
                        {agent?.name || 'Unknown'}
                      </span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {formatTime(entry.timestamp)}
                      </span>
                      <span className={`log-badge ${BADGE_CLASS[entry.type] || 'log-badge-system'} shrink-0`}>
                        {TYPE_LABELS[entry.type] || entry.type}
                      </span>
                      <span className="text-foreground/80 truncate">
                        {entry.summary}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true)
            virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
          }}
          className="absolute bottom-4 right-4 w-8 h-8 flex items-center justify-center bg-card border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all shadow-lg"
          title="Scroll to bottom"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  )
}

// ---- Financial Tab ----

interface FinancialData {
  profiles: Array<{ id: string; name: string; wallet: number; storage: number; total: number }>
  fleetTotal: number
}

function FinancialTab({ profiles }: { profiles: Profile[] }) {
  const [data, setData] = useState<FinancialData | null>(null)
  const [history, setHistory] = useState<Array<{ time: string; total: number }>>([])

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resp = await fetch('/api/analytics/financial')
        const d = await resp.json() as FinancialData
        setData(d)
        setHistory(prev => {
          const now = new Date().toLocaleTimeString()
          const next = [...prev, { time: now, total: d.fleetTotal }]
          if (next.length > 60) return next.slice(-60)
          return next
        })
      } catch { /* ignore */ }
    }
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [])

  if (!data) return <div className="flex items-center justify-center h-full text-muted-foreground text-xs">Loading...</div>

  const maxTotal = Math.max(...data.profiles.map(p => p.total), 1)

  return (
    <div className="overflow-y-auto h-full p-4 space-y-6">
      {/* Fleet total */}
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Fleet Net Worth</div>
        <div className="text-3xl font-mono font-bold text-primary">{data.fleetTotal.toLocaleString()}<span className="text-sm text-muted-foreground ml-1">cr</span></div>
      </div>

      {/* Per-agent breakdown */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">By Agent</div>
        {data.profiles.map((p, i) => {
          const color = AGENT_COLORS[i % AGENT_COLORS.length]
          const pct = maxTotal > 0 ? (p.total / maxTotal) * 100 : 0
          return (
            <div key={p.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium" style={{ color }}>{p.name}</span>
                <span className="font-mono tabular-nums text-foreground/80">{p.total.toLocaleString()} cr</span>
              </div>
              <div className="h-4 bg-secondary/30 relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 flex items-center"
                  style={{ width: `${pct}%`, background: color, opacity: 0.3 }}
                />
                <div className="absolute inset-0 flex items-center justify-between px-2 text-[10px]">
                  <span className="text-muted-foreground">Wallet: {p.wallet.toLocaleString()}</span>
                  <span className="text-muted-foreground">Storage: {p.storage.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Mini sparkline chart */}
      {history.length > 1 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Session Trend</div>
          <MiniChart data={history.map(h => h.total)} labels={history.map(h => h.time)} color="hsl(var(--smui-primary))" />
        </div>
      )}
    </div>
  )
}

// ---- Tokens Tab ----

interface TokenData {
  byProfile: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>
  timeline: Array<{ timestamp: string; cost: number; tokens: number; profile_id: string; model: string }>
}

function TokensTab({ profiles }: { profiles: Profile[] }) {
  const [data, setData] = useState<TokenData | null>(null)

  useEffect(() => {
    fetch('/api/analytics/tokens').then(r => r.json()).then(setData).catch(() => {})
  }, [])

  const profileMap = useMemo(() => {
    const m = new Map<string, string>()
    profiles.forEach(p => m.set(p.id, p.name))
    return m
  }, [profiles])

  if (!data) return <div className="flex items-center justify-center h-full text-muted-foreground text-xs">Loading...</div>

  const totalCost = Object.values(data.byProfile).reduce((s, v) => s + v.cost, 0)
  const totalCalls = Object.values(data.byProfile).reduce((s, v) => s + v.calls, 0)
  const totalTokens = Object.values(data.byProfile).reduce((s, v) => s + v.inputTokens + v.outputTokens, 0)

  // Build cumulative cost timeline
  const costTimeline: number[] = []
  let cumCost = 0
  for (const point of data.timeline) {
    cumCost += point.cost
    costTimeline.push(cumCost)
  }

  return (
    <div className="overflow-y-auto h-full p-4 space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Spend" value={formatCost(totalCost)} />
        <StatCard label="API Calls" value={totalCalls.toLocaleString()} />
        <StatCard label="Tokens" value={formatTokens(totalTokens)} />
      </div>

      {/* By model */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">By Model</div>
        <div className="border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="text-left px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Model</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Calls</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Tokens</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.byModel)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([model, stats]) => (
                  <tr key={model} className="border-b border-border/30">
                    <td className="px-2 py-1.5 font-mono text-foreground/80">{model}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{stats.calls.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatTokens(stats.inputTokens + stats.outputTokens)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatCost(stats.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* By agent */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">By Agent</div>
        <div className="border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/20">
                <th className="text-left px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Agent</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Calls</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">In / Out</th>
                <th className="text-right px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.byProfile)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([id, stats], i) => (
                  <tr key={id} className="border-b border-border/30">
                    <td className="px-2 py-1.5">
                      <span className="font-medium" style={{ color: AGENT_COLORS[profiles.findIndex(p => p.id === id) % AGENT_COLORS.length] }}>
                        {profileMap.get(id) || id.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{stats.calls.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatTokens(stats.inputTokens)} / {formatTokens(stats.outputTokens)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatCost(stats.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cumulative cost chart */}
      {costTimeline.length > 1 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cumulative Cost</div>
          <MiniChart data={costTimeline} color="hsl(var(--smui-orange))" prefix="$" />
        </div>
      )}
    </div>
  )
}

// ---- Shared Components ----

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-mono font-bold text-foreground">{value}</div>
    </div>
  )
}

/**
 * Pure SVG sparkline chart — no charting library needed.
 */
function MiniChart({ data, labels, color, prefix = '' }: { data: number[]; labels?: string[]; color: string; prefix?: string }) {
  if (data.length < 2) return null

  const w = 600
  const h = 80
  const pad = 4
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x},${y}`
  })

  const fillPoints = [...points, `${pad + ((data.length - 1) / (data.length - 1)) * (w - pad * 2)},${h - pad}`, `${pad},${h - pad}`]

  return (
    <div className="border border-border bg-secondary/10 p-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 80 }}>
        {/* Fill */}
        <polygon points={fillPoints.join(' ')} fill={color} opacity={0.1} />
        {/* Line */}
        <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={2} />
        {/* Latest value label */}
        <text x={w - pad} y={14} textAnchor="end" fill={color} fontSize={12} fontFamily="monospace">
          {prefix}{data[data.length - 1] >= 1000 ? data[data.length - 1].toLocaleString() : data[data.length - 1].toFixed(data[data.length - 1] < 1 ? 4 : 2)}
        </text>
      </svg>
    </div>
  )
}

// ---- Formatters ----

function formatTime(ts: string): string {
  try {
    const d = new Date(ts + 'Z')
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
