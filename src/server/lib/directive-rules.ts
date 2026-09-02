/**
 * Small, pure readers of an agent's directive text — kept free of db/game
 * imports so they can be unit-tested and reused by briefings.
 */

/** Phrases that mark a line as a prohibition on a place. Deliberately narrow:
 *  "avoid" alone is not here ("avoid fuel cells above 60cr" names no system). */
const FORBID_RX = /never enter|no-go|do not enter|don't enter|forbidden|off-limits|stay out of|shoots you|never go/i

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when some line of the directive both names the system and forbids it —
 * e.g. "- Alhena / Voss Redoubt: reputation -10, the station shoots you. Never enter."
 * Matching is per line so a prohibition elsewhere in the document cannot attach
 * to an unrelated system mentioned two paragraphs later.
 */
export function directiveForbidsSystem(directive: string | null | undefined, systemId: string, systemName?: string | null): boolean {
  if (!directive) return false
  const names = [systemId, systemName ?? '']
    .map((s) => s.toLowerCase().replace(/_/g, ' ').trim())
    .filter((s) => s.length > 1)
  if (names.length === 0) return false
  const rxs = names.map((n) => new RegExp(`\\b${escapeRx(n)}\\b`))
  for (const raw of directive.split('\n')) {
    const line = raw.toLowerCase().replace(/_/g, ' ')
    if (!FORBID_RX.test(line)) continue
    if (rxs.some((rx) => rx.test(line))) return true
  }
  return false
}
