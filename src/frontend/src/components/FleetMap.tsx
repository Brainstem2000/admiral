import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import { Loader2, RefreshCw, Maximize2, Minimize2, Shield } from 'lucide-react'
import type CameraControlsImpl from 'camera-controls'
import type { Profile, LogEntry } from '@/types'
import type { GalaxyMapData, GalaxySystem } from '@shared/galaxy-types'
import type { ThreatIntel } from '@shared/fleet-intel-types'
import { deriveActivity, parseGameSubcommand, type LogRef } from '@/lib/activity'
import { FleetLegend } from './FleetLegend'
import { FleetIntelPanel } from './FleetIntelPanel'
import { resolveThemeColors, systemZ, type ThemeColors } from './fleet-map/galaxy-utils'
import { BackgroundStars } from './fleet-map/BackgroundStars'
import { Connections } from './fleet-map/Connections'
import { StarSystems } from './fleet-map/StarSystems'
import { AgentMarkers, type AgentPosition } from './fleet-map/AgentMarkers'
import { AgentHeadings, type AgentHeading } from './fleet-map/AgentHeadings'
import { AgentRoute } from './fleet-map/AgentRoute'
import { EmpireNebula } from './fleet-map/EmpireNebula'
import { SecurityOverlay } from './fleet-map/SecurityOverlay'
import { SystemPopup } from './fleet-map/SystemPopup'
import { SystemLabels } from './fleet-map/SystemLabels'

interface Props {
  profiles: Profile[]
  statuses: Record<string, { connected: boolean; running: boolean; safeDocking?: boolean; activity?: string }>
  playerDataMap: Record<string, Record<string, unknown>>
  activeId?: string
  onSelectAgent?: (id: string) => void
  fullscreen?: boolean
  onToggleFullscreen?: () => void
}

const MAX_SEL_ENTRIES = 60

/** Coarse "what they're doing" from the raw activity string (for non-selected agents). */
function coarseActivity(s?: string): string {
  if (!s || s === 'idle') return ''
  if (/waiting for llm|connecting/i.test(s)) return 'Thinking'
  if (/executing tool/i.test(s)) return 'Working'
  if (/sleeping/i.test(s)) return 'Sleeping'
  if (/polling/i.test(s)) return 'Standing by'
  return s.slice(0, 24)
}

function mergeCapEntries(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const ids = new Set(prev.map(e => e.id))
  const fresh = incoming.filter(e => typeof e.id === 'number' && !ids.has(e.id))
  if (fresh.length === 0) return prev
  const combined = [...prev, ...fresh].sort((a, b) => a.id - b.id)
  return combined.length > MAX_SEL_ENTRIES ? combined.slice(-MAX_SEL_ENTRIES) : combined
}

export function FleetMap({ profiles, statuses, playerDataMap, activeId, onSelectAgent, fullscreen, onToggleFullscreen }: Props) {
  const [galaxyData, setGalaxyData] = useState<GalaxyMapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [colors, setColors] = useState<ThemeColors>(() => resolveThemeColors())
  const [selectedSystem, setSelectedSystem] = useState<GalaxySystem | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [securityOverlay, setSecurityOverlay] = useState(false)
  const [threats, setThreats] = useState<ThreatIntel[]>([])
  const controlsRef = useRef<CameraControlsImpl>(null)

  // Track previous agent positions to infer heading direction
  const agentPrevSystems = useRef<Map<string, string>>(new Map())

  const systemById = useMemo(() => {
    if (!galaxyData) return new Map<string, GalaxySystem>()
    const m = new Map<string, GalaxySystem>()
    for (const s of galaxyData.systems) m.set(s.system_id, s)
    return m
  }, [galaxyData])

  const systemByName = useMemo(() => {
    if (!galaxyData) return new Map<string, GalaxySystem>()
    const m = new Map<string, GalaxySystem>()
    for (const s of galaxyData.systems) m.set(s.name, s)
    return m
  }, [galaxyData])

  // Robust resolver: agent state often gives a lowercase id ("krynn") while the
  // galaxy name is title-cased ("Krynn"). Match by name → id → case-insensitive.
  const resolveSystem = useMemo(() => {
    const lower = new Map<string, GalaxySystem>()
    if (galaxyData) {
      for (const s of galaxyData.systems) {
        lower.set(s.name.toLowerCase(), s)
        lower.set(s.system_id.toLowerCase(), s)
      }
    }
    return (token: string): GalaxySystem | undefined => {
      if (!token) return undefined
      return systemByName.get(token) || systemById.get(token) || lower.get(token.toLowerCase())
    }
  }, [galaxyData, systemByName, systemById])

  const agentPositions: AgentPosition[] = useMemo(() => {
    const result: AgentPosition[] = []
    profiles.forEach((p, i) => {
      const pd = playerDataMap[p.id]
      if (!pd) return
      const player = (pd.player || {}) as Record<string, unknown>
      const location = (pd.location || {}) as Record<string, unknown>
      const sysName = String(player.current_system || location.system_name || pd.system || '')
      if (!sysName) return
      const sys = resolveSystem(sysName)
      if (!sys) return
      // Extract status data from slimGameState (flat shape: ship.hull="200/200", poi="Grand Exchange")
      const ship = (pd.ship || {}) as Record<string, unknown>
      const poi = String(pd.poi || '')
      result.push({
        profile: p,
        index: i,
        system: sys,
        running: statuses[p.id]?.running ?? false,
        docked: Boolean(poi),
        hull: String(ship.hull ?? ''),
        shield: String(ship.shield ?? ''),
        fuel: String(ship.fuel ?? ''),
        cargo: String(ship.cargo ?? ''),
        credits: Number(pd.credits ?? 0),
      })
    })
    return result
  }, [profiles, playerDataMap, statuses, resolveSystem])

  // Compute agent headings from position changes. Done in an effect (not a memo)
  // because it mutates the agentPrevSystems ref — doing that during render is
  // unsafe under React 19 concurrent/StrictMode, where a render may run twice or
  // be discarded, corrupting the "previous position" tracking.
  const [agentHeadings, setAgentHeadings] = useState<Map<string, AgentHeading>>(new Map())
  useEffect(() => {
    const prev = agentPrevSystems.current
    const headings = new Map<string, AgentHeading>()
    for (const ap of agentPositions) {
      const prevSysId = prev.get(ap.profile.id)
      if (prevSysId && prevSysId !== ap.system.system_id) {
        const fromSys = systemById.get(prevSysId)
        if (fromSys) {
          headings.set(ap.profile.id, { from: fromSys, to: ap.system })
        }
      }
      prev.set(ap.profile.id, ap.system.system_id)
    }
    setAgentHeadings(headings)
  }, [agentPositions, systemById])

  const agentsAtSelected = useMemo(() => {
    if (!selectedSystem) return []
    return agentPositions.filter(ap => ap.system.system_id === selectedSystem.system_id)
  }, [selectedSystem, agentPositions])

  // ── Selected agent: live route + activity ───────────────────────────────────
  const selectedAgent = useMemo(
    () => agentPositions.find(ap => ap.profile.id === activeId) || null,
    [agentPositions, activeId],
  )

  // Stream the selected agent's logs to derive precise activity + jump destination.
  const [selEntries, setSelEntries] = useState<LogEntry[]>([])
  const [selActivityStr, setSelActivityStr] = useState('idle')
  const [nowTick, setNowTick] = useState(() => Date.now())
  const selEsRef = useRef<EventSource | null>(null)
  const selConnected = activeId ? (statuses[activeId]?.connected ?? false) : false

  useEffect(() => {
    if (selEsRef.current) { selEsRef.current.close(); selEsRef.current = null }
    setSelEntries([]); setSelActivityStr('idle')
    if (!activeId || !selConnected) return
    const es = new EventSource(`/api/profiles/${activeId}/logs?stream=true`)
    selEsRef.current = es
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data._init && Array.isArray(data.entries)) {
          setSelEntries(prev => mergeCapEntries(prev, data.entries as LogEntry[]))
          return
        }
        if (typeof data.id === 'number') setSelEntries(prev => mergeCapEntries(prev, [data as LogEntry]))
      } catch { /* heartbeat */ }
    }
    es.addEventListener('activity', (event) => {
      try { setSelActivityStr(JSON.parse((event as MessageEvent).data).activity || 'idle') } catch { /* ignore */ }
    })
    return () => { es.close(); selEsRef.current = null }
  }, [activeId, selConnected])

  // Staleness tick so a finished jump decays out of "traveling".
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1500)
    return () => clearInterval(t)
  }, [])

  const selActivity = useMemo(() => {
    if (!activeId) return null
    const toolCalls: LogRef[] = selEntries.filter(e => e.type === 'tool_call').slice(-12).map(e => ({ summary: e.summary, timestamp: e.timestamp }))
    const notifs: LogRef[] = selEntries.filter(e => e.type === 'notification' || e.type === 'server_message').slice(-12).map(e => ({ summary: e.summary, timestamp: e.timestamp }))
    return deriveActivity({
      activityString: selActivityStr,
      recentToolCalls: toolCalls,
      recentNotifications: notifs,
      gameState: playerDataMap[activeId] || null,
      connected: selConnected,
      running: statuses[activeId]?.running ?? false,
      now: nowTick,
    })
  }, [activeId, selEntries, selActivityStr, playerDataMap, statuses, selConnected, nowTick])

  // Destination system from the latest jump tool call (only while traveling).
  const selDestination = useMemo(() => {
    if (!activeId || !selActivity || selActivity.kind !== 'traveling') return null
    const jumps = selEntries.filter(e => e.type === 'tool_call' && /^game\(\s*jump/i.test(e.summary))
    const latest = jumps[jumps.length - 1]
    if (!latest) return null
    const parsed = parseGameSubcommand(latest.summary)
    const m = parsed?.args.match(/target_system\s*=\s*([^,\s)]+)/i)
    if (!m) return null
    return resolveSystem(m[1].trim()) ?? null
  }, [activeId, selActivity, selEntries, resolveSystem])

  // Breadcrumb history of recent systems for the selected agent.
  const [trailIds, setTrailIds] = useState<string[]>([])
  useEffect(() => {
    setTrailIds(selectedAgent ? [selectedAgent.system.system_id] : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])
  useEffect(() => {
    if (!selectedAgent) return
    setTrailIds(prev => {
      const cur = selectedAgent.system.system_id
      if (prev[prev.length - 1] === cur) return prev
      const next = [...prev, cur]
      return next.length > 6 ? next.slice(-6) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent?.system.system_id])

  const selTrail = useMemo(
    () => trailIds.map(id => systemById.get(id)).filter((s): s is GalaxySystem => !!s),
    [trailIds, systemById],
  )

  // Activity label per agent: precise for the selected one, coarse for the rest.
  const activityLabels = useMemo(() => {
    const m: Record<string, string> = {}
    for (const ap of agentPositions) {
      const id = ap.profile.id
      m[id] = (id === activeId && selActivity) ? selActivity.label : coarseActivity(statuses[id]?.activity)
    }
    return m
  }, [agentPositions, activeId, selActivity, statuses])

  // Fetch galaxy data
  const fetchGalaxy = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      let resp = await fetch('/api/galaxy')
      if (resp.status === 404 || forceRefresh) {
        resp = await fetch('/api/galaxy/refresh', { method: 'POST' })
      }
      if (!resp.ok) throw new Error(`Failed: ${resp.status}`)
      const data: GalaxyMapData = await resp.json()
      setGalaxyData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchGalaxy() }, [fetchGalaxy])

  // r3f can mount the Canvas before its container is measured (it gets stuck at
  // the default 300x150). Nudge a few resizes once the galaxy loads — spaced out
  // so at least one lands after r3f has attached its own resize listener.
  useEffect(() => {
    if (!galaxyData) return
    const timers = [0, 120, 350, 700, 1200].map(d =>
      setTimeout(() => window.dispatchEvent(new Event('resize')), d),
    )
    return () => timers.forEach(clearTimeout)
  }, [galaxyData])

  // Theme observer
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(resolveThemeColors()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  // Poll fleet intel for threat data (used by security overlay)
  useEffect(() => {
    if (!securityOverlay) return
    let cancelled = false
    const poll = async () => {
      try {
        const resp = await fetch('/api/fleet-intel')
        if (resp.ok && !cancelled) {
          const data = await resp.json()
          setThreats(data.threats || [])
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [securityOverlay])

  // Keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (fullscreen && onToggleFullscreen) onToggleFullscreen()
        else setSelectedSystem(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, onToggleFullscreen])

  // Center on system (from legend click)
  const centerOnSystem = useCallback((systemName: string) => {
    const sys = systemByName.get(systemName)
    if (!sys || !controlsRef.current) return
    const z = systemZ(sys.system_id)
    // Fly camera to look at the system from a close-up angle
    controlsRef.current.setLookAt(
      sys.position.x + 1500, z + 2000, sys.position.y + 1500,
      sys.position.x, z, sys.position.y,
      true
    )
  }, [systemByName])

  // Auto-fly to the selected agent once when the map opens with one chosen.
  // Retries until CameraControls is mounted (ref readiness doesn't trigger effects).
  const centeredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!galaxyData || !selectedAgent) return
    if (centeredRef.current === activeId) return
    let cancelled = false
    let tries = 0
    const tryCenter = () => {
      if (cancelled) return
      if (controlsRef.current) {
        centeredRef.current = activeId ?? null
        centerOnSystem(selectedAgent.system.name)
        return
      }
      if (tries++ < 40) setTimeout(tryCenter, 100)
    }
    const t = setTimeout(tryCenter, 150)
    return () => { cancelled = true; clearTimeout(t) }
  }, [galaxyData, selectedAgent, activeId, centerOnSystem])

  const handleSelect = useCallback((sys: GalaxySystem) => {
    setSelectedSystem(prev => prev?.system_id === sys.system_id ? null : sys)
  }, [])

  const handleHover = useCallback((sys: GalaxySystem | null) => {
    setHoveredId(sys?.system_id ?? null)
  }, [])

  // Compute galaxy center for initial camera target
  const galaxyCenter = useMemo(() => {
    if (!galaxyData || galaxyData.systems.length === 0) return { x: 7000, y: 0, z: 7000 }
    let sumX = 0, sumY = 0, sumZ = 0
    for (const s of galaxyData.systems) {
      sumX += s.position.x
      sumZ += s.position.y // game y → three.js z
      sumY += systemZ(s.system_id)
    }
    const n = galaxyData.systems.length
    return { x: sumX / n, y: sumY / n, z: sumZ / n }
  }, [galaxyData])

  return (
    <div className="relative w-full h-full overflow-hidden bg-background">
      {galaxyData && galaxyData.systems.length > 0 && (
        <Canvas
          camera={{
            position: [galaxyCenter.x, galaxyCenter.y + 8000, galaxyCenter.z + 12000],
            fov: 50,
            near: 10,
            far: 100000,
          }}
          style={{ background: 'transparent' }}
          onPointerMissed={() => setSelectedSystem(null)}
        >
          <CameraControls
            ref={controlsRef}
            makeDefault
            minDistance={200}
            maxDistance={40000}
            dollySpeed={0.5}
          />
          <ambientLight intensity={0.8} />
          <BackgroundStars />
          <EmpireNebula systems={galaxyData.systems} systemById={systemById} colors={colors} />
          {securityOverlay && (
            <SecurityOverlay systems={galaxyData.systems} threats={threats} colors={colors} />
          )}
          <Connections systems={galaxyData.systems} systemById={systemById} colors={colors} />
          <StarSystems
            systems={galaxyData.systems}
            colors={colors}
            hoveredId={hoveredId}
            selectedId={selectedSystem?.system_id ?? null}
            onHover={handleHover}
            onSelect={handleSelect}
          />
          <SystemLabels systems={galaxyData.systems} agents={agentPositions} hoveredId={hoveredId} colors={colors} />
          <AgentMarkers agents={agentPositions} colors={colors} selectedId={activeId} activityLabels={activityLabels} onSelect={onSelectAgent} />
          <AgentHeadings agents={agentPositions} headings={agentHeadings} colors={colors} />
          {selectedAgent && (
            <AgentRoute
              trail={selTrail}
              current={selectedAgent.system}
              destination={selDestination ?? null}
              label={selActivity?.label}
              color={colors.agents[selectedAgent.index % colors.agents.length]}
            />
          )}
          {selectedSystem && (
            <SystemPopup
              system={selectedSystem}
              agents={agentsAtSelected}
              colors={colors}
              onClose={() => setSelectedSystem(null)}
            />
          )}
        </Canvas>
      )}

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-40">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Loading galaxy map...</span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && !loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-40">
          <span className="text-sm text-muted-foreground">Failed to load galaxy: {error}</span>
          <button onClick={() => fetchGalaxy(true)} className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-3">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      <FleetLegend
        profiles={profiles}
        statuses={statuses}
        playerDataMap={playerDataMap}
        onCenter={centerOnSystem}
        onSelect={onSelectAgent}
        selectedId={activeId}
      />

      <FleetIntelPanel />

      {/* Top-right controls */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-30">
        {fullscreen && (
          <span className="text-[10px] uppercase tracking-[1.5px] text-primary/60 font-medium mr-2 select-none">War Room</span>
        )}
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="flex items-center justify-center w-7 h-7 bg-card/80 border border-border text-muted-foreground hover:text-foreground transition-colors backdrop-blur-sm"
            title={fullscreen ? 'Exit war room (Esc)' : 'War room — full screen'}
          >
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
      </div>

      <div className="absolute bottom-3 left-3 flex items-center gap-3 text-[10px] text-muted-foreground/60 select-none">
        <span>{galaxyData?.total_count || 0} systems</span>
        <button
          onClick={() => fetchGalaxy(true)}
          className="hover:text-muted-foreground transition-colors"
          title="Refresh galaxy data"
        >
          <RefreshCw size={10} />
        </button>
        <button
          onClick={() => setSecurityOverlay(v => !v)}
          className={`flex items-center gap-1 transition-colors ${securityOverlay ? 'text-green-400' : 'hover:text-muted-foreground'}`}
          title={securityOverlay ? 'Hide security overlay' : 'Show security overlay (safe/dangerous zones)'}
        >
          <Shield size={10} />
          <span>Security</span>
        </button>
      </div>

      {!loading && !error && galaxyData && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground/40 select-none pointer-events-none">
          Left-drag to orbit · Right-drag to pan · Scroll to zoom · Click agents in Fleet panel to fly
        </div>
      )}
    </div>
  )
}
