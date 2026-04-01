import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, getEmpireColor, type ThemeColors } from './galaxy-utils'
import type { AgentPosition } from './AgentMarkers'

interface Props {
  systems: GalaxySystem[]
  agents: AgentPosition[]
  hoveredId: string | null
  colors: ThemeColors
}

/** Always-on labels for systems with agents + hovered system */
export function SystemLabels({ systems, agents, hoveredId, colors }: Props) {
  // Systems that have agents in them
  const agentSystemIds = useMemo(() => {
    const ids = new Set<string>()
    for (const a of agents) ids.add(a.system.system_id)
    return ids
  }, [agents])

  // Major hub systems (high POI count or high online players)
  const hubSystemIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of systems) {
      if (s.poi_count >= 4 || s.online >= 5) ids.add(s.system_id)
    }
    return ids
  }, [systems])

  // Collect systems to label: agent systems + hubs + hovered
  const labeledSystems = useMemo(() => {
    const result: Array<{ sys: GalaxySystem; type: 'agent' | 'hub' | 'hovered' }> = []
    const seen = new Set<string>()

    // Hovered system (highest priority)
    if (hoveredId) {
      const sys = systems.find(s => s.system_id === hoveredId)
      if (sys) {
        result.push({ sys, type: 'hovered' })
        seen.add(hoveredId)
      }
    }

    // Agent systems
    for (const s of systems) {
      if (seen.has(s.system_id)) continue
      if (agentSystemIds.has(s.system_id)) {
        result.push({ sys: s, type: 'agent' })
        seen.add(s.system_id)
      }
    }

    // Hub systems
    for (const s of systems) {
      if (seen.has(s.system_id)) continue
      if (hubSystemIds.has(s.system_id)) {
        result.push({ sys: s, type: 'hub' })
        seen.add(s.system_id)
      }
    }

    return result
  }, [systems, agents, hoveredId, agentSystemIds, hubSystemIds])

  return (
    <>
      {labeledSystems.map(({ sys, type }) => {
        const z = systemZ(sys.system_id)
        const empireColor = getEmpireColor(sys.empire, colors)
        const isHovered = type === 'hovered'
        const isAgent = type === 'agent'

        return (
          <Html
            key={sys.system_id}
            position={[sys.position.x, z - 60, sys.position.y]}
            center
            distanceFactor={isHovered ? 3000 : isAgent ? 5000 : 7000}
            style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          >
            <div
              style={{
                color: isHovered ? colors.foreground : isAgent ? empireColor : colors.muted,
                fontSize: isHovered ? '11px' : isAgent ? '9px' : '8px',
                fontFamily: '"JetBrains Mono", monospace',
                fontWeight: isHovered ? 'bold' : 'normal',
                letterSpacing: '0.5px',
                textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
                opacity: isHovered ? 1 : isAgent ? 0.9 : 0.5,
              }}
            >
              {sys.name}
              {isHovered && sys.online > 0 && (
                <span style={{ fontSize: '8px', marginLeft: '4px', opacity: 0.6 }}>
                  ({sys.online} online)
                </span>
              )}
            </div>
          </Html>
        )
      })}
    </>
  )
}
