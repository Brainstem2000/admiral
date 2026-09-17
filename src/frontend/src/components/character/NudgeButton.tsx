/**
 * Nudge control for the Character dossier.
 *
 * The Fleet view has had one since the tour was written; the Character page did
 * not, so the most common corrective action on the screen you actually watch an
 * agent from required leaving it for the editor first.
 *
 * Self-contained on purpose. The Fleet version lives inside ProfileView's ~1,400
 * lines of editor state; lifting it would have dragged that state into a
 * read-focused page. The shared surface is the API and the localStorage history
 * key, so history is the SAME list in both places — an operator who nudged from
 * Fleet finds that message on ArrowUp here.
 *
 * A nudge RESTARTS the agent's turn and aborts a paced sleep, which is why it is
 * the right control to reach for when an agent is stuck or waiting.
 */
import { useState, useRef, useEffect } from 'react'
import { MessageSquare, X } from 'lucide-react'

const MAX_NUDGE_HISTORY = 50
/** Must match ProfileView's key exactly — one history per agent, both views. */
const keyFor = (profileId: string) => `admiral-nudge-history-${profileId}`

function readHistory(profileId: string): string[] {
  try {
    const raw = localStorage.getItem(keyFor(profileId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function pushHistory(profileId: string, msg: string): void {
  try {
    const filtered = readHistory(profileId).filter(m => m !== msg)
    filtered.unshift(msg)
    localStorage.setItem(keyFor(profileId), JSON.stringify(filtered.slice(0, MAX_NUDGE_HISTORY)))
  } catch { /* a missing history must never block sending */ }
}

export function NudgeButton({ profileId, running }: { profileId: string; running: boolean }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState('')
  const [histIndex, setHistIndex] = useState(-1)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  function openModal() {
    setValue(''); setPending(''); setHistIndex(-1); setError(null); setOpen(true)
  }

  async function send() {
    const trimmed = value.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/profiles/${profileId}/nudge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Only record a message that actually reached the agent — a failed send
      // left in history reads as "already sent that" on the next ArrowUp.
      pushHistory(profileId, trimmed)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'Enter') { e.preventDefault(); void send(); return }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const history = readHistory(profileId)
      if (!history.length) return
      if (histIndex === -1) { setPending(value); setHistIndex(0); setValue(history[0]) }
      else if (histIndex < history.length - 1) { const n = histIndex + 1; setHistIndex(n); setValue(history[n]) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIndex <= 0) { setHistIndex(-1); setValue(pending) }
      else { const history = readHistory(profileId); const n = histIndex - 1; setHistIndex(n); setValue(history[n]) }
    }
  }

  return (
    <>
      <button
        onClick={openModal}
        disabled={!running}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[1.5px] px-2.5 py-1 border transition-colors
          text-primary border-primary/30 hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title={running ? 'Send a message to this agent — restarts its turn immediately' : 'Agent is not running'}
      >
        <MessageSquare size={11} />
        Nudge
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 pt-[18vh]" onClick={() => setOpen(false)}>
          <div className="bg-card border border-border shadow-lg w-full max-w-2xl mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="font-jetbrains text-xs font-semibold tracking-[1.5px] text-primary uppercase">Nudge agent</span>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="px-4 py-3 flex flex-col gap-2">
              <input
                ref={inputRef}
                value={value}
                onChange={e => { setValue(e.target.value); setHistIndex(-1) }}
                onKeyDown={onKeyDown}
                placeholder="What should the agent know or do right now?"
                className="w-full bg-input border border-border px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
              />
              {error && <span className="text-[11px]" style={{ color: 'hsl(var(--smui-orange))' }}>Send failed: {error}</span>}
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground/60">
                  Enter to send · Esc to cancel · ↑↓ for previous nudges
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => void send()}
                  disabled={!value.trim() || sending}
                  className="text-[10px] uppercase tracking-[1.5px] px-3 py-1 border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-30 transition-colors"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/50 border-t border-border/40 pt-2">
                A nudge restarts the agent's current turn and wakes it out of a paced sleep, so it
                acts on this immediately rather than at its next scheduled turn.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
