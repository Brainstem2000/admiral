import { Agent } from './agent'

type SlimGameState = {
  credits?: unknown
  system?: unknown
  poi?: unknown
  empire?: unknown
  faction?: unknown
  faction_tag?: unknown
  faction_id?: unknown
  ship?: {
    class?: unknown
    hull: string
    shield: string
    fuel: string
    cargo: string
    cpu: string
    power: string
    cargoItems?: string[]
  }
  modules?: { name?: unknown; wear?: unknown; ammo?: string }[]
} | null

function slimGameState(raw: Record<string, unknown> | null): SlimGameState {
  if (!raw) return null
  const gs = raw as Record<string, Record<string, unknown> & { cargo?: unknown[]; current_ammo?: unknown; magazine_size?: unknown }>
  const player = gs.player as Record<string, unknown> | undefined
  const location = gs.location as Record<string, unknown> | undefined
  const ship = gs.ship as Record<string, unknown> | undefined
  const cargo = gs.cargo as Array<Record<string, unknown>> | undefined
  const modules = gs.modules as Array<Record<string, unknown>> | undefined
  // get_status returns faction_id + clan_tag; faction_info enrichment adds _faction_name/_faction_tag
  const factionId = player?.faction_id as string | undefined
  const factionName = player?._faction_name as string | undefined
  const factionTag = player?._faction_tag as string | undefined
  const clanTag = player?.clan_tag as string | undefined

  return {
    credits: player?.credits,
    system: player?.current_system || location?.system_name || location?.system_id,
    poi: player?.current_poi || location?.poi_name || location?.poi_id,
    empire: player?.empire,
    faction: factionName || null,
    faction_tag: factionTag || clanTag || null,
    faction_id: factionId || null,
    ship: ship ? {
      class: ship.class_id || ship.class_name,
      hull: `${ship.hull ?? 0}/${ship.max_hull ?? 0}`,
      shield: `${ship.shield ?? 0}/${ship.max_shield ?? 0}`,
      fuel: `${ship.fuel ?? 0}/${ship.max_fuel ?? 0}`,
      cargo: `${ship.cargo_used ?? 0}/${ship.cargo_capacity ?? 0}`,
      cpu: `${ship.cpu_used ?? 0}/${ship.cpu_capacity ?? 0}`,
      power: `${ship.power_used ?? 0}/${ship.power_capacity ?? 0}`,
      cargoItems: (cargo || ship.cargo as Array<Record<string, unknown>> | undefined)
        ?.map(c => `${c.item_id} x${c.quantity}`),
    } : undefined,
    modules: modules?.map(m => ({
      name: m.name,
      wear: m.wear_status,
      ammo: m.current_ammo !== undefined ? `${m.current_ammo}/${m.magazine_size}` : undefined,
    })),
  }
}

class AgentManager {
  private agents = new Map<string, Agent>()

  getAgent(profileId: string): Agent | undefined {
    return this.agents.get(profileId)
  }

  async connect(profileId: string): Promise<Agent> {
    // If already connected, return existing
    let agent = this.agents.get(profileId)
    if (agent?.isConnected) return agent

    // Create new agent
    agent = new Agent(profileId)
    this.agents.set(profileId, agent)

    await agent.connect()
    return agent
  }

  async startLLM(profileId: string): Promise<void> {
    const agent = this.agents.get(profileId)
    if (!agent) throw new Error('Agent not connected')
    if (agent.isRunning) return

    // Run in background (don't await)
    agent.startLLMLoop().catch(() => {
      // Loop ended (normal or error) -- agent handles logging
    })
  }

  async disconnect(profileId: string): Promise<void> {
    const agent = this.agents.get(profileId)
    if (!agent) return

    await agent.stop()
    this.agents.delete(profileId)
  }

  restartTurn(profileId: string): void {
    const agent = this.agents.get(profileId)
    if (agent?.isRunning) {
      agent.restartTurn()
    }
  }

  nudge(profileId: string, message: string): void {
    const agent = this.agents.get(profileId)
    if (agent?.isRunning) {
      agent.injectNudge(message)
    }
  }

  getStatus(profileId: string): { connected: boolean; running: boolean; activity: string; gameState: SlimGameState } {
    const agent = this.agents.get(profileId)
    return {
      connected: agent?.isConnected ?? false,
      running: agent?.isRunning ?? false,
      activity: agent?.activity ?? 'idle',
      gameState: slimGameState(agent?.gameState ?? null),
    }
  }

  listActive(): string[] {
    return Array.from(this.agents.entries())
      .filter(([, agent]) => agent.isConnected)
      .map(([id]) => id)
  }

  getAllAgents(): Map<string, Agent> {
    return this.agents
  }
}

export const agentManager = new AgentManager()
