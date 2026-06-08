/**
 * Navigator-style route overlay for ONE agent (the selected one):
 *  - a fading breadcrumb trail through recently visited systems
 *  - an animated route line from the current system to its jump destination,
 *    with a "comet" dot traveling toward the destination and a pulsing ring + label
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ } from './galaxy-utils'

const MARKER_OFFSET = 120

function pos3(sys: GalaxySystem): [number, number, number] {
  return [sys.position.x, systemZ(sys.system_id) + MARKER_OFFSET, sys.position.y]
}

interface Props {
  /** Recently visited systems, oldest → newest (last entry = current system). */
  trail: GalaxySystem[]
  /** Current system the agent is in. */
  current: GalaxySystem | null
  /** Destination system being jumped to (null if not traveling). */
  destination: GalaxySystem | null
  /** Short label for the destination leg, e.g. "Jumping to HR_8832". */
  label?: string
  color: string
}

/** Fading breadcrumb polyline through visited systems. */
function Breadcrumb({ trail, color }: { trail: GalaxySystem[]; color: string }) {
  const geometry = useMemo(() => {
    if (trail.length < 2) return null
    const verts: number[] = []
    for (let i = 0; i < trail.length - 1; i++) {
      const a = pos3(trail[i])
      const b = pos3(trail[i + 1])
      verts.push(a[0], a[1], a[2], b[0], b[1], b[2])
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    return geo
  }, [trail])

  if (!geometry) return null
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.35} depthWrite={false} />
    </lineSegments>
  )
}

/** Animated current → destination route with a traveling comet + destination ring. */
function DestinationLeg({ current, destination, label, color }: {
  current: GalaxySystem
  destination: GalaxySystem
  label?: string
  color: string
}) {
  const cometRef = useRef<THREE.Mesh>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const a = useMemo(() => new THREE.Vector3(...pos3(current)), [current])
  const b = useMemo(() => new THREE.Vector3(...pos3(destination)), [destination])

  const lineGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3))
    return geo
  }, [a, b])

  useFrame(({ clock }) => {
    const t = (clock.getElapsedTime() % 2) / 2 // 0→1 every 2s
    if (cometRef.current) cometRef.current.position.lerpVectors(a, b, t)
    if (ringRef.current) {
      const s = 1 + Math.sin(clock.getElapsedTime() * 3) * 0.25
      ringRef.current.scale.setScalar(s)
    }
  })

  return (
    <group>
      {/* Route line */}
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial color={color} transparent opacity={0.7} depthWrite={false} />
      </lineSegments>

      {/* Traveling comet */}
      <mesh ref={cometRef}>
        <sphereGeometry args={[34, 12, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>

      {/* Destination pulsing ring */}
      <mesh ref={ringRef} position={[b.x, b.y, b.z]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[110, 6, 8, 24]} />
        <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.8} />
      </mesh>

      {/* Destination label */}
      <Html position={[b.x, b.y, b.z]} center distanceFactor={5000} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        <div
          style={{
            background: 'rgba(0,0,0,0.82)',
            color,
            padding: '2px 7px',
            fontSize: '10px',
            fontFamily: '"JetBrains Mono", monospace',
            fontWeight: 'bold',
            letterSpacing: '0.5px',
            borderRadius: '2px',
            transform: 'translateY(28px)',
            border: `1px solid ${color}`,
          }}
        >
          {label || `→ ${destination.name}`}
        </div>
      </Html>
    </group>
  )
}

export function AgentRoute({ trail, current, destination, label, color }: Props) {
  return (
    <>
      <Breadcrumb trail={trail} color={color} />
      {current && destination && destination.system_id !== current.system_id && (
        <DestinationLeg current={current} destination={destination} label={label} color={color} />
      )}
    </>
  )
}
