import { Database } from "bun:sqlite"

const db = new Database("data/admiral.db", { readonly: true })
const profiles: Record<string, string> = Object.fromEntries(
  db.query("SELECT id, name FROM profiles").all().map((r: any) => [r.id, r.name])
)

const since = new Date(Date.now() - 35 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
const rows: any[] = db.query("SELECT profile_id, type, summary, detail FROM log_entries WHERE timestamp > ? ORDER BY id DESC LIMIT 3000").all(since)

const agentActivity: Record<string, number> = {}
const toolCalls: Record<string, number> = {}
const errors: Array<{ name: string; text: string }> = []
const errorPatterns: Record<string, number> = {}
const cacheComplaints: Array<{ name: string; text: string }> = []

for (const r of rows) {
  const name = profiles[r.profile_id] || "?"
  const text = r.summary || ""
  const full = (r.detail || r.summary || "").toLowerCase()

  agentActivity[name] = (agentActivity[name] || 0) + 1

  if (r.type === "tool_call") {
    const m = text.match(/^game\(([^,)]+)/)
    const tool = m ? m[1] : text.split("(")[0]
    toolCalls[tool] = (toolCalls[tool] || 0) + 1
  }

  if (r.type === "tool_result" && full.includes("error:")) {
    const em = full.match(/error:\s*\[([^\]]+)\]/)
    const et = em ? em[1] : "other"
    const key = name + " > " + et
    errorPatterns[key] = (errorPatterns[key] || 0) + 1
    errors.push({ name, text: (r.detail || text).substring(0, 250) })
  }

  if (r.type === "llm_thought" && full.includes("cache") && (full.includes("stale") || full.includes("old") || full.includes("again") || full.includes("doesn"))) {
    cacheComplaints.push({ name, text: text.substring(0, 250) })
  }
}

console.log("=== AGENT ACTIVITY (last ~30 min) ===")
for (const [n, c] of Object.entries(agentActivity).sort((a: any, b: any) => b[1] - a[1])) console.log(`  ${n}: ${c}`)

console.log("\n=== TOP 20 TOOL CALLS ===")
for (const [t, c] of Object.entries(toolCalls).sort((a: any, b: any) => b[1] - a[1]).slice(0, 20)) console.log(`  ${t}: ${c}`)

console.log(`\n=== ERRORS (${errors.length} total, showing unique) ===`)
const seen = new Set<string>()
for (const e of errors.slice(0, 25)) {
  const s = e.text.substring(0, 150)
  if (!seen.has(e.name + s)) { seen.add(e.name + s); console.log(`  [${e.name}] ${s}`) }
}

console.log("\n=== REPEATED ERROR PATTERNS ===")
for (const [k, c] of Object.entries(errorPatterns).sort((a: any, b: any) => b[1] - a[1]).slice(0, 15)) {
  if (c > 1) console.log(`  ${k}: ${c}x`)
}

console.log(`\n=== CACHE COMPLAINTS (${cacheComplaints.length}) ===`)
for (const e of cacheComplaints.slice(0, 10)) console.log(`  [${e.name}] ${e.text}`)

// Token analytics
console.log("\n=== TOKEN USAGE (from API) ===")
try {
  const resp = await fetch("http://127.0.0.1:3031/api/analytics/tokens")
  const tokenData: any = await resp.json()
  for (const [pid, stats] of Object.entries(tokenData.byProfile || {}) as any) {
    const name = profiles[pid] || pid
    console.log(`  ${name}: $${stats.cost?.toFixed(3) || '?'} (${stats.calls || '?'} calls, ${stats.inputTokens || '?'} in / ${stats.outputTokens || '?'} out)`)
  }
} catch { console.log("  (could not fetch token data)") }
