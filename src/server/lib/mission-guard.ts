/**
 * Refusing rescue missions from the Wexler group.
 *
 * A Wexler rescue is unpaid charity. The 2026-08-28 rescue of Wexler HHC-A4 left
 * a 3,000cr debt that has never been paid, and the fleet ruling since is that
 * they are not repeated. On 2026-09-05 Morg'Thar accepted "Distress: Wexler
 * EQC-0M in Fumalsamakah" — 25 piloting XP, no credits, into lawless space — was
 * told in a nudge to drop it, acknowledged the instruction in his own reasoning
 * ("The Admiral is explicit: Drop the Wexler distress call"), and then routed
 * somewhere else without dropping it. Prose had been read and skipped, so the
 * rule is enforced here instead.
 *
 * Blocking by mission_id alone is not possible — the ids are opaque hashes. But
 * an agent always reads the board before accepting from it, so titles are cached
 * from those reads and the accept is matched against the cache. A mission that
 * was never seen on a board cannot be matched, which is why acceptSideEffect()
 * exists as the backstop: it reads the title out of the game's own accept
 * response and hands back an abandon instruction.
 */

/** mission_id -> title, harvested from board reads. Bounded so it cannot grow. */
const titles = new Map<string, string>()
const MAX_TITLES = 4_000

/** The rule: a rescue/distress mission naming the Wexler group. */
const WEXLER = /\bwexler\b/i
const RESCUE = /\b(distress|mayday|rescue|stranded|salvage the crew)\b/i

export function isRefusedMissionTitle(title: string): boolean {
  return WEXLER.test(title) && RESCUE.test(title)
}

/**
 * Harvest "--- Title [id] (type, difficulty N) ---" headers out of any mission
 * listing so a later accept can be matched by id.
 */
export function noteMissionTitles(text: string): void {
  if (!text) return
  for (const m of text.matchAll(/---\s*([^\[\n]{3,120}?)\s*\[([a-z0-9_~-]{4,80})\]/gi)) {
    if (titles.size >= MAX_TITLES) titles.clear()   // cheap bound; boards get re-read
    titles.set(m[2], m[1].trim())
  }
}

/** The cached title for a mission id, if we have seen it on a board. */
export function knownTitle(id: string): string | undefined {
  return titles.get(id)
}

/** Refusal text for an accept the fleet does not allow, or null to permit it. */
export function refuseAccept(args: Record<string, unknown> | undefined): string | null {
  const id = String(args?.mission_id ?? args?.id ?? args?.template_id ?? '')
  if (!id) return null
  const title = titles.get(id)
  if (!title || !isRefusedMissionTitle(title)) return null
  return refusalText(title)
}

/**
 * After an accept the guard could not pre-empt, read the title out of the game's
 * own response. Returns the mission id to abandon, or null.
 */
export function acceptSideEffect(resultText: string, args: Record<string, unknown> | undefined): { id: string; title: string } | null {
  if (!resultText || !isRefusedMissionTitle(resultText)) return null
  const m = /\[([a-z0-9_~-]{4,80})\]/i.exec(resultText)
  const id = m?.[1] ?? String(args?.mission_id ?? args?.id ?? '')
  if (!id) return null
  const t = /---\s*([^\[\n]{3,120}?)\s*\[/.exec(resultText)
  return { id, title: t?.[1]?.trim() ?? 'Wexler distress call' }
}

export function refusalText(title: string): string {
  return (
    `BLOCKED by Admiral doctrine: "${title}" is a Wexler rescue, and the fleet does not take them. ` +
    `The 2026-08-28 rescue of Wexler HHC-A4 left a 3,000cr debt that has never been paid, so these ` +
    `are unpaid charity — they typically pay XP and no credits, and they route into lawless space. ` +
    `Do not accept this or any other Wexler distress call, however it is worded.\n\n` +
    `Take a paying contract instead: a delivery or trade mission from a crimson station board builds ` +
    `Crimson reputation as well as credits, and the reward line tells you which.`
  )
}

/**
 * Abandon-churn guard.
 *
 * Dropping one contract is a judgement call — Morg'Thar was right to drop a
 * delivery whose pickup was 24 hops away. Dropping eight in three hours while
 * completing none is not judgement, it is a loop: accept, re-plan, abandon,
 * re-route. He did exactly that on 2026-09-05 and earned nothing, his Crimson
 * reputation still sitting on its baseline of 20 hours after being told to raise
 * it.
 *
 * Prose did not hold it and neither did four nudges, so the fourth abandon
 * inside an hour is refused. The agent is told to finish something first. This
 * is a floor on commitment, not a ban: the window rolls, so completing work or
 * simply waiting restores the ability to drop a genuinely bad contract.
 */
const abandons = new Map<string, number[]>()
/** Titles the fleet refuses outright are ALWAYS droppable — the churn guard must
 *  never trap an agent inside a mission doctrine forbids. Distress calls are
 *  AUTO-ASSIGNED to nearby ships (per the game's own docs), so `refuseAccept`
 *  never sees them: on 2026-09-06 Cass Margin and Vera Lane were both handed
 *  "Distress: Wexler R1P-JL in Rasalgethi" without either calling
 *  accept_mission. Blocking the abandon as well would be the worst of both. */
export function isAlwaysDroppable(title: string): boolean {
  return isRefusedMissionTitle(title)
}

const ABANDON_WINDOW_MS = 60 * 60_000
const ABANDON_LIMIT = 3

export function noteAbandon(profileId: string, now = Date.now()): void {
  const arr = (abandons.get(profileId) ?? []).filter(t => now - t < ABANDON_WINDOW_MS)
  arr.push(now)
  abandons.set(profileId, arr)
}

export function recentAbandons(profileId: string, now = Date.now()): number {
  return (abandons.get(profileId) ?? []).filter(t => now - t < ABANDON_WINDOW_MS).length
}

/** Refusal text when an agent is churning through contracts, or null to allow. */
export function refuseAbandon(profileId: string, now = Date.now(), title?: string): string | null {
  // Never trap an agent inside a mission doctrine forbids. Wexler distress
  // calls are auto-assigned, so an agent can be handed one while already at the
  // churn limit — and then be blocked from obeying the order to drop it.
  if (title && isAlwaysDroppable(title)) return null
  const n = recentAbandons(profileId, now)
  if (n < ABANDON_LIMIT) return null
  return (
    `BLOCKED by Admiral doctrine: you have abandoned ${n} missions in the last hour and completed none. ` +
    `Dropping one bad contract is judgement; dropping every contract is a loop — you accept, re-plan, ` +
    `abandon and re-route, and finish nothing.\n\n` +
    `FINISH A CONTRACT BEFORE DROPPING ANOTHER. Pick the one you are closest to completing, fly its ` +
    `route without re-evaluating alternatives, and complete it. If it is genuinely impossible — the ` +
    `target does not exist, or the route leaves safe space — say so in faction chat with the reason, ` +
    `and work the one you can finish instead. This limit lifts as the hour rolls forward.`
  )
}

/** Test seam: forget a profile's abandon history. */
export function resetAbandons(profileId?: string): void {
  if (profileId) abandons.delete(profileId); else abandons.clear()
}
