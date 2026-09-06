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
