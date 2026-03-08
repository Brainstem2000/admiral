import { useState } from 'react'
import { ChevronDown, ChevronRight, MapPin } from 'lucide-react'
import type { Profile } from '@/types'
import { AGENT_COLORS } from '@shared/galaxy-types'

interface Props {
  profiles: Profile[]
  statuses: Record<string, { connected: boolean; running: boolean }>
  playerDataMap: Record<string, Record<string, unknown>>
  onCenter: (systemName: string) => void
}

function resolveColor(varName: string): string {
  const style = getComputedStyle(document.documentElement)
  const raw = style.getPropertyValue(varName).trim()
  return raw ? `hsl(${raw})` : '#888'
}

export function FleetLegend({ profiles, statuses, playerDataMap, onCenter }: Props) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="absolute top-3 right-3 z-20 bg-card/95 border border-border backdrop-blur-sm min-w-[200px] max-w-[260px]">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/30 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-[11px] text-muted-foreground uppercase tracking-[1.5px] font-medium">Fleet</span>
        <span className="text-[10px] text-muted-foreground/50 ml-auto">{profiles.length}</span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {profiles.map((p, i) => {
            const status = statuses[p.id] || { connected: false, running: false }
            const pd = playerDataMap[p.id]
            const player = (pd?.player || {}) as Record<string, unknown>
            const location = (pd?.location || {}) as Record<string, unknown>
            const systemName = String(player.current_system || location.system_name || pd?.system || '')
            const credits = Number(player.credits ?? pd?.credits ?? 0)
            const colorVar = AGENT_COLORS[i % AGENT_COLORS.length]

            return (
              <button
                key={p.id}
                onClick={() => systemName && onCenter(systemName)}
                className="flex items-start gap-2 w-full px-3 py-1.5 text-left hover:bg-secondary/30 transition-colors border-b border-border/30 last:border-b-0"
                disabled={!systemName}
              >
                <div
                  className="w-2.5 h-2.5 mt-0.5 shrink-0"
                  style={{
                    backgroundColor: resolveColor(colorVar),
                    clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground truncate">{p.name}</span>
                    {!status.connected && (
                      <span className="text-[9px] text-muted-foreground/40">offline</span>
                    )}
                  </div>
                  {systemName && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <MapPin size={8} className="shrink-0" />
                      <span className="truncate">{systemName}</span>
                      {credits > 0 && (
                        <span className="text-[hsl(var(--smui-yellow))] ml-auto shrink-0">
                          {credits.toLocaleString()}c
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
