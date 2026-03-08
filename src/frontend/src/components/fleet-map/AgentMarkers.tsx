import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Profile } from '@/types'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, type ThemeColors } from './galaxy-utils'

export interface AgentPosition {
  profile: Profile
  index: number
  system: GalaxySystem
  running: boolean
}

interface Props {
  agents: AgentPosition[]
  colors: ThemeColors
}

function AgentDiamond({ agent, color }: { agent: AgentPosition; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const baseY = systemZ(agent.system.system_id)
  const offset = 120 // Float above the system sphere

  useFrame(({ clock }) => {
    if (!meshRef.current) return
    if (agent.running) {
      const pulse = 1 + Math.sin(clock.getElapsedTime() * 3) * 0.2
      meshRef.current.scale.setScalar(pulse)
    }
  })

  return (
    <group position={[agent.system.position.x, baseY + offset, agent.system.position.y]}>
      <mesh ref={meshRef}>
        <octahedronGeometry args={[60, 0]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <Html
        center
        distanceFactor={5000}
        style={{
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        <div
          style={{
            background: 'rgba(0,0,0,0.75)',
            color,
            padding: '2px 6px',
            fontSize: '10px',
            fontFamily: '"JetBrains Mono", monospace',
            fontWeight: 'bold',
            letterSpacing: '0.5px',
            borderRadius: '2px',
            transform: 'translateY(-20px)',
          }}
        >
          {agent.profile.name}
        </div>
      </Html>
    </group>
  )
}

export function AgentMarkers({ agents, colors }: Props) {
  return (
    <>
      {agents.map(agent => (
        <AgentDiamond
          key={agent.profile.id}
          agent={agent}
          color={colors.agents[agent.index % colors.agents.length]}
        />
      ))}
    </>
  )
}
