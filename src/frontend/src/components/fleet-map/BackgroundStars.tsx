import { useMemo } from 'react'
import * as THREE from 'three'

const STAR_COUNT = 2500
const TINT_COUNT = 400
const SPREAD = 50000

// Seeded random for deterministic star positions across renders
function seededRandom(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

export function BackgroundStars() {
  const geometry = useMemo(() => {
    const rand = seededRandom(42)
    const positions = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      positions[i * 3] = (rand() - 0.5) * SPREAD
      positions[i * 3 + 1] = (rand() - 0.5) * SPREAD
      positions[i * 3 + 2] = (rand() - 0.5) * SPREAD
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return geo
  }, [])

  // Second layer: larger, subtly tinted ambient particles
  const tintGeometry = useMemo(() => {
    const rand = seededRandom(137)
    const positions = new Float32Array(TINT_COUNT * 3)
    const colors = new Float32Array(TINT_COUNT * 3)
    const warmGold = new THREE.Color('#ffd699')
    const coolBlue = new THREE.Color('#99ccff')
    for (let i = 0; i < TINT_COUNT; i++) {
      positions[i * 3] = (rand() - 0.5) * SPREAD
      positions[i * 3 + 1] = (rand() - 0.5) * SPREAD
      positions[i * 3 + 2] = (rand() - 0.5) * SPREAD
      // Alternate warm and cool tints
      const c = rand() > 0.5 ? warmGold : coolBlue
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    return geo
  }, [])

  return (
    <>
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
      <points geometry={tintGeometry}>
        <pointsMaterial
          vertexColors
          size={50}
          sizeAttenuation
          transparent
          opacity={0.12}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  )
}
