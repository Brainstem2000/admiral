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
