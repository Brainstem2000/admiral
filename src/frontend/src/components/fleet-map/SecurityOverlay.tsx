import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { GalaxySystem } from '@shared/galaxy-types'
import type { ThreatIntel } from '@shared/fleet-intel-types'
import { systemZ, type ThemeColors } from './galaxy-utils'

interface Props {
  systems: GalaxySystem[]
  threats: ThreatIntel[]
  colors: ThemeColors
}

const tempObj = new THREE.Object3D()
const tempColor = new THREE.Color()

const SAFE_COLOR = '#22c55e'
const DANGER_COLOR = '#ef4444'

/** Safety heatmap overlay: green for empire zones, red for threatened/lawless areas */
export function SecurityOverlay({ systems, threats }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null)

  // Set of system IDs with active threats
  const threatenedSystems = useMemo(() => {
    const set = new Set<string>()
    for (const t of threats) set.add(t.system_id)
    return set
  }, [threats])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i]
      const z = systemZ(sys.system_id)
      const hasThreat = threatenedSystems.has(sys.system_id)

      tempObj.position.set(sys.position.x, z, sys.position.y)

      if (hasThreat) {
        // Dangerous — red glow, larger
        tempObj.scale.setScalar(400)
        tempColor.set(DANGER_COLOR)
      } else if (sys.empire) {
        // Safe — green glow
        tempObj.scale.setScalar(300)
        tempColor.set(SAFE_COLOR)
      } else {
        // Neutral — hide
        tempObj.scale.setScalar(0)
        tempColor.set('#000000')
      }

      tempObj.updateMatrix()
      mesh.setMatrixAt(i, tempObj.matrix)
      mesh.setColorAt(i, tempColor)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [systems, threatenedSystems])

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, systems.length]}
      renderOrder={-1}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial
        transparent
        opacity={0.03}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
