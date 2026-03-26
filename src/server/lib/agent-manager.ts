import { Agent } from './agent'
import { getProfile, addLogEntry } from './db'

const BACKOFF_BASE = 5_000      // 5 seconds
const BACKOFF_MAX = 5 * 60_000  // 5 minutes
const BACKOFF_RESET = 60_000    // Reset backoff after 1 min of successful running

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
  private stopRequested = new Set<string>()
  private backoff = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>()

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

    this.stopRequested.delete(profileId)
    this.resetBackoff(profileId)

    // Run in background (don't await)
    const loopStarted = Date.now()
    agent.startLLMLoop().then(() => {
      this.handleLoopExit(profileId, loopStarted)
    }).catch(() => {
      this.handleLoopExit(profileId, loopStarted)
    })
  }

  private handleLoopExit(profileId: string, loopStarted: number): void {
    // If stop was explicitly requested (disconnect), don't restart
    if (this.stopRequested.has(profileId)) {
      this.resetBackoff(profileId)
      return
    }

    // If session expired (duration limit), don't restart
    const agent = this.agents.get(profileId)
    if (agent?.sessionExpired) {
      this.resetBackoff(profileId)
      return
    }

    // Check if profile still wants to be running
    const profile = getProfile(profileId)
    if (!profile || !profile.enabled || !profile.provider || profile.provider === 'manual' || !profile.model) {
      return
    }

    // If the loop ran for a while, reset backoff (it was working fine)
    const ranFor = Date.now() - loopStarted
    const bo = this.backoff.get(profileId) || { attempts: 0, timer: null }
    if (ranFor > BACKOFF_RESET) {
      bo.attempts = 0
    }

    bo.attempts++
    const delay = Math.min(BACKOFF_BASE * Math.pow(2, bo.attempts - 1), BACKOFF_MAX)
    this.backoff.set(profileId, bo)

    const delaySec = Math.round(delay / 1000)
    addLogEntry(profileId, 'system', `Agent loop exited unexpectedly. Auto-restarting in ${delaySec}s (attempt ${bo.attempts})`)

    bo.timer = setTimeout(async () => {
      if (this.stopRequested.has(profileId)) return
      try {
        // Reconnect if needed
        let agent = this.agents.get(profileId)
        if (!agent || !agent.isConnected) {
          agent = new Agent(profileId)
          this.agents.set(profileId, agent)
          await agent.connect()
        }
        if (!agent.isRunning) {
          addLogEntry(profileId, 'system', `Auto-restart: reconnected, resuming LLM loop`)
          const restartedAt = Date.now()
          agent.startLLMLoop().then(() => {
            this.handleLoopExit(profileId, restartedAt)
          }).catch(() => {
            this.handleLoopExit(profileId, restartedAt)
          })
        }
      } catch (err) {
        addLogEntry(profileId, 'error', `Auto-restart failed: ${err instanceof Error ? err.message : String(err)}`)
        // Retry with next backoff
        this.handleLoopExit(profileId, Date.now())
      }
    }, delay)
  }

  private resetBackoff(profileId: string): void {
    const bo = this.backoff.get(profileId)
    if (bo?.timer) clearTimeout(bo.timer)
    this.backoff.delete(profileId)
  }

  async disconnect(profileId: string): Promise<void> {
    this.stopRequested.add(profileId)
    this.resetBackoff(profileId)

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

  safeDock(profileId: string): boolean {
    const agent = this.agents.get(profileId)
    if (!agent?.isRunning) return false
    agent.pendingSafeDock = true
    agent.safeDockTurnsRemaining = 15
    this.stopRequested.add(profileId)  // Prevent auto-restart after loop exits
    this.resetBackoff(profileId)
    agent.injectNudge('URGENT: Dock at the nearest safe station immediately. This is a shutdown order from your human operator. Dock and do nothing else after docking.')
    return true
  }

  getStatus(profileId: string): { connected: boolean; running: boolean; activity: string; gameState: SlimGameState; safeDocking: boolean } {
    const agent = this.agents.get(profileId)
    return {
      connected: agent?.isConnected ?? false,
      running: agent?.isRunning ?? false,
      activity: agent?.activity ?? 'idle',
      gameState: slimGameState(agent?.gameState ?? null),
      safeDocking: agent?.pendingSafeDock ?? false,
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
