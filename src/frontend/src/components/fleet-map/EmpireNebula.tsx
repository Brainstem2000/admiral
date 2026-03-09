import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, getEmpireColor, type ThemeColors } from './galaxy-utils'

interface Props {
  systems: GalaxySystem[]
  systemById: Map<string, GalaxySystem>
  colors: ThemeColors
}

const tempObj = new THREE.Object3D()
const tempColor = new THREE.Color()

/** Ambient nebula glow around empire territory clusters using additive-blended transparent spheres */
export function EmpireNebula({ systems, systemById, colors }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null)

  // Precompute cluster density per system: how many neighbors share the same empire
  const clusterWeights = useMemo(() => {
    const weights = new Map<string, number>()
    for (const sys of systems) {
      if (!sys.empire) {
        weights.set(sys.system_id, 0.15)
        continue
      }
      let sameEmpire = 0
      for (const cid of sys.connections) {
        const neighbor = systemById.get(cid)
        if (neighbor?.empire === sys.empire) sameEmpire++
      }
      const ratio = sys.connections.length > 0
        ? sameEmpire / sys.connections.length
        : 0
      weights.set(sys.system_id, 0.4 + ratio * 0.6) // 0.4 to 1.0
    }
    return weights
  }, [systems, systemById])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i]
      const z = systemZ(sys.system_id)
      const weight = clusterWeights.get(sys.system_id) ?? 0.3

      tempObj.position.set(sys.position.x, z, sys.position.y)
      const scale = sys.empire
        ? 200 + weight * 400 // 200–600 for empire systems
        : 120                // small dim for unaffiliated
      tempObj.scale.setScalar(scale)
      tempObj.updateMatrix()
      mesh.setMatrixAt(i, tempObj.matrix)

      const hex = getEmpireColor(sys.empire, colors)
      tempColor.set(hex)
      mesh.setColorAt(i, tempColor)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [systems, colors, clusterWeights])

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, systems.length]}
      renderOrder={-2}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial
        transparent
        opacity={0.04}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
