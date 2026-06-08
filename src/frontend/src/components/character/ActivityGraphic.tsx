/**
 * The animated activity graphic: maps an ActivityResult → a themed SVG scene
 * with a cross-fade on change and a live caption pill.
 */
import type { ActivityResult } from '@/lib/activity'
import { SCENES, KIND_ACCENT } from './ActivityScenes'

interface Props {
  result: ActivityResult
  /** Ship name/class to label the scene (upper-right). */
  shipName?: string
  className?: string
}

export function ActivityGraphic({ result, shipName, className = '' }: Props) {
  const Scene = SCENES[result.kind]
  const accent = KIND_ACCENT[result.kind]

  return (
    <div
      role="img"
      aria-label={`Activity: ${result.label}${shipName ? ` — ${shipName}` : ''}`}
      className={`activity-stage relative w-full aspect-[16/9] border border-border overflow-hidden ${className}`}
      style={{ ['--activity-accent' as string]: accent }}
    >
      {/* Scene — keyed by kind so it remounts + cross-fades on change */}
      <div key={result.kind} className="scene-fade absolute inset-0" style={{ opacity: result.stale ? 0.55 : 1 }}>
        <Scene />
      </div>

      {/* Ship name — upper-right */}
      {shipName && (
        <div className="absolute top-2 right-2 px-2 py-0.5 bg-card/80 backdrop-blur-sm border border-border text-[10px] uppercase tracking-[1.5px] text-foreground/70 max-w-[60%] truncate">
          {shipName}
        </div>
      )}

      {/* Accent edge glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: `inset 0 0 40px hsl(var(--activity-accent) / ${result.stale ? 0.04 : 0.1})` }}
      />

      {/* Caption pill */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2 px-2.5 py-1 bg-card/80 backdrop-blur-sm border border-border">
        <span
          className={`w-1.5 h-1.5 rounded-full ${result.stale ? '' : 'activity-pulse'}`}
          style={{ background: result.stale ? MUTED : accent }}
        />
        <span className="text-[10px] uppercase tracking-[1.5px] text-foreground/80 truncate max-w-[220px]">
          {result.label}
        </span>
      </div>
    </div>
  )
}

const MUTED = 'hsl(var(--muted-foreground))'
