/**
 * Character dossier page — tabbed shell over everything about one agent.
 * Read-focused; the editor stays in ProfileView.
 *
 * Opens its OWN EventSource to the per-profile log stream to receive both live
 * log entries (for tool-call-based activity detection) and the `activity` event.
 * Multiple EventSources to the same SSE endpoint are independent, so this
 * coexists with LogPane in the editor view (and the Activity tab's LogPane here).
 * The SSE/entries wiring runs regardless of active tab so Overview is always live.
 *
 * Active tab is deep-linked as ?ctab= alongside ?profile=. The page remounts per
 * agent (key={profile.id} in Dashboard), so the lazy useState initializer re-reads
 * ctab from the URL on each switch — that's what makes the tab persist across agents.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ScrollText, LayoutDashboard, TrendingUp, GraduationCap, Rocket, Crosshair, Radio, BookOpen, Coins } from 'lucide-react'
import type { Profile, LogEntry } from '@/types'
import { deriveActivity, type LogRef } from '@/lib/activity'
import { ActivityGraphic } from './ActivityGraphic'
import {
  CharacterHeader, VitalsPanel, MarkdownCard, CaptainsLogCard,
  RecentActivityFeed, FinancialSparkline,
} from './CharacterPanels'
import { FinancialsTab } from './tabs/FinancialsTab'
import { SkillsTab } from './tabs/SkillsTab'
import { ShipTab } from './tabs/ShipTab'
import { CombatTab } from './tabs/CombatTab'
import { CommsTab } from './tabs/CommsTab'
import { CostTab } from './tabs/CostTab'
import { LogPane } from '@/components/LogPane'

interface Props {
  profile: Profile
  status: { connected: boolean; running: boolean; safeDocking?: boolean }
  playerData: Record<string, unknown> | null
  onOpenEditor: () => void
}

const MAX_ENTRIES = 200

const TABS = [
  { id: 'activity', label: 'Activity', icon: <ScrollText size={12} /> },
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={12} /> },
  { id: 'financials', label: 'Financials', icon: <TrendingUp size={12} /> },
  { id: 'skills', label: 'Skills', icon: <GraduationCap size={12} /> },
  { id: 'ship', label: 'Ship', icon: <Rocket size={12} /> },
  { id: 'combat', label: 'Combat', icon: <Crosshair size={12} /> },
  { id: 'comms', label: 'Comms', icon: <Radio size={12} /> },
  { id: 'knowledge', label: 'Knowledge', icon: <BookOpen size={12} /> },
  { id: 'cost', label: 'Cost', icon: <Coins size={12} /> },
] as const
type TabId = typeof TABS[number]['id']

/** Read ?ctab= from the live URL (not router state — see replaceState below). */
function readTabFromUrl(): TabId {
  try {
    const v = new URLSearchParams(window.location.search).get('ctab')
    if (v && TABS.some(t => t.id === v)) return v as TabId
  } catch { /* ignore */ }
  return 'activity'
}

// Per-profile cache so the feed is instantly populated on profile switch and
// stays at parity with the editor's LogPane (which also caches + HTTP-seeds).
const entriesCache = new Map<string, LogEntry[]>()

export function CharacterPage({ profile, status, playerData, onOpenEditor }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [activityString, setActivityString] = useState('idle')
  const [now, setNow] = useState(() => Date.now())
  const [sseKey, setSseKey] = useState(0)
  const esRef = useRef<EventSource | null>(null)
  // Lazy init re-runs on every per-agent remount → tab persists across agent switches.
  const [tab, setTab] = useState<TabId>(readTabFromUrl)

  // Tab changes rewrite ?ctab= in place, preserving all other query params
  // (and the router's history.state — replacing it with null corrupts its bookkeeping).
  const selectTab = useCallback((id: TabId) => {
    setTab(id)
    const params = new URLSearchParams(window.location.search)
    params.set('ctab', id)
    if (id !== 'activity') params.delete('log') // stale ?log= would re-open the detail modal
    history.replaceState(history.state, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`)
  }, [])

  // Back/forward re-syncs the tab from the URL (replaceState writes never fire popstate).
  useEffect(() => {
    const onPop = () => setTab(readTabFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Reconnect SSE when connection state flips (mirrors LogPane's sseKey trick).
  useEffect(() => { setSseKey(k => k + 1) }, [status.connected])

  // Merge new entries into state + cache, deduped/sorted/capped.
  const mergeEntries = useCallback((pid: string, incoming: LogEntry[]) => {
    if (incoming.length === 0) return
    setEntries(prev => {
      const ids = new Set(prev.map(e => e.id))
      const fresh = incoming.filter(e => typeof e.id === 'number' && !ids.has(e.id))
      if (fresh.length === 0) return prev
      const combined = [...prev, ...fresh].sort((a, b) => a.id - b.id)
      const capped = combined.length > MAX_ENTRIES ? combined.slice(-MAX_ENTRIES) : combined
      entriesCache.set(pid, capped)
      return capped
    })
  }, [])

  // Seed from cache on profile switch (instant), then reset activity.
  useEffect(() => {
    setEntries(entriesCache.get(profile.id) || [])
    setActivityString('idle')
  }, [profile.id])

  // HTTP seed + CONTINUOUS re-sync. The one-shot seed brings the feed current on
  // mount; the interval guarantees it keeps converging to the live state even if the
  // SSE stream drops or silently misses entries — so the Recent Activity feed stays
  // FULLY SYNCED with the Fleet log rather than drifting behind. The dedup in
  // mergeEntries makes each poll a no-op when nothing is new (cheap).
  useEffect(() => {
    // The Activity tab's embedded LogPane maintains the same stream itself; skip the
    // duplicate poll there — switching back re-seeds instantly via cache + immediate poll.
    if (tab === 'activity') return
    const pid = profile.id
    const poll = () => {
      fetch(`/api/profiles/${pid}/logs`)
        .then(r => r.json())
        .then((data: LogEntry[]) => { if (Array.isArray(data)) mergeEntries(pid, data) })
        .catch(() => {})
    }
    poll() // immediate seed
    const t = setInterval(poll, 3000) // continuous re-sync
    return () => clearInterval(t)
  }, [profile.id, mergeEntries, tab])

  // Live log + activity stream.
  useEffect(() => {
    if (esRef.current) esRef.current.close()
    const pid = profile.id
    const es = new EventSource(`/api/profiles/${pid}/logs?stream=true`)
    esRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data._init && Array.isArray(data.entries)) {
          mergeEntries(pid, data.entries as LogEntry[])
          return
        }
        mergeEntries(pid, [data as LogEntry])
      } catch { /* heartbeat / malformed */ }
    }

    es.addEventListener('activity', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        setActivityString(data.activity || 'idle')
      } catch { /* ignore */ }
    })

    return () => { es.close(); esRef.current = null }
  }, [profile.id, sseKey, mergeEntries])

  // Reset activity string when disconnected.
  useEffect(() => { if (!status.connected) setActivityString('idle') }, [status.connected])

  // Staleness tick — re-evaluate activity even with no new events so a finished
  // action (e.g. a completed jump) decays out of "traveling".
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1500)
    return () => clearInterval(t)
  }, [])

  const activity = useMemo(() => {
    const toolCalls: LogRef[] = entries
      .filter(e => e.type === 'tool_call')
      .slice(-12)
      .map(e => ({ summary: e.summary, timestamp: e.timestamp }))
    const notifications: LogRef[] = entries
      .filter(e => e.type === 'notification' || e.type === 'server_message')
      .slice(-12)
      .map(e => ({ summary: e.summary, timestamp: e.timestamp }))
    return deriveActivity({
      activityString,
      recentToolCalls: toolCalls,
      recentNotifications: notifications,
      gameState: playerData,
      connected: status.connected,
      running: status.running,
      now,
    })
  }, [entries, activityString, playerData, status.connected, status.running, now])

  const shipName = useMemo(() => {
    const ship = (playerData?.ship || {}) as Record<string, unknown>
    const raw = ship.name || ship.class || ship.class_id
    if (!raw || typeof raw !== 'string') return undefined
    return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }, [playerData])

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Pinned header + tab bar */}
      <div className="shrink-0 w-full max-w-[1600px] mx-auto px-4 md:px-6 pt-4 md:pt-6 space-y-3">
        <CharacterHeader profile={profile} status={status} onOpenEditor={onOpenEditor} />
        <div className="flex items-center w-fit border border-border divide-x divide-border bg-card">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              title={t.label}
              className={`flex items-center gap-1.5 h-7 px-2.5 text-[10px] uppercase tracking-[1.5px] transition-colors ${
                tab === t.id
                  ? 'text-primary bg-primary/10 shadow-[inset_0_-2px_0_0_hsl(var(--primary))]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.icon}
              <span className="hidden md:inline">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'activity' ? (
        /* Full remaining height; LogPane handles its own scroll/tail/search */
        <div className="flex-1 min-h-0 flex flex-col w-full max-w-[1600px] mx-auto px-4 md:px-6 pt-3 pb-4 md:pb-6">
          <div className="flex-1 min-h-0 dossier-card overflow-hidden">
            <LogPane profileId={profile.id} connected={status.connected} />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="w-full max-w-[1600px] mx-auto px-4 md:px-6 pt-3 pb-4 md:pb-6 space-y-4">
            {tab === 'overview' && (
              <>
                {/* Hero: compact activity graphic (~1/4 area) + vitals taking the rest */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-1 max-w-sm">
                    <ActivityGraphic result={activity} shipName={shipName} />
                  </div>
                  <div className="lg:col-span-2 min-h-0">
                    <VitalsPanel playerData={playerData} />
                  </div>
                </div>

                {/* Wealth + recent activity feed */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <FinancialSparkline profileId={profile.id} />
                  <div className="lg:col-span-2">
                    <RecentActivityFeed entries={entries} />
                  </div>
                </div>
              </>
            )}

            {tab === 'financials' && <FinancialsTab profile={profile} connected={status.connected} />}

            {tab === 'skills' && <SkillsTab profile={profile} connected={status.connected} />}

            {tab === 'ship' && <ShipTab profile={profile} connected={status.connected} />}

            {tab === 'combat' && <CombatTab profile={profile} connected={status.connected} />}

            {tab === 'comms' && <CommsTab profile={profile} connected={status.connected} />}

            {tab === 'knowledge' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <MarkdownCard title="Directive" kind="directive" content={profile.directive} source="Local" />
                <MarkdownCard title="TODO" kind="todo" content={profile.todo} source="Local" />
                <MarkdownCard title="Memory" kind="memory" content={profile.memory} source="Local" />
                <CaptainsLogCard profileId={profile.id} connected={status.connected} />
              </div>
            )}

            {tab === 'cost' && <CostTab profile={profile} connected={status.connected} />}
          </div>
        </div>
      )}
    </div>
  )
}
