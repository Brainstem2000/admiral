import { useMemo } from 'react'
import * as THREE from 'three'

const STAR_COUNT = 2500
const SPREAD = 50000

export function BackgroundStars() {
  const geometry = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * SPREAD
      positions[i * 3 + 1] = (Math.random() - 0.5) * SPREAD
      positions[i * 3 + 2] = (Math.random() - 0.5) * SPREAD
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return geo
  }, [])

  return (
    <points geometry={geometry}>
      <pointsMaterial
        color="#ffffff"
        size={15}
        sizeAttenuation
        transparent
        opacity={0.4}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}
