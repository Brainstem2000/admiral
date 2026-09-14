/**
 * Bring the fleet back up after a restart.
 *
 * `autoconnect` was stored, defaulted to true, persisted through create/update
 * and shown in the UI — and nothing on the server ever read it. The flag was
 * decorative. Observed live on 2026-09-14: restarting `bun run dev` dropped all
 * four working agents (Ledger Voss, CyberSpock, Morg'Thar, Cass Margin) and
 * minutes later none had returned, despite every profile having autoconnect set.
 * Each had to be revived by hand through POST /api/profiles/:id/connect.
 *
 * The fleet runs unattended for hours, so that failure mode is not "a restart is
 * inconvenient" — it is every agent silently parked until a human happens to
 * look. A crash has exactly the same shape.
 */
import type { Profile } from '../../shared/types'

/** How long to wait between two agents' connections during the boot pass. */
export const AUTOCONNECT_STAGGER_MS = 8_000

/** How long after listen() the first connection is attempted. */
export const AUTOCONNECT_START_DELAY_MS = 5_000

/** Preference key holding the ids that had a live LLM loop at the last snapshot. */
export const RUNNING_ROSTER_KEY = 'autoconnect_running_roster'

/**
 * The profiles a boot pass should bring up, in the order it should bring them.
 *
 * `runningBefore` is the ROSTER THAT WAS ACTUALLY WORKING, and it is required.
 * Selecting on enabled+autoconnect alone is not enough and would have caused
 * real harm here: on 2026-09-14 eleven of this fleet's profiles matched those
 * two flags while only FOUR were meant to be running. The other seven were
 * parked by disconnecting them, which is in-memory state a restart forgets. A
 * pass built on the flags alone would have woken all eleven — spending tokens,
 * taking game actions on seven agents nobody asked to run, and breaching the
 * "never more than TWO agents on the local model" invariant in the process.
 *
 * So `enabled` and `autoconnect` say who MAY come back, and the running roster
 * says who SHOULD. An empty or missing roster connects nobody: the snapshot
 * rewrites it within two minutes, so the cost of not knowing is one restart
 * where the fleet must be started by hand — which is the status quo, not a
 * regression, and is strictly better than guessing wrong in the loud direction.
 *
 * Kept pure and separate from the connecting so the selection rule can be tested
 * without opening a game connection or starting an LLM loop.
 *
 * Four further exclusions, each for its own reason:
 *  - `enabled` false — the profile is parked on purpose; the scheduler, the
 *    event watcher and the offline wallet sweep all already skip these.
 *  - `autoconnect` false — the operator said not to.
 *  - provider missing or 'manual' — there is no model to drive a loop, and the
 *    connect route refuses to call startLLM for these too.
 *  - model missing — same; connecting would produce a game session with nothing
 *    running it, which reads as "connected" in the UI and does no work.
 *
 * Order follows listProfiles() (sort_order, then created_at) so the fleet comes
 * back in the order the operator arranged it rather than an arbitrary one.
 */
export function autoconnectCandidates(profiles: Profile[], runningBefore: readonly string[]): Profile[] {
  const was = new Set(runningBefore)
  return profiles.filter(p =>
    was.has(p.id)
    && p.enabled
    && p.autoconnect
    && !!p.provider
    && p.provider !== 'manual'
    && !!p.model,
  )
}

/** Parse the persisted roster. Anything unreadable means "we do not know". */
export function parseRunningRoster(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The pieces of the world this pass touches, injected so it can be tested. */
export interface AutoconnectDeps {
  listProfiles: () => Profile[]
  /** Ids that had a live LLM loop when the state was last snapshotted. */
  runningBefore: () => readonly string[]
  connect: (profileId: string) => Promise<unknown>
  startLLM: (profileId: string) => Promise<void>
  isStopRequested: (profileId: string) => boolean
  log: (profileId: string, level: string, message: string) => void
  /** Injected so tests do not wait real seconds. */
  sleep?: (ms: number) => Promise<void>
  staggerMs?: number
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Connect every autoconnect profile, one at a time.
 *
 * STAGGERED, not parallel. Each agent opens a game connection and starts an LLM
 * loop; firing four at once means four simultaneous model calls, and two of this
 * fleet's profiles share a single local model that saturates at two concurrent
 * loops (CLAUDE.md: "never more than TWO agents on the local model"). This pass
 * only restores what was already configured, so it cannot breach that cap on its
 * own — the stagger is about not stampeding the model and the game API in the
 * same second.
 *
 * ONE FAILURE NEVER STOPS THE PASS. A bad credential or an unreachable game
 * server on one profile must not leave the other three parked, which is the
 * whole problem this exists to fix.
 */
export async function runAutoconnect(deps: AutoconnectDeps): Promise<{ connected: string[]; failed: string[]; skipped: string[] }> {
  const out = { connected: [] as string[], failed: [] as string[], skipped: [] as string[] }
  const sleep = deps.sleep ?? realSleep
  const stagger = deps.staggerMs ?? AUTOCONNECT_STAGGER_MS

  let candidates: Profile[]
  try {
    candidates = autoconnectCandidates(deps.listProfiles(), deps.runningBefore())
  } catch {
    return out                               // no profile list, nothing to do
  }
  if (candidates.length === 0) return out

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i]
    // Re-checked per profile rather than once up front: the pass spans minutes
    // and an operator can stop an agent while it is still running.
    if (deps.isStopRequested(p.id)) { out.skipped.push(p.id); continue }
    if (i > 0) await sleep(stagger)
    try {
      await deps.connect(p.id)
      await deps.startLLM(p.id)
      out.connected.push(p.id)
      deps.log(p.id, 'system', 'Autoconnected on server start')
    } catch (err) {
      out.failed.push(p.id)
      deps.log(p.id, 'error', `Autoconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}
