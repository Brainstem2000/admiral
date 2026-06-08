/** Dossier panels for the Character page. Read-focused; reuses existing renderers. */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  FileText, ListTodo, Brain, BookOpen, Activity, TrendingUp, RefreshCw,
  Plug, Square, Anchor, SquarePen, Check, Minus,
  MapPin, Coins, Heart, Shield, Fuel, Package, Cpu, Zap,
} from 'lucide-react'
import type { Profile, LogEntry, LogType } from '@/types'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { DossierCard } from './DossierCard'

const CONNECTION_MODE_LABELS: Record<string, string> = {
  http: 'HTTP v1',
  http_v2: 'HTTP v2',
  websocket: 'WS',
  mcp: 'MCP v1',
  mcp_v2: 'MCP v2',
}

// Copied from LogPane — filter groups + shared persistence so the dossier feed
// mirrors the editor's log filters (same checkboxes, same saved selection).
const FILTER_GROUPS: { key: string; label: string; types: LogType[] }[] = [
  { key: 'call', label: 'Call', types: ['llm_call'] },
  { key: 'llm', label: 'LLM', types: ['llm_thought'] },
  { key: 'tools', label: 'Tools', types: ['tool_call', 'tool_result'] },
  { key: 'server', label: 'Server', types: ['server_message', 'notification'] },
  { key: 'errors', label: 'Errors', types: ['error'] },
  { key: 'system', label: 'System', types: ['connection', 'system'] },
]
const ALL_FILTER_KEYS = FILTER_GROUPS.map(g => g.key)
const FILTER_STORAGE_KEY = 'admiral-log-filters'

function loadSavedFilters(): Set<string> | null {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) {
      const arr = JSON.parse(stored)
      if (Array.isArray(arr)) return new Set(arr as string[])
    }
  } catch { /* ignore */ }
  return null
}
function persistFilters(filters: Set<string>) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...filters])) } catch { /* ignore */ }
}

// Copied from LogPane — small, stable maps for the recent-activity feed.
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
  connection: 'CONNECT', error: 'ERROR', llm_call: 'CALL', llm_thought: 'LLM',
  tool_call: 'TOOL', tool_result: 'RESULT', server_message: 'SERVER',
  notification: 'NOTIFY', system: 'SYSTEM',
}

function toISO(ts: string): string {
  let s = ts.replace(' ', 'T')
  if (!s.includes('Z') && !s.includes('+') && !s.includes('-', 10)) s += 'Z'
  return s
}
function formatTime(ts: string): string {
  try {
    const d = new Date(toISO(ts))
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  } catch { return ts.slice(11, 19) }
}

// ── Header ──────────────────────────────────────────────────────────────────

export function CharacterHeader({ profile, status, onOpenEditor }: {
  profile: Profile
  status: { connected: boolean; running: boolean; safeDocking?: boolean }
  onOpenEditor: () => void
}) {
  const dot = status.running ? 'status-dot-green' : status.connected ? 'status-dot-orange' : 'status-dot-grey'
  const stateLabel = status.safeDocking ? 'Docking' : status.running ? 'Running' : status.connected ? 'Connected' : 'Offline'
  const stateColor = status.running ? 'var(--smui-green)' : status.connected ? 'var(--smui-orange)' : 'var(--muted-foreground)'

  return (
    <div className="dossier-card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className={`status-dot ${dot}`} style={{ width: 8, height: 8 }} />
      <div className="flex items-baseline gap-2 min-w-0">
        <h2 className="text-base font-semibold text-foreground tracking-wide truncate">{profile.name}</h2>
        {profile.username && <span className="text-[11px] text-muted-foreground">@{profile.username}</span>}
      </div>

      {profile.empire && (
        <span className="text-[10px] uppercase tracking-[1.5px] px-2 py-0.5 border border-border text-muted-foreground">
          {profile.empire}
        </span>
      )}

      <span className="text-[10px] uppercase tracking-[1.5px] px-2 py-0.5 border border-border text-muted-foreground">
        {CONNECTION_MODE_LABELS[profile.connection_mode] || profile.connection_mode}
      </span>

      {profile.provider && profile.model && (
        <span className="text-[10px] text-[hsl(var(--smui-purple))]">
          {profile.provider}/{profile.model}
          {profile.planner_model && <span className="text-[hsl(var(--smui-frost-2))] ml-1">+planner</span>}
        </span>
      )}

      <div className="flex-1" />

      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[1.5px]" style={{ color: `hsl(${stateColor})` }}>
        {status.safeDocking ? <Anchor size={11} className="animate-pulse" /> : status.connected ? <Plug size={11} /> : <Square size={11} />}
        {stateLabel}
      </span>

      <button
        onClick={onOpenEditor}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[1.5px] px-2.5 py-1 border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        title="Open the full editor / controls"
      >
        <SquarePen size={11} />
        Open editor
      </button>
    </div>
  )
}

// ── Vitals ──────────────────────────────────────────────────────────────────

/** Parse a stat into {cur,max}, handling slim ("110/110" string) and full (numeric) shapes. */
function vitalPair(ship: Record<string, unknown>, slimKey: string, curKey: string, maxKey: string): { cur: number; max: number } {
  const slim = ship[slimKey]
  if (typeof slim === 'string' && slim.includes('/')) {
    const parts = slim.split('/')
    const cur = parseInt(parts[0].replace(/[^\d-]/g, ''), 10)
    const max = parseInt(parts[1].replace(/[^\d-]/g, ''), 10)
    return { cur: isNaN(cur) ? 0 : cur, max: isNaN(max) ? 0 : max }
  }
  return { cur: Number(ship[curKey] || 0), max: Number(ship[maxKey] || 0) }
}

function InfoCell({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span style={color ? { color: `hsl(${color})` } : undefined} className={color ? '' : 'text-muted-foreground'}>{icon}</span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px]">{label}</span>
      </div>
      <div className="text-sm font-medium truncate" style={color ? { color: `hsl(${color})` } : undefined}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </div>
  )
}

function Gauge({ icon, label, color, cur, max }: {
  icon: React.ReactNode; label: string; color: string; cur: number; max: number
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <span style={{ color: `hsl(${color})` }}>{icon}</span>
        <span className="text-[10px] text-muted-foreground uppercase tracking-[1.5px] flex-1 truncate">{label}</span>
        <span className="text-xs tabular-nums text-foreground/90">{cur.toLocaleString()}<span className="text-muted-foreground/50">/{max.toLocaleString()}</span></span>
      </div>
      <div className="h-1.5 w-full bg-border/40 overflow-hidden">
        <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: `hsl(${color})` }} />
      </div>
    </div>
  )
}

export function VitalsPanel({ playerData }: { playerData: Record<string, unknown> | null }) {
  if (!playerData) {
    return (
      <DossierCard title="Ship Vitals" icon={<Activity size={12} />} source="Server" className="h-full" bodyClassName="p-3.5">
        <span className="text-[11px] text-muted-foreground/60 italic">No player data — connect and send get_status to fetch.</span>
      </DossierCard>
    )
  }

  const player = (playerData.player || {}) as Record<string, unknown>
  const ship = (playerData.ship || {}) as Record<string, unknown>
  const location = (playerData.location || {}) as Record<string, unknown>

  const systemName = String(player.current_system || location.system_name || playerData.system || '?')
  const poiName = String(player.current_poi || location.poi_name || playerData.poi || '')
  const credits = Number(player.credits ?? playerData.credits ?? 0)

  const gauges = [
    { label: 'Hull', icon: <Heart size={12} />, color: 'var(--destructive)', ...vitalPair(ship, 'hull', 'hull', 'max_hull') },
    { label: 'Shield', icon: <Shield size={12} />, color: 'var(--primary)', ...vitalPair(ship, 'shield', 'shield', 'max_shield') },
    { label: 'Fuel', icon: <Fuel size={12} />, color: 'var(--smui-orange)', ...vitalPair(ship, 'fuel', 'fuel', 'max_fuel') },
    { label: 'Cargo', icon: <Package size={12} />, color: 'var(--smui-green)', ...vitalPair(ship, 'cargo', 'cargo_used', 'cargo_capacity') },
    { label: 'CPU', icon: <Cpu size={12} />, color: 'var(--smui-purple)', ...vitalPair(ship, 'cpu', 'cpu_used', 'cpu_capacity') },
    { label: 'Power', icon: <Zap size={12} />, color: 'var(--smui-frost-3)', ...vitalPair(ship, 'power', 'power_used', 'power_capacity') },
  ]

  return (
    <DossierCard title="Ship Vitals" icon={<Activity size={12} />} source="Server" className="h-full" bodyClassName="p-3.5">
      {/* Identity row */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4">
        <InfoCell icon={<MapPin size={12} />} label="Location" value={systemName} sub={poiName && poiName !== '?' ? poiName : undefined} />
        <InfoCell icon={<Coins size={12} />} color="var(--smui-yellow)" label="Credits" value={credits.toLocaleString()} />
      </div>
      {/* Gauges — 3 across so all six fit in two even rows (Power up with Cargo/CPU) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3.5">
        {gauges.map(g => <Gauge key={g.label} {...g} />)}
      </div>
    </DossierCard>
  )
}

// ── Markdown cards (directive / todo / memory) ────────────────────────────────

export function MarkdownCard({ title, kind, content, source }: {
  title: string
  kind: 'directive' | 'todo' | 'memory'
  content: string
  source: 'Local'
}) {
  const icon = kind === 'directive' ? <FileText size={12} /> : kind === 'todo' ? <ListTodo size={12} /> : <Brain size={12} />
  const empty = kind === 'directive' ? 'No directive set' : kind === 'todo' ? 'No TODO items' : 'No memory stored yet'
  return (
    <DossierCard title={title} icon={icon} source={source} className="min-h-[140px] max-h-[420px]" bodyClassName="px-3 py-2.5">
      {content?.trim()
        ? <MarkdownRenderer content={content} />
        : <span className="text-[11px] text-muted-foreground/50 italic">{empty}</span>}
    </DossierCard>
  )
}

// ── Captain's Log (reuses SidePane's captains_log_list fetch) ──────────────────

interface CaptainsLogEntry { index: number; entry: string; created_at: string }
const captainsLogCache = new Map<string, CaptainsLogEntry[]>()

export function CaptainsLogCard({ profileId, connected }: { profileId: string; connected: boolean }) {
  const [entries, setEntries] = useState<CaptainsLogEntry[]>(() => captainsLogCache.get(profileId) || [])
  const [loading, setLoading] = useState(false)
  const profileIdRef = useRef(profileId)

  useEffect(() => {
    profileIdRef.current = profileId
    setEntries(captainsLogCache.get(profileId) || [])
  }, [profileId])

  const fetchLog = useCallback(async () => {
    if (!connected) return
    const targetId = profileId
    setLoading(true)
    try {
      const resp = await fetch(`/api/profiles/${targetId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'captains_log_list', silent: true }),
      })
      if (profileIdRef.current !== targetId) return
      const data = await resp.json()
      const result = data.structuredContent || data.result || data
      if (!result.total_count || result.total_count === 0) {
        captainsLogCache.set(targetId, [])
        setEntries([])
        return
      }
      const collected: CaptainsLogEntry[] = []
      if (result.entry) collected.push(result.entry)
      const promises = []
      for (let i = 1; i < result.total_count; i++) {
        promises.push(
          fetch(`/api/profiles/${targetId}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'captains_log_list', args: { index: i }, silent: true }),
          }).then(r => r.json()).catch(() => null)
        )
      }
      const results = await Promise.all(promises)
      if (profileIdRef.current !== targetId) return
      for (const r of results) {
        const entry = r?.structuredContent?.entry || r?.result?.entry || r?.entry
        if (entry) collected.push(entry)
      }
      captainsLogCache.set(targetId, collected)
      setEntries(collected)
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setLoading(false)
    }
  }, [profileId, connected])

  useEffect(() => { if (connected) fetchLog() }, [connected, fetchLog])

  return (
    <DossierCard
      title="Captain's Log"
      icon={<BookOpen size={12} />}
      source="Server"
      className="min-h-[140px] max-h-[420px]"
      action={
        <button onClick={fetchLog} disabled={!connected || loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      }
    >
      {!connected ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Connect to load captain&apos;s log</div>
      ) : entries.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">{loading ? 'Loading...' : 'No log entries'}</div>
      ) : (
        entries.map(e => (
          <div key={e.index} className="px-3 py-2 border-t border-border/30 first:border-t-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[9px] text-muted-foreground/40">#{e.index}</span>
              <span className="text-[9px] text-muted-foreground/40">{e.created_at}</span>
            </div>
            <MarkdownRenderer content={e.entry} />
          </div>
        ))
      )}
    </DossierCard>
  )
}

// ── Recent activity feed (lightweight, over the page's live SSE entries) ───────

function FilterCheckbox({ label, count, checked, indeterminate, onChange }: {
  label: string
  count?: number
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
}) {
  return (
    <button
      onClick={onChange}
      className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors leading-none"
    >
      <span className={`w-3 h-3 border flex items-center justify-center shrink-0 ${
        checked || indeterminate ? 'bg-primary/20 border-primary/60' : 'border-border'
      }`}>
        {checked && <Check size={9} className="text-primary" />}
        {indeterminate && <Minus size={9} className="text-primary" />}
      </span>
      <span className="uppercase tracking-wider font-medium">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[9px] tabular-nums text-muted-foreground/50">{count}</span>
      )}
    </button>
  )
}

export function RecentActivityFeed({ entries }: { entries: LogEntry[] }) {
  const [enabledFilters, _setEnabledFilters] = useState<Set<string>>(() => loadSavedFilters() ?? new Set(ALL_FILTER_KEYS))
  const setEnabledFilters = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    _setEnabledFilters(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      persistFilters(next)
      return next
    })
  }, [])

  const allowedTypes = useMemo(() => {
    const types = new Set<LogType>()
    for (const g of FILTER_GROUPS) {
      if (enabledFilters.has(g.key)) for (const t of g.types) types.add(t)
    }
    return types
  }, [enabledFilters])

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const g of FILTER_GROUPS) map[g.key] = entries.filter(e => g.types.includes(e.type)).length
    return map
  }, [entries])

  const filtered = useMemo(() =>
    enabledFilters.size === ALL_FILTER_KEYS.length ? entries : entries.filter(e => allowedTypes.has(e.type)),
    [entries, enabledFilters, allowedTypes]
  )
  const recent = filtered.slice(-40).reverse()

  function toggleFilter(key: string) {
    setEnabledFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }
  function toggleAll() {
    setEnabledFilters(prev => prev.size === ALL_FILTER_KEYS.length ? new Set() : new Set(ALL_FILTER_KEYS))
  }

  const allChecked = enabledFilters.size === ALL_FILTER_KEYS.length
  const noneChecked = enabledFilters.size === 0
  const allIndeterminate = !allChecked && !noneChecked

  return (
    <div className="dossier-card flex flex-col min-h-[180px] max-h-[460px]">
      {/* Title strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        <span className="text-muted-foreground shrink-0"><Activity size={12} /></span>
        <span className="text-[11px] uppercase tracking-[1.5px] font-medium text-foreground/80 flex-1 truncate">Recent Activity</span>
      </div>
      {/* Filter bar — mirrors LogPane */}
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-border/40 shrink-0">
        <FilterCheckbox label="All" checked={allChecked} indeterminate={allIndeterminate} onChange={toggleAll} />
        <div className="w-px h-4 bg-border mx-1" />
        {FILTER_GROUPS.map(g => (
          <FilterCheckbox key={g.key} label={g.label} count={counts[g.key] || 0} checked={enabledFilters.has(g.key)} onChange={() => toggleFilter(g.key)} />
        ))}
      </div>
      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {recent.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">
            {entries.length === 0 ? 'No activity yet.' : 'No entries match the selected filters.'}
          </div>
        ) : (
          recent.map(e => (
            <div key={e.id} className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 first:border-t-0 text-xs">
              <span className="text-muted-foreground shrink-0 tabular-nums text-[10px]">{formatTime(e.timestamp)}</span>
              <span className={`log-badge ${BADGE_CLASS[e.type] || 'log-badge-system'} shrink-0`}>{TYPE_LABELS[e.type] || e.type}</span>
              <span className="text-foreground/80 truncate">{e.summary}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Financial sparkline ───────────────────────────────────────────────────────

interface Snapshot { profile_id: string; timestamp: string; wallet: number; total: number }

function sqliteSince(hoursAgo: number): string {
  const d = new Date(Date.now() - hoursAgo * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export function FinancialSparkline({ profileId }: { profileId: string }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/analytics/snapshots?profileId=${encodeURIComponent(profileId)}&since=${encodeURIComponent(sqliteSince(72))}`)
      .then(r => r.json())
      .then((data: Snapshot[]) => { if (!cancelled) setSnaps(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setSnaps([]) })
    return () => { cancelled = true }
  }, [profileId])

  const points = (snaps || []).filter(s => typeof s.wallet === 'number')
  const latest = points.length ? points[points.length - 1].wallet : null
  const first = points.length ? points[0].wallet : null
  const delta = latest != null && first != null ? latest - first : null

  let path = ''
  if (points.length >= 2) {
    const vals = points.map(p => p.wallet)
    const min = Math.min(...vals), max = Math.max(...vals)
    const range = max - min || 1
    const W = 100, H = 28
    path = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W
      const y = H - ((v - min) / range) * H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
  }

  const deltaColor = delta == null ? 'var(--muted-foreground)' : delta >= 0 ? 'var(--smui-green)' : 'var(--smui-red)'

  return (
    <DossierCard title="Wealth (72h)" icon={<TrendingUp size={12} />} source="Server" className="min-h-[140px]" bodyClassName="p-3">
      {latest != null ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-medium tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }}>
              {latest.toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground">cr</span>
            {delta != null && (
              <span className="text-[11px] tabular-nums ml-auto" style={{ color: `hsl(${deltaColor})` }}>
                {delta >= 0 ? '+' : ''}{delta.toLocaleString()}
              </span>
            )}
          </div>
          {path ? (
            <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="w-full h-10">
              <path d={path} fill="none" stroke="hsl(var(--smui-frost-2))" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : (
            <span className="text-[10px] text-muted-foreground/50 italic">Not enough history yet for a trend.</span>
          )}
        </div>
      ) : (
        <span className="text-[11px] text-muted-foreground/50 italic">
          {snaps == null ? 'Loading...' : 'No financial snapshots yet.'}
        </span>
      )}
    </DossierCard>
  )
}
