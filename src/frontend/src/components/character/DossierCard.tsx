/** Shared card shell for the Character dossier — title strip + scrollable body. */
import type { ReactNode } from 'react'

interface Props {
  title: string
  icon?: ReactNode
  /** Small provenance tag, mirrors SidePane's Local/Server convention. */
  source?: 'Local' | 'Server'
  /** Optional header-right content (e.g. a refresh button). */
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export function DossierCard({ title, icon, source, action, children, className = '', bodyClassName = '' }: Props) {
  const sourceColor = source === 'Local' ? 'var(--smui-orange)' : 'var(--smui-frost-2)'
  return (
    <div className={`dossier-card flex flex-col min-h-0 ${className}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        {icon && <span className="text-muted-foreground shrink-0">{icon}</span>}
        <span className="text-[11px] uppercase tracking-[1.5px] font-medium text-foreground/80 flex-1 truncate">{title}</span>
        {source && (
          <span className="text-[9px] leading-none uppercase tracking-wider" style={{ color: `hsl(${sourceColor})` }}>
            {source}
          </span>
        )}
        {action}
      </div>
      <div className={`min-h-0 overflow-y-auto ${bodyClassName}`}>{children}</div>
    </div>
  )
}
