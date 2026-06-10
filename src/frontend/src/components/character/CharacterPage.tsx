/**
 * Character dossier page — everything about one agent on one screen, plus the
 * animated activity graphic. Read-focused; the editor stays in ProfileView.
 *
 * Opens its OWN EventSource to the per-profile log stream to receive both live
 * log entries (for tool-call-based activity detection) and the `activity` event.
 * Multiple EventSources to the same SSE endpoint are independent, so this
 * coexists with LogPane in the editor view.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { Profile, LogEntry } from '@/types'
import { deriveActivity, type LogRef } from '@/lib/activity'
import { ActivityGraphic } from './ActivityGraphic'
import {
  CharacterHeader, VitalsPanel, MarkdownCard, CaptainsLogCard,
  RecentActivityFeed, FinancialSparkline,
} from './CharacterPanels'

interface Props {
  profile: Profile
  status: { connected: boolean; running: boolean; safeDocking?: boolean }
  playerData: Record<string, unknown> | null
  onOpenEditor: () => void
}

const MAX_ENTRIES = 200

// Per-profile cache so the feed is instantly populated on profile switch and
// stays at parity with the editor's LogPane (which also caches + HTTP-seeds).
const entriesCache = new Map<string, LogEntry[]>()

export function CharacterPage({ profile, status, playerData, onOpenEditor }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [activityString, setActivityString] = useState('idle')
  const [now, setNow] = useState(() => Date.now())
  const [sseKey, setSseKey] = useState(0)
  const esRef = useRef<EventSource | null>(null)

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
  }, [profile.id, mergeEntries])

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
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto">
        <CharacterHeader profile={profile} status={status} onOpenEditor={onOpenEditor} />

        {/* Hero: compact activity graphic (~1/4 area) + vitals taking the rest */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-1 max-w-sm">
            <ActivityGraphic result={activity} shipName={shipName} />
          </div>
          <div className="lg:col-span-2 min-h-0">
            <VitalsPanel playerData={playerData} />
          </div>
        </div>

        {/* Directive (wide) + wealth */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <MarkdownCard title="Directive" kind="directive" content={profile.directive} source="Local" />
          </div>
          <FinancialSparkline profileId={profile.id} />
        </div>

        {/* Todo / Memory / Captain's Log */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <MarkdownCard title="TODO" kind="todo" content={profile.todo} source="Local" />
          <MarkdownCard title="Memory" kind="memory" content={profile.memory} source="Local" />
          <CaptainsLogCard profileId={profile.id} connected={status.connected} />
        </div>

        {/* Recent activity feed */}
        <RecentActivityFeed entries={entries} />
      </div>
    </div>
  )
}
