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
  // Status data from slimGameState
  docked?: boolean
  hull?: string       // "200/200"
  shield?: string     // "90/90"
  fuel?: string       // "154/220"
  cargo?: string      // "0/560"
  credits?: number
}

interface Props {
  agents: AgentPosition[]
  colors: ThemeColors
}

/** Parse "current/max" string into a 0-1 ratio */
function parseRatio(val?: string): number | null {
  if (!val) return null
  const parts = val.split('/')
  if (parts.length !== 2) return null
  const cur = parseFloat(parts[0])
  const max = parseFloat(parts[1])
  if (isNaN(cur) || isNaN(max) || max === 0) return null
  return Math.min(cur / max, 1)
}

/** Mini bar indicator color */
function barColor(ratio: number, type: 'hull' | 'shield' | 'fuel' | 'cargo'): string {
  if (type === 'shield') return '#60a5fa'
  if (type === 'fuel') {
    if (ratio < 0.2) return '#ef4444'
    if (ratio < 0.4) return '#f59e0b'
    return '#22c55e'
  }
  if (type === 'hull') {
    if (ratio < 0.3) return '#ef4444'
    if (ratio < 0.6) return '#f59e0b'
    return '#22c55e'
  }
  // cargo: inverse (fuller = more yellow/orange)
  if (ratio > 0.9) return '#ef4444'
  if (ratio > 0.7) return '#f59e0b'
  return '#6b7280'
}

function MiniBar({ ratio, type, width }: { ratio: number; type: 'hull' | 'shield' | 'fuel' | 'cargo'; width: number }) {
  const color = barColor(ratio, type)
  return (
    <div style={{ width, height: 3, background: 'rgba(0,0,0,0.6)', borderRadius: 1, overflow: 'hidden' }}>
      <div style={{ width: `${ratio * 100}%`, height: '100%', background: color, borderRadius: 1 }} />
    </div>
  )
}

function AgentDiamond({ agent, color }: { agent: AgentPosition; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const baseY = systemZ(agent.system.system_id)
  const offset = 120

  useFrame(({ clock }) => {
    if (meshRef.current) {
      if (agent.running) {
        const pulse = 1 + Math.sin(clock.getElapsedTime() * 3) * 0.2
        meshRef.current.scale.setScalar(pulse)
      }
    }
    // Docked ring rotates slowly
    if (ringRef.current) {
      ringRef.current.rotation.z = clock.getElapsedTime() * 0.5
    }
  })

  const hullRatio = parseRatio(agent.hull)
  const fuelRatio = parseRatio(agent.fuel)
  const cargoRatio = parseRatio(agent.cargo)

  return (
    <group position={[agent.system.position.x, baseY + offset, agent.system.position.y]}>
      {/* Main diamond marker */}
      <mesh ref={meshRef}>
        <octahedronGeometry args={[60, 0]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>

      {/* Docked indicator: ring around diamond */}
      {agent.docked && (
        <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[85, 5, 8, 16]} />
          <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.6} />
        </mesh>
      )}

      {/* Not running indicator: dimmed */}
      {!agent.running && (
        <mesh>
          <octahedronGeometry args={[70, 0]} />
          <meshBasicMaterial color="#000000" toneMapped={false} transparent opacity={0.5} wireframe />
        </mesh>
      )}

      {/* Agent label + status HUD */}
      <Html
        center
        distanceFactor={5000}
        style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          {/* Name tag */}
          <div
            style={{
              background: 'rgba(0,0,0,0.8)',
              color,
              padding: '2px 6px',
              fontSize: '10px',
              fontFamily: '"JetBrains Mono", monospace',
              fontWeight: 'bold',
              letterSpacing: '0.5px',
              borderRadius: '2px',
              transform: 'translateY(-22px)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {agent.docked && (
              <span style={{ fontSize: '8px', opacity: 0.7 }} title="Docked">⚓</span>
            )}
            {agent.profile.name}
            {!agent.running && (
              <span style={{ fontSize: '7px', color: '#6b7280', marginLeft: 2 }}>OFF</span>
            )}
          </div>

          {/* Mini status bars */}
          {(hullRatio !== null || fuelRatio !== null) && (
            <div
              style={{
                background: 'rgba(0,0,0,0.7)',
                padding: '2px 4px',
                borderRadius: 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                transform: 'translateY(-18px)',
              }}
            >
              {hullRatio !== null && <MiniBar ratio={hullRatio} type="hull" width={40} />}
              {fuelRatio !== null && <MiniBar ratio={fuelRatio} type="fuel" width={40} />}
              {cargoRatio !== null && <MiniBar ratio={cargoRatio} type="cargo" width={40} />}
            </div>
          )}
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
