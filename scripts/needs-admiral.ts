/**
 * needs-admiral — surface agents that are genuinely blocked and asking the Admiral.
 *
 *   bun scripts/needs-admiral.ts            # watch mode: one stdout line per NEW request
 *   bun scripts/needs-admiral.ts --catchup  # what came in while nobody was watching, then exit
 *   bun scripts/needs-admiral.ts --ack      # mark everything seen (after you have acted)
 *
 * Detection persists to data/needs-admiral.jsonl, so it survives a session restart, a server
 * restart, and a machine reboot. Watch mode is session-scoped by nature — nothing can notify a
 * Claude session that does not exist — but --catchup replays what was missed, which is the part
 * that actually matters.
 *
 * Why this exists: the Admiral stopped an over-noisy monitor, and Morg'Thar then sat halted for
 * eight minutes asking for pricing guidance with nobody watching. The signal must be narrow
 * enough to stay switched on.
 *
 * Filters, each added after a real false positive:
 *   RELAYED — other players' MAYDAY traffic relayed into our agent's log. Someone else stranded
 *             is not our agent asking us anything. (An unescaped [CHAT] here is a character
 *             class that silently matches nearly everything — it once suppressed all alerts.)
 *   BENIGN  — "integrity check passed", "batch progressing": working, not blocked.
 *   dedupe  — agents repost the same HALT every turn.
 */
import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'

const DB = 'data/admiral.db'
const LOG = 'data/needs-admiral.jsonl'
const ACK = 'data/needs-admiral.ack'
const POLL_MS = 20_000

const ASKING = /awaiting admiral|need admiral|admiral guidance|requesting admiral|pending admiral|awaiting guidance|awaiting your|need your (guidance|input|decision|approval)|NEED:|permission to|please advise|blocked on (the )?admiral/i
const STUCK = /cannot proceed|no way to proceed|\bstuck\b|unable to (continue|proceed)|out of (fuel|options)/i
const BENIGN = /check passed|confirmed intact|integrity check|progressing|continue\w*\s+automatically|unchanged|no new|routine/i
const RELAYED = /\[CHAT_MESSAGE\]|\[CHAT\]|MAYDAY|Notifications:|channel"?\s*:\s*"?emergency/i
// "NEED: <AgentName> — ..." is one agent asking another, not asking us. Route those only if
// they stall; they are not the Admiral's inbox.
const PEER_TO_PEER = /NEED:\s*(Morg|Nova|CyberSpock|CyberSapper|Bob|Cass|Grit|Juno|Ledger|Rook|Vera|Zibal)/i
// The Admiral's OWN directive is echoed verbatim into the log as a `system` row when a turn is
// restarted, so any order containing "ask the Admiral" or "NEED:" re-triggers this watcher on
// the very text that answers it. Self-inflicted noise, and noise is what got the last monitor
// switched off. Match the echo prefix, not the directive body.
const SELF_ECHO = /^\s*(Directive updated|Nudge delivered|Fleet order sent|Memory updated|TODO updated)/i

const db = new Database(DB, { readonly: true })
const names: Record<string, string> = Object.fromEntries(
  (db.query('SELECT id,name FROM profiles').all() as Array<{ id: string; name: string }>)
    .map((p) => [p.id, p.name.split(' ')[0]]),
)

interface Hit { id: number; ts: string; agent: string; text: string }

/**
 * Pages to the end rather than taking one LIMITed slice. A single `LIMIT 1000` from id 0 returns
 * the OLDEST thousand rows — yesterday's — so catchup silently reported "nothing outstanding"
 * while a real backlog sat further down the table.
 */
function scan(sinceId: number, pages = Infinity): { hits: Hit[]; maxId: number } {
  const hits: Hit[] = []
  let cursor = sinceId
  let page = 0
  for (;;) {
    const rows = db.query(
      `SELECT id, profile_id, timestamp, summary FROM log_entries
       WHERE id > ? AND summary IS NOT NULL ORDER BY id ASC LIMIT 1000`,
    ).all(cursor) as Array<{ id: number; profile_id: string; timestamp: string; summary: string }>
    if (!rows.length) break
    for (const r of rows) {
      cursor = Math.max(cursor, r.id)
      const s = r.summary.replace(/\s+/g, ' ')
      if (RELAYED.test(s) || BENIGN.test(s) || PEER_TO_PEER.test(s) || SELF_ECHO.test(s)) continue
      if (!ASKING.test(s) && !STUCK.test(s)) continue
      hits.push({ id: r.id, ts: r.timestamp, agent: names[r.profile_id] ?? '?', text: s.slice(0, 220) })
    }
    if (rows.length < 1000 || ++page >= pages) break
  }
  return { hits, maxId: cursor }
}

/**
 * Highest log id already acted on. With no ack file, fall back to roughly the last two hours
 * rather than id 0 — a first run should show what is outstanding now, not replay a day of
 * resolved requests.
 */
function readAck(): number {
  if (existsSync(ACK)) {
    const n = Number(readFileSync(ACK, 'utf-8').trim())
    if (n) return n
  }
  const row = db.query(
    `SELECT MIN(id) m FROM log_entries WHERE timestamp > datetime('now','-2 hours')`,
  ).get() as { m: number | null }
  return (row?.m ?? 1) - 1
}

const args = new Set(process.argv.slice(2))
const nowMax = (db.query('SELECT MAX(id) m FROM log_entries').get() as { m: number }).m ?? 0

if (args.has('--ack')) {
  writeFileSync(ACK, String(nowMax))
  console.log(`acknowledged up to log id ${nowMax}`)
} else if (args.has('--catchup')) {
  // Replay what arrived while nothing was watching. Dedupe by agent + first 70 chars, because
  // an agent reposts the same HALT every turn and the backlog is mostly repeats.
  const { hits } = scan(readAck())
  const seen = new Set<string>()
  const fresh = hits.filter((h) => {
    const k = `${h.agent}|${h.text.slice(0, 70)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!fresh.length) console.log('nothing outstanding — no agent is waiting on the Admiral.')
  for (const h of fresh) console.log(`NEEDS-ADMIRAL ${h.ts} ${h.agent}: ${h.text}`)
  if (fresh.length) console.log(`\n${fresh.length} outstanding. Act on them, then: bun scripts/needs-admiral.ts --ack`)
} else {
  let lastId = nowMax
  const seen = new Set<string>()
  setInterval(() => {
    const { hits, maxId } = scan(lastId)
    lastId = maxId
    for (const h of hits) {
      const k = `${h.agent}|${h.text.slice(0, 70)}`
      if (seen.has(k)) continue
      seen.add(k)
      appendFileSync(LOG, JSON.stringify(h) + '\n')   // durable: survives this process
      console.log(`NEEDS-ADMIRAL ${h.ts.slice(11)} ${h.agent}: ${h.text}`)
    }
  }, POLL_MS)
  setInterval(() => {}, 1 << 30) // hold the event loop open; an interval alone has exited early here
}
