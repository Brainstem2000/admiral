import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, getEmpireColor, type ThemeColors } from './galaxy-utils'

interface Props {
  systems: GalaxySystem[]
  colors: ThemeColors
  hoveredId: string | null
  selectedId: string | null
  onHover: (system: GalaxySystem | null) => void
  onSelect: (system: GalaxySystem) => void
}

const SPHERE_RADIUS = 40
const SPHERE_SEGMENTS = 6

const tempObj = new THREE.Object3D()
const tempColor = new THREE.Color()

export function StarSystems({ systems, colors, hoveredId, selectedId, onHover, onSelect }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null)

  const indexMap = useMemo(() => {
    const map = new Map<number, GalaxySystem>()
    systems.forEach((s, i) => map.set(i, s))
    return map
  }, [systems])

  // Set instance transforms, colors, and highlights
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i]
      const isHovered = sys.system_id === hoveredId
      const isSelected = sys.system_id === selectedId
      const z = systemZ(sys.system_id)

      tempObj.position.set(sys.position.x, z, sys.position.y)
      tempObj.scale.setScalar(isHovered || isSelected ? 1.8 : 1)
      tempObj.updateMatrix()
      mesh.setMatrixAt(i, tempObj.matrix)

      const hex = isSelected ? colors.primary : getEmpireColor(sys.empire, colors)
      tempColor.set(hex)
      if (!sys.visited && !isHovered && !isSelected) {
        tempColor.multiplyScalar(0.15)
      }
      mesh.setColorAt(i, tempColor)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [systems, colors, hoveredId, selectedId])

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (e.instanceId !== undefined) {
      const sys = indexMap.get(e.instanceId)
      onHover(sys || null)
    }
  }

  const handlePointerOut = () => {
    onHover(null)
  }

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.instanceId !== undefined) {
      const sys = indexMap.get(e.instanceId)
      if (sys) onSelect(sys)
    }
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, systems.length]}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    >
      <sphereGeometry args={[SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}
