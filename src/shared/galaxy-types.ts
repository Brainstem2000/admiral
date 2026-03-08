export interface GalaxySystem {
  system_id: string
  name: string
  position: { x: number; y: number }
  connections: string[]
  empire?: string
  online: number
  poi_count: number
  visited: boolean
}

export interface GalaxyMapData {
  systems: GalaxySystem[]
  total_count: number
  fetched_at: string
  fetched_by: string
}

export const EMPIRE_COLORS: Record<string, string> = {
  solarian: '--smui-yellow',
  crimson: '--smui-red',
  voidborn: '--smui-purple',
  nebula: '--smui-frost-2',
  outerrim: '--smui-orange',
}

export const AGENT_COLORS = [
  '--smui-frost-3',
  '--smui-green',
  '--smui-orange',
  '--smui-purple',
  '--smui-red',
]
