/** Comms tab — faction roster (faction_info) + chat history (get_chat_history) across channels. */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Users, MessageSquare, RefreshCw } from 'lucide-react'
import type { Profile } from '@/types'
import { formatTime } from '@/components/log/log-shared'
import { DossierCard } from '../DossierCard'

interface FactionMember {
  player_id: string
  username: string
  role: string
  is_online: boolean
}

interface FactionRef {
  id: string
  name: string
  tag: string
}

interface FactionInfo {
  name: string
  tag: string
  description?: string
  leader_username?: string
  member_count?: number
  members?: FactionMember[]
  allies?: FactionRef[] | null
  enemies?: FactionRef[] | null
  at_war?: boolean
}

interface ChatMessage {
  id: string
  channel: string
  sender: string
  content: string
  timestamp_utc?: string
}

// Channels accepted by get_chat_history; local/system fail while in transit, which is fine.
const CHAT_CHANNELS = ['faction', 'local', 'system']
const MAX_MESSAGES = 30

const CHANNEL_COLOR: Record<string, string> = {
  faction: 'var(--smui-purple)',
  local: 'var(--smui-frost-2)',
  system: 'var(--smui-orange)',
}

const factionCache = new Map<string, FactionInfo>()
const chatCache = new Map<string, ChatMessage[]>()

async function runCommand(profileId: string, command: string, args?: Record<string, unknown>) {
  const resp = await fetch(`/api/profiles/${profileId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ? { command, args, silent: true } : { command, silent: true }),
  })
  return resp.json()
}

function FactionChip({ faction, hostile }: { faction: FactionRef; hostile?: boolean }) {
  const color = hostile ? 'var(--smui-red)' : 'var(--muted-foreground)'
  return (
    <span
      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border whitespace-nowrap"
      style={{ color: `hsl(${color})`, borderColor: `hsl(${color} / 0.4)` }}
      title={faction.name}
    >
      {faction.name} [{faction.tag}]
    </span>
  )
}

export function CommsTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [faction, setFaction] = useState<FactionInfo | null>(() => factionCache.get(profile.id) || null)
  const [factionNote, setFactionNote] = useState<string | null>(null)
  const [factionLoading, setFactionLoading] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatCache.get(profile.id) || [])
  const [chatLoading, setChatLoading] = useState(false)
  const profileIdRef = useRef(profile.id)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    profileIdRef.current = profile.id
    setFaction(factionCache.get(profile.id) || null)
    setFactionNote(null)
    setMessages(chatCache.get(profile.id) || [])
  }, [profile.id])

  const fetchFaction = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setFactionLoading(true)
    try {
      const data = await runCommand(targetId, 'faction_info')
      if (profileIdRef.current !== targetId) return
      if (data?.error) {
        setFaction(null)
        // Game errors are {code, message}; transport errors from the /command route are plain strings.
        setFactionNote(typeof data.error === 'string'
          ? data.error
          : String(data.error.message || data.error.code || 'Faction info unavailable'))
        return
      }
      const result = data.structuredContent || data.result || data
      if (result?.name) {
        factionCache.set(targetId, result as FactionInfo)
        setFaction(result as FactionInfo)
        setFactionNote(null)
      } else {
        setFaction(null)
        setFactionNote('Not in a faction')
      }
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setFactionLoading(false)
    }
  }, [profile.id, connected])

  const fetchChat = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setChatLoading(true)
    try {
      // Some channels are unavailable in transit — collect whichever succeed.
      const results = await Promise.all(
        CHAT_CHANNELS.map(channel =>
          runCommand(targetId, 'get_chat_history', { channel }).catch(() => null)
        )
      )
      if (profileIdRef.current !== targetId) return
      const seen = new Set<string>()
      const collected: ChatMessage[] = []
      for (const r of results) {
        const result = r?.structuredContent || r?.result
        if (!Array.isArray(result?.messages)) continue
        for (const m of result.messages as ChatMessage[]) {
          if (!m?.id || seen.has(m.id)) continue
          seen.add(m.id)
          collected.push(m)
        }
      }
      collected.sort((a, b) => (a.timestamp_utc || '').localeCompare(b.timestamp_utc || ''))
      const recent = collected.slice(-MAX_MESSAGES)
      chatCache.set(targetId, recent)
      // Keep the previous array when nothing changed so the [messages] scroll
      // effect doesn't yank a reader to the bottom on every poll tick.
      setMessages(prev =>
        prev.length === recent.length && prev.every((m, i) => m.id === recent[i].id) ? prev : recent
      )
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setChatLoading(false)
    }
  }, [profile.id, connected])

  useEffect(() => {
    if (!connected) return
    fetchFaction()
    fetchChat()
    const t = setInterval(() => { fetchFaction(); fetchChat() }, 45_000)
    return () => clearInterval(t)
  }, [connected, fetchFaction, fetchChat])

  // Keep newest message visible (newest renders at the bottom).
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const allies = faction && Array.isArray(faction.allies) ? faction.allies : []
  const enemies = faction && Array.isArray(faction.enemies) ? faction.enemies : []

  return (
    <div className="flex flex-col gap-4">
      <DossierCard
        title="Faction"
        icon={<Users size={12} />}
        source="Server"
        className="min-h-[140px] max-h-[420px]"
        action={
          <button onClick={fetchFaction} disabled={!connected || factionLoading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <RefreshCw size={11} className={factionLoading ? 'animate-spin' : ''} />
          </button>
        }
      >
        {!connected ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Connect to load faction info</div>
        ) : !faction ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">
            {factionLoading ? 'Loading...' : factionNote || 'No faction data'}
          </div>
        ) : (
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground">{faction.name}</span>
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted-foreground">[{faction.tag}]</span>
              {faction.at_war && (
                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 border" style={{ color: 'hsl(var(--smui-red))', borderColor: 'hsl(var(--smui-red) / 0.4)' }}>
                  At war
                </span>
              )}
              {faction.leader_username && (
                <span className="text-[10px] text-muted-foreground ml-auto">Leader: {faction.leader_username}</span>
              )}
            </div>
            {faction.description && (
              <p className="text-[11px] text-muted-foreground leading-relaxed">{faction.description}</p>
            )}
            <div>
              <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-1">
                Members{typeof faction.member_count === 'number' ? ` (${faction.member_count})` : ''}
              </div>
              {(faction.members || []).map(m => (
                <div key={m.player_id} className="flex items-center gap-2 py-1 border-t border-border/30 first:border-t-0">
                  <span className={`status-dot ${m.is_online ? 'status-dot-green' : 'status-dot-grey'}`} style={{ width: 6, height: 6 }} />
                  <span className="text-xs font-medium text-foreground/90 truncate flex-1">{m.username}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.role}</span>
                </div>
              ))}
            </div>
            {allies.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-1">Allies ({allies.length})</div>
                <div className="flex flex-wrap gap-1">
                  {allies.map(a => <FactionChip key={a.id} faction={a} />)}
                </div>
              </div>
            )}
            {enemies.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground mb-1">Enemies ({enemies.length})</div>
                <div className="flex flex-wrap gap-1">
                  {enemies.map(e => <FactionChip key={e.id} faction={e} hostile />)}
                </div>
              </div>
            )}
          </div>
        )}
      </DossierCard>

      <DossierCard
        title="Chat"
        icon={<MessageSquare size={12} />}
        source="Server"
        className="min-h-[140px]"
        action={
          <button onClick={fetchChat} disabled={!connected || chatLoading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <RefreshCw size={11} className={chatLoading ? 'animate-spin' : ''} />
          </button>
        }
      >
        {!connected ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Connect to load chat</div>
        ) : messages.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">{chatLoading ? 'Loading...' : 'No messages'}</div>
        ) : (
          <div ref={chatScrollRef} className="max-h-[360px] overflow-y-auto">
            {messages.map(m => (
              <div key={m.id} className="px-3 py-1.5 border-t border-border/30 first:border-t-0">
                <div className="flex items-center gap-2 mb-0.5">
                  {m.timestamp_utc && (
                    <span className="text-[9px] text-muted-foreground/40 tabular-nums shrink-0">{formatTime(m.timestamp_utc)}</span>
                  )}
                  <span
                    className="text-[9px] uppercase tracking-wider px-1 border shrink-0"
                    style={{
                      color: `hsl(${CHANNEL_COLOR[m.channel] || 'var(--muted-foreground)'})`,
                      borderColor: `hsl(${CHANNEL_COLOR[m.channel] || 'var(--muted-foreground)'} / 0.4)`,
                    }}
                  >
                    {m.channel}
                  </span>
                  <span className="text-[11px] font-bold text-foreground/90 truncate">{m.sender}</span>
                </div>
                <p className="text-[11px] text-foreground/75 leading-relaxed break-words">{m.content}</p>
              </div>
            ))}
          </div>
        )}
      </DossierCard>
    </div>
  )
}
