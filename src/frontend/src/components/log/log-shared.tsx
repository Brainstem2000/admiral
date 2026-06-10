/** Canonical log constants/helpers shared by LogPane, CharacterPanels, and AnalyticsPane. */
import { Check, Minus } from 'lucide-react'
import type { LogType } from '@/types'

export const FILTER_GROUPS: { key: string; label: string; types: LogType[] }[] = [
  { key: 'call', label: 'Call', types: ['llm_call'] },
  { key: 'llm', label: 'LLM', types: ['llm_thought'] },
  { key: 'tools', label: 'Tools', types: ['tool_call', 'tool_result'] },
  { key: 'server', label: 'Server', types: ['server_message', 'notification'] },
  { key: 'errors', label: 'Errors', types: ['error'] },
  { key: 'system', label: 'System', types: ['connection', 'system'] },
]

export const ALL_FILTER_KEYS = FILTER_GROUPS.map(g => g.key)

// Persist filter selections across profile switches via localStorage
const FILTER_STORAGE_KEY = 'admiral-log-filters'

export function loadSavedFilters(): Set<string> | null {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) {
      const arr = JSON.parse(stored)
      if (Array.isArray(arr)) return new Set(arr as string[])
    }
  } catch { /* ignore */ }
  return null
}

export function persistFilters(filters: Set<string>) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...filters])) } catch { /* ignore */ }
}

export const BADGE_CLASS: Record<string, string> = {
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

export const TYPE_LABELS: Record<string, string> = {
  connection: 'CONNECT',
  error: 'ERROR',
  llm_call: 'CALL',
  llm_thought: 'LLM',
  tool_call: 'TOOL',
  tool_result: 'RESULT',
  server_message: 'SERVER',
  notification: 'NOTIFY',
  system: 'SYSTEM',
}

export function FilterCheckbox({ label, count, checked, indeterminate, onChange }: {
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
        checked || indeterminate
          ? 'bg-primary/20 border-primary/60'
          : 'border-border'
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

/** Normalize a timestamp into a proper ISO 8601 string so Date parsing is
 *  consistent across browsers. SQLite's datetime('now') returns UTC as
 *  "YYYY-MM-DD HH:MM:SS" (space, no T, no Z) which some engines misparse. */
export function toISO(timestamp: string): string {
  let s = timestamp.replace(' ', 'T')
  if (!s.includes('Z') && !s.includes('+') && !s.includes('-', 10)) s += 'Z'
  return s
}

export function formatTime(ts: string): string {
  try {
    const d = new Date(toISO(ts))
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  } catch { return ts.slice(11, 19) }
}
