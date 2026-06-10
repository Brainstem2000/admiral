/** Combat tab — kill record, Empire kill-skill, shared kill-zone intel, and a named-pilot watch list. */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Crosshair, Flame, Skull, Eye, RefreshCw, Plus, X } from 'lucide-react'
import type { Profile, LogEntry } from '@/types'
import type { KillZone } from '@shared/fleet-intel-types'
import { formatTime } from '@/components/log/log-shared'
import { DossierCard } from '../DossierCard'

interface Skill {
  name: string
  category: string
  level: number
  max_level: number
  xp: number
  next_level_xp: number
}

interface CombatStats { stats: Record<string, number>; empireSkill: Skill | null }

const combatCache = new Map<string, CombatStats>()

const WATCH_KEY = 'admiral-watchlist'
const WATCH_SEED = ['AetherWraith']

function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY)
    if (raw == null) return WATCH_SEED
    const arr = JSON.parse(raw)
    // Drop empty/blank entries — '' would needle-match every log line.
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  } catch { return WATCH_SEED }
}

function saveWatchlist(names: string[]) {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(names)) } catch { /* ignore */ }
}

async function runCommand(profileId: string, command: string) {
  const resp = await fetch(`/api/profiles/${profileId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, silent: true }),
  })
  return resp.json()
}

function parseTs(ts: string): number {
  const t = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : 0
}

function ageOf(ts: string | null): string {
  if (!ts) return '—'
  const ms = Date.now() - parseTs(ts)
  if (ms < 0 || !Number.isFinite(ms)) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm font-medium tabular-nums truncate" style={accent ? { color: `hsl(${accent})` } : undefined}>{value}</div>
    </div>
  )
}

export function CombatTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [combat, setCombat] = useState<CombatStats | null>(() => combatCache.get(profile.id) || null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false) // a fetch completed (even if stats were absent)
  const [killZones, setKillZones] = useState<KillZone[] | null>(null)
  const [watchlist, setWatchlist] = useState<string[]>(loadWatchlist)
  const [watchInput, setWatchInput] = useState('')

  // Persist the seed once on mount (not in the initializer — no render-phase writes).
  useEffect(() => { saveWatchlist(loadWatchlist()) }, [])
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const profileIdRef = useRef(profile.id)

  useEffect(() => {
    profileIdRef.current = profile.id
    setCombat(combatCache.get(profile.id) || null)
    setLoaded(false)
    setLogEntries([])
  }, [profile.id])

  // Record + Empire skill (both free queries).
  const fetchCombat = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setLoading(true)
    try {
      const [statusRaw, skillsRaw] = await Promise.all([
        runCommand(targetId, 'get_status'),
        runCommand(targetId, 'get_skills').catch(() => null),
      ])
      if (profileIdRef.current !== targetId) return
      const statusResult = statusRaw.structuredContent || statusRaw.result || statusRaw
      const stats = (statusResult?.player as Record<string, unknown> | undefined)?.stats
      const skillsResult = skillsRaw?.structuredContent || skillsRaw?.result
      let empireSkill: Skill | null = null
      if (skillsResult?.skills && typeof skillsResult.skills === 'object') {
        empireSkill = Object.values(skillsResult.skills as Record<string, Skill>).find(s => s?.category === 'Empire') || null
      }
      if (stats && typeof stats === 'object') {
        const next: CombatStats = { stats: stats as Record<string, number>, empireSkill }
        combatCache.set(targetId, next)
        setCombat(next)
      }
      setLoaded(true)
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setLoading(false)
    }
  }, [profile.id, connected])

  // Shared fleet intel — no game connection needed.
  const fetchKillZones = useCallback(async () => {
    try {
      const resp = await fetch('/api/fleet-intel?hunting=true')
      if (!resp.ok) return
      const data = await resp.json()
      setKillZones(Array.isArray(data?.kill_zones) ? (data.kill_zones as KillZone[]) : [])
    } catch { /* ignore */ }
  }, [])

  // Encounter feed source — recent log entries for this agent.
  const fetchLogs = useCallback(async () => {
    const targetId = profile.id
    try {
      const resp = await fetch(`/api/profiles/${targetId}/logs?limit=200`)
      const data = await resp.json()
      if (profileIdRef.current !== targetId) return
      if (Array.isArray(data)) setLogEntries(data as LogEntry[])
    } catch { /* ignore */ }
  }, [profile.id])

  useEffect(() => {
    if (!connected) return
    fetchCombat()
    const t = setInterval(fetchCombat, 60_000)
    return () => clearInterval(t)
  }, [connected, fetchCombat])

  useEffect(() => {
    fetchKillZones()
    fetchLogs()
    const t = setInterval(() => { fetchKillZones(); fetchLogs() }, 60_000)
    return () => clearInterval(t)
  }, [fetchKillZones, fetchLogs])

  const stats = combat?.stats
  const deaths = stats
    ? (stats.deaths ?? (Number(stats.deaths_by_pirate || 0) + Number(stats.deaths_by_player || 0) + Number(stats.deaths_by_self_destruct || 0)))
    : null

  // Ghost rows sort last; live rows by recency. `ghost` may be absent pre-deploy — treat as 0.
  const sortedZones = useMemo(() => {
    if (!killZones) return null
    return [...killZones].sort((a, b) =>
      (Number(a.ghost) || 0) - (Number(b.ghost) || 0) || parseTs(b.updated_at) - parseTs(a.updated_at)
    )
  }, [killZones])

  const encounters = useMemo(() => {
    if (watchlist.length === 0) return []
    const needles = watchlist.map(w => w.toLowerCase())
    return logEntries
      .filter(e => {
        const hay = `${e.summary || ''} ${e.detail || ''}`.toLowerCase()
        return needles.some(n => hay.includes(n))
      })
      .slice(-5)
      .reverse()
  }, [logEntries, watchlist])

  function addWatch() {
    const name = watchInput.trim()
    if (!name) return
    setWatchlist(prev => {
      if (prev.some(w => w.toLowerCase() === name.toLowerCase())) return prev
      const next = [...prev, name]
      saveWatchlist(next)
      return next
    })
    setWatchInput('')
  }

  function removeWatch(name: string) {
    setWatchlist(prev => {
      const next = prev.filter(w => w !== name)
      saveWatchlist(next)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <DossierCard
        title="Record"
        icon={<Crosshair size={12} />}
        source="Server"
        className="min-h-[80px]"
        bodyClassName="p-3"
        action={
          <button onClick={fetchCombat} disabled={!connected || loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      >
        {!connected && !stats ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Connect to load combat record</span>
        ) : !stats ? (
          <span className="text-[11px] text-muted-foreground/50 italic">{loading ? 'Loading...' : 'No combat data'}</span>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2">
            <StatCell label="Pirates Destroyed" value={Number(stats.pirates_destroyed || 0).toLocaleString()} accent="var(--smui-red)" />
            <StatCell label="Ships Destroyed" value={Number(stats.ships_destroyed || 0).toLocaleString()} accent="var(--smui-orange)" />
            {deaths != null && <StatCell label="Deaths" value={Number(deaths).toLocaleString()} />}
            <StatCell label="Jumps Completed" value={Number(stats.jumps_completed || 0).toLocaleString()} />
            <StatCell label="Systems Explored" value={Number(stats.systems_explored || 0).toLocaleString()} />
            <StatCell label="Damage Dealt" value={Number(stats.damage_dealt || 0).toLocaleString()} />
          </div>
        )}
      </DossierCard>

      <DossierCard title={combat?.empireSkill?.name || 'Empire Skill'} icon={<Flame size={12} />} source="Server" className="min-h-[80px]" bodyClassName="p-3">
        {!connected && !combat ? (
          <span className="text-[11px] text-muted-foreground/50 italic">Connect to load skill data</span>
        ) : !combat?.empireSkill ? (
          <span className="text-[11px] text-muted-foreground/50 italic">{combat || loaded ? 'No Empire-category skill yet.' : 'Loading...'}</span>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm tabular-nums" style={{ color: 'hsl(var(--smui-red))' }}>Lv {combat.empireSkill.level}</span>
              <div className="flex-1 h-1.5 bg-border/40 overflow-hidden">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${combat.empireSkill.next_level_xp > 0 ? Math.min(100, (combat.empireSkill.xp / combat.empireSkill.next_level_xp) * 100) : 100}%`,
                    background: 'hsl(var(--smui-red))',
                  }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {(combat.empireSkill.xp ?? 0).toLocaleString()}
                <span className="text-muted-foreground/50">{combat.empireSkill.next_level_xp ? `/${combat.empireSkill.next_level_xp.toLocaleString()} xp` : ' MAX'}</span>
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground/60">xp tracks confirmed kills 1:1</div>
          </div>
        )}
      </DossierCard>

      <DossierCard title="Kill Zones" icon={<Skull size={12} />} source="Server" className="min-h-[100px]">
        {sortedZones == null ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Loading...</div>
        ) : sortedZones.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">No kill zones mapped yet — combat agents log them as they scan.</div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3 py-1.5 border-b border-border/40 text-[9px] uppercase tracking-wider text-muted-foreground">
              <span className="flex-1 min-w-0">POI</span>
              <span className="w-24 shrink-0 hidden sm:block">System</span>
              <span className="w-16 shrink-0 text-right">Pirates</span>
              <span className="w-16 shrink-0 text-right">Wrecks</span>
              <span className="w-12 shrink-0 text-right">Age</span>
            </div>
            {sortedZones.map(z => {
              const ghost = Boolean(Number(z.ghost) || 0)
              return (
                <div key={z.poi_id} className={`flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 first:border-t-0 text-xs ${ghost ? 'opacity-50' : ''}`}>
                  <span className="flex-1 min-w-0 truncate text-foreground/85" title={z.poi_id}>
                    {(z.poi_name || z.poi_id).replace(/_/g, ' ')}
                    {ghost && (
                      <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 border border-border text-muted-foreground/70 ml-1.5">ghost</span>
                    )}
                  </span>
                  <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground hidden sm:block">{z.system_name || '—'}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums" style={{ color: z.pirate_seen ? 'hsl(var(--smui-red))' : undefined }}>{z.pirate_seen}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{z.wreck_seen}</span>
                  <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">{ageOf(z.updated_at)}</span>
                </div>
              )
            })}
          </>
        )}
      </DossierCard>

      <DossierCard title="Watch List" icon={<Eye size={12} />} source="Local" className="min-h-[120px]" bodyClassName="p-3">
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {watchlist.map(name => (
            <span
              key={name}
              className="flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 border"
              style={{ color: 'hsl(var(--smui-red))', borderColor: 'hsl(var(--smui-red) / 0.4)' }}
            >
              {name}
              <button onClick={() => removeWatch(name)} title={`Stop watching ${name}`} className="hover:opacity-70 transition-opacity">
                <X size={9} />
              </button>
            </span>
          ))}
          <span className="flex items-center gap-1">
            <input
              value={watchInput}
              onChange={e => setWatchInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addWatch() }}
              placeholder="add pilot"
              className="w-24 h-5 px-1.5 text-[10px] bg-transparent border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
            />
            <button onClick={addWatch} disabled={!watchInput.trim()} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
              <Plus size={11} />
            </button>
          </span>
        </div>
        <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-1">Encounters</div>
        {encounters.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/50 italic">no contact</div>
        ) : (
          encounters.map(e => (
            <div
              key={e.id}
              className="flex items-center gap-2.5 py-1.5 border-t border-border/30 first:border-t-0 text-xs px-2 -mx-2"
              style={{ background: 'hsl(var(--smui-red) / 0.06)' }}
            >
              <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'hsl(var(--smui-red))' }}>{formatTime(e.timestamp)}</span>
              <span className="truncate" style={{ color: 'hsl(var(--smui-red) / 0.85)' }}>{e.summary}</span>
            </div>
          ))
        )}
      </DossierCard>
    </div>
  )
}
