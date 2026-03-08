import { useMemo } from 'react'
import * as THREE from 'three'
import type { GalaxySystem } from '@shared/galaxy-types'
import { systemZ, type ThemeColors } from './galaxy-utils'

interface Props {
  systems: GalaxySystem[]
  systemById: Map<string, GalaxySystem>
  colors: ThemeColors
}

export function Connections({ systems, systemById, colors }: Props) {
  const geometry = useMemo(() => {
    const verts: number[] = []
    const drawn = new Set<string>()

    for (const sys of systems) {
      const z1 = systemZ(sys.system_id)
      for (const cid of sys.connections) {
        const key = sys.system_id < cid ? `${sys.system_id}|${cid}` : `${cid}|${sys.system_id}`
        if (drawn.has(key)) continue
        drawn.add(key)
        const conn = systemById.get(cid)
        if (!conn) continue
        const z2 = systemZ(conn.system_id)
        verts.push(sys.position.x, z1, sys.position.y)
        verts.push(conn.position.x, z2, conn.position.y)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    return geo
  }, [systems, systemById])

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color={colors.muted}
        transparent
        opacity={0.1}
        depthWrite={false}
      />
    </lineSegments>
  )
}
