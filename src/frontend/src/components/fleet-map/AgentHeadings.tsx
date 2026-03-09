import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, type ThemeColors } from './galaxy-utils'
import type { AgentPosition } from './AgentMarkers'

export interface AgentHeading {
  from: GalaxySystem
  to: GalaxySystem
}

interface Props {
  agents: AgentPosition[]
  headings: Map<string, AgentHeading>
  colors: ThemeColors
}

const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

/** Directional cone per agent showing last travel direction */
function HeadingCone({ agent, heading, color }: {
  agent: AgentPosition
  heading: AgentHeading
  color: string
}) {
  const meshRef = useRef<THREE.Mesh>(null)

  const toY = systemZ(heading.to.system_id) + 120
  const fromY = systemZ(heading.from.system_id) + 120

  useEffect(() => {
    if (!meshRef.current) return

    // Compute direction vector from → to
    _dir.set(
      heading.to.position.x - heading.from.position.x,
      toY - fromY,
      heading.to.position.y - heading.from.position.y,
    ).normalize()

    // Position cone at agent's system, slightly offset in travel direction
    const baseX = agent.system.position.x
    const baseZ = agent.system.position.y
    const baseY = systemZ(agent.system.system_id) + 120

    meshRef.current.position.set(
      baseX + _dir.x * 100,
      baseY + _dir.y * 100,
      baseZ + _dir.z * 100,
    )

    // Orient cone: default ConeGeometry points along +Y, we want it along _dir
    const quaternion = new THREE.Quaternion()
    quaternion.setFromUnitVectors(_up, _dir)
    meshRef.current.quaternion.copy(quaternion)
  }, [agent, heading, toY, fromY])

  return (
    <mesh ref={meshRef}>
      <coneGeometry args={[15, 60, 4]} />
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.85} />
    </mesh>
  )
}

export function AgentHeadings({ agents, headings, colors }: Props) {
  if (headings.size === 0) return null

  return (
    <>
      {agents.map(agent => {
        const heading = headings.get(agent.profile.id)
        if (!heading) return null
        return (
          <HeadingCone
            key={agent.profile.id}
            agent={agent}
            heading={heading}
            color={colors.agents[agent.index % colors.agents.length]}
          />
        )
      })}
    </>
  )
}
