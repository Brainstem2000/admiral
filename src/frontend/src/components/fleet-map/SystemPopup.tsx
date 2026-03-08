import { useEffect } from 'react'
import { Html } from '@react-three/drei'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, type ThemeColors } from './galaxy-utils'
import type { AgentPosition } from './AgentMarkers'

interface Props {
  system: GalaxySystem
  agents: AgentPosition[]
  colors: ThemeColors
  onClose: () => void
}

export function SystemPopup({ system, agents, colors, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const z = systemZ(system.system_id)
  const empireColor = system.empire ? (colors.empires[system.empire] || colors.muted) : colors.muted

  return (
    <Html
      position={[system.position.x, z, system.position.y]}
      center
      distanceFactor={4000}
      style={{ pointerEvents: 'auto' }}
    >
      <div
        className="bg-card/95 border border-border backdrop-blur-sm p-3 min-w-[180px] max-w-[240px]"
        style={{ transform: 'translateX(20px) translateY(-20px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium text-foreground">{system.name}</span>
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          {system.empire && (
            <div className="flex justify-between">
              <span>Empire</span>
              <span className="capitalize" style={{ color: empireColor }}>
                {system.empire}
              </span>
            </div>
          )}
          <div className="flex justify-between"><span>POIs</span><span>{system.poi_count}</span></div>
          <div className="flex justify-between"><span>Online</span><span>{system.online}</span></div>
          <div className="flex justify-between"><span>Connections</span><span>{system.connections.length}</span></div>
          {system.visited && <div className="text-[10px] text-muted-foreground/50">Visited</div>}
        </div>
        {agents.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">Agents Here</div>
            {agents.map(ap => (
              <div key={ap.profile.id} className="flex items-center gap-1.5 text-[11px]">
                <div
                  className="w-2 h-2 shrink-0"
                  style={{
                    backgroundColor: colors.agents[ap.index % colors.agents.length],
                    clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                  }}
                />
                <span className="text-foreground">{ap.profile.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Html>
  )
}
