/**
 * Keeping live state out of the notes agents write.
 *
 * The prompt injects location, ship, hull, shield, fuel, cargo and wallet fresh
 * every 60 seconds, and tells the agent that reading is authoritative. An agent
 * that ALSO copies those figures into its TODO or memory has written something
 * guaranteed to be wrong on its next turn — it moved, or spent, or took damage.
 *
 * Morg'Thar spent 2026-09-05 doing exactly that. His turns opened
 * "CRITICAL TRIPLE MISMATCH — MY TODO SAYS Location: Blood Forge... CURRENT
 * STATE OVERRIDES EVERYTHING", he re-derived the discrepancy, rewrote the note
 * with the new location, and the next turn found the same contradiction. He
 * changed hull four times in a day and finished nothing. Four remedies failed —
 * nudges, a memory rewrite, a directive order, a clean boot — because every one
 * of them was a request, and the next note he wrote undid it.
 *
 * Ten of twelve agents were doing some of this; Morg wrote four categories.
 *
 * So the notes are filtered on the way in. A line that merely RECORDS a live
 * figure is dropped; anything that reasons about one is kept, because
 * "sell when cargo is over 400" is a plan and "Cargo: 118/120" is a stale fact
 * in waiting.
 */

/** Fields the briefing already injects — recording any of them is the bug.
 *
 *  Missions were the field this list was missing. `get_status` returns
 *  `missions.active[]` with every id, objective and progress figure, and
 *  Morg'Thar was ALSO writing "MISSIONS HELD (5/5 FULL)" and
 *  "Keeping the Drills Running [dac902c5] 0/1 <- ACTIVE" into his TODO. He
 *  completed that mission at 01:41 on 2026-09-06, read his own note two minutes
 *  later, and opened his turn with "MASSIVE DISCOVERY: MY TODO IS FROM A
 *  COMPLETELY DIFFERENT SESSION" — then posted a HALT to faction chat asking
 *  the Admiral for guidance he did not need. The note was four minutes old.
 *  Same shape as the location mismatch this module was built for. */
const INJECTED = 'location|position|status|docked at|system|poi|ship|active ship|hull|shield|fuel|cargo|wallet|credits|balance'
  + '|missions?|active missions?|missions held|mission slots|held missions'

/** A line that is purely a state readout: an optional bullet/heading/bold, a
 *  field name, a separator, then a value. Anchored so prose is untouched. */
const STATE_RECORD = new RegExp(
  `^[\\s>\\-*#\\d.)\\[\\]]*\\**\\s*(?:${INJECTED})\\s*\\**\\s*[:=]\\s*\\S`, 'i')

/** Kept even when it looks like a readout, because it expresses intent.
 *  Deleting an agent's own RULE is worse than leaving a stale fact: the fact
 *  gets overridden by the next injection, the rule is just gone. So this list
 *  errs wide — "Missions: never hold more than one I cannot finish" is a
 *  standing rule that the first version dropped for want of a trigger word. */
const REASONING = /\b(if|when|once|until|unless|should|must|need to|plan|then|because|so that|target|goal|threshold|below|above|at least|no more than|more than|fewer than|never|always|avoid|prefer|max|maximum|min|minimum|limit|cap|rule|only)\b/i

export interface NoteScrub { text: string; removed: string[] }

/**
 * Strip pure state readouts from a note an agent is about to save.
 * Returns the cleaned text and the lines removed, so the agent can be told what
 * happened rather than silently having its writing edited.
 */
export function scrubLiveState(content: string): NoteScrub {
  const removed: string[] = []
  const kept = content.split('\n').filter(line => {
    if (!STATE_RECORD.test(line)) return true
    if (REASONING.test(line)) return true          // a rule about state, not a snapshot
    removed.push(line.trim())
    return false
  })
  // Collapse the blank runs a removal leaves behind.
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, removed }
}

/** The note appended to the tool result when lines were dropped. */
export function scrubNotice(removed: string[]): string {
  const shown = removed.slice(0, 3).map(l => `"${l.slice(0, 60)}"`).join(', ')
  return ` ${removed.length} line(s) recording live state were dropped (${shown}${removed.length > 3 ? ', …' : ''}).`
    + ` Your location, ship, hull, fuel, cargo and wallet are injected into your prompt fresh every 60 seconds.`
    + ` Writing them here guarantees this note contradicts reality on your next turn — which is what a "state mismatch" is.`
    + ` Record decisions and durable facts; never a snapshot.`
}


/**
 * Memory holds durable knowledge; the TODO holds the live step list. Brian, 2026-09-10:
 * "memory should be historical knowledge relevant to the overall mission. To-Dos
 * should be tracked and, when completed, cleaned up after so many turns. What's in
 * memory should not also be duplicated in To-Dos." Morg'Thar's memory that evening
 * carried the same rule block twice, a turn-by-turn HOLD log, and the inventory the
 * prompt already injects — 3,064 chars of which ~600 were knowledge.
 */

/** Normalise a line for duplicate detection: case, bullets, markdown, punctuation, spacing. */
export function normalizeNoteLine(line: string): string {
  return line.toLowerCase()
    .replace(/[`*_~>#]/g, '')
    .replace(/^[\s\-\d.)\[\]x✅✔]+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** TODO lines that repeat a memory line are dropped — the memory copy is the one that lasts. */
export function dedupeTodoAgainstMemory(todo: string, memory: string): NoteScrub {
  const mem = new Set(memory.split('\n').map(normalizeNoteLine).filter(l => l.length >= 12))
  const removed: string[] = []
  const kept = todo.split('\n').filter(line => {
    const n = normalizeNoteLine(line)
    if (n.length >= 12 && mem.has(n)) { removed.push(line.trim()); return false }
    return true
  })
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed }
}

/** A TODO line the agent has marked finished. */
export const COMPLETED_LINE = /(✅|✔|\[x\]|\bDONE\b|\bCOMPLETED?\b|\bFINISHED\b|^\s*[-*]?\s*\**Verified\**\s*:)/i
/** How many further TODO writes a completed line survives before it is dropped. */
export const COMPLETED_LINE_TTL_WRITES = 3

const completedSeen = new Map<string, Map<string, number>>()

/** Forget the aging counters for one agent (on stop / clean boot). */
export function resetNoteHygiene(profileId: string): void { completedSeen.delete(profileId) }

/**
 * Age out completed TODO lines: a line marked done is kept for the next few writes
 * (so the agent sees its own progress) and then dropped, instead of accreting into
 * a permanent history that crowds out the live work.
 */
export function ageCompletedTodoLines(profileId: string, todo: string): NoteScrub {
  let seen = completedSeen.get(profileId)
  if (!seen) { seen = new Map(); completedSeen.set(profileId, seen) }
  const removed: string[] = []
  const present = new Set<string>()
  const kept = todo.split('\n').filter(line => {
    if (!COMPLETED_LINE.test(line)) return true
    if (REASONING_RULE.test(line)) return true         // "until X is DONE" is a plan, not a finished item
    const key = normalizeNoteLine(line)
    if (!key) return true
    present.add(key)
    const n = (seen!.get(key) ?? 0) + 1
    seen!.set(key, n)
    if (n > COMPLETED_LINE_TTL_WRITES) { removed.push(line.trim()); seen!.delete(key); return false }
    return true
  })
  for (const k of [...seen.keys()]) if (!present.has(k)) seen.delete(k)   // the agent already removed it
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed }
}
const REASONING_RULE = /\b(until|when|once|unless|if|before|after)\b/i

/** Turn-by-turn tracking and "next action" scaffolding belong in the TODO (or nowhere), never in memory. */
const MEMORY_TASK_LINE = /^\s*[-*#>]*\s*\**\s*(TURN\s+N(\+\d+)?|Turn\s+\d+|Next (action|tool call|escalation|step)s?|HOLD STATUS|Current status|Awaiting|WAITING for)\b/i
export function scrubMemoryTaskLines(memory: string): NoteScrub {
  const removed: string[] = []
  const kept = memory.split('\n').filter(line => {
    if (MEMORY_TASK_LINE.test(line)) { removed.push(line.trim()); return false }
    return true
  })
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed }
}

export function hygieneNotice(what: string, removed: string[]): string {
  const shown = removed.slice(0, 3).map(l => `"${l.slice(0, 60)}"`).join(', ')
  return ` ${removed.length} ${what} line(s) dropped (${shown}${removed.length > 3 ? ', …' : ''}).`
}
