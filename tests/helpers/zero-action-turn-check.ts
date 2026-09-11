/** Subprocess helper for zero-action-turn-guard.test.ts — isolated DB (chdir before import).
 *  The model is a fake OpenAI-compatible server on a loopback port: bun:test's mock.module
 *  does not apply outside `bun test`, and this way pi-ai's real request path is exercised. */
const workspace = process.argv[2]
if (!workspace) throw new Error('temporary workspace path is required')
process.chdir(workspace)
const fs = await import('node:fs'); const path = await import('node:path')
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true })
const { getDb, createProfile } = await import('../../src/server/lib/db')
const { runAgentTurn, MIN_EXPECTED_REQUEST_TOKENS, MAX_NO_TOOL_ROUNDS_PER_TURN } = await import('../../src/server/lib/loop')
const db = getDb()
if (!fs.realpathSync((db as any).filename).startsWith(fs.realpathSync(workspace))) throw new Error('db opened outside the temp workspace')

// A request that falls into completeWithRetry's backoff ladder would take minutes; fail fast instead,
// and say what the loop logged last so the failure is diagnosable from the test output.
const trace: string[] = []
const recent: string[] = []
const guard = setTimeout(() => {
  console.log('__RESULT__' + JSON.stringify({ error: 'helper timed out — a request fell into the retry ladder?', trace, recent: recent.slice(-6) }))
  process.exit(1)
}, 60_000)

const base = { username: '', password: '', empire: 'solarian', player_id: '', provider: 'custom', model: '', planner_provider: null, planner_model: null, planning_interval: null,
  codex_executor_enabled: false, codex_executor_model: '', codex_planner_enabled: false, codex_planner_model: '', directive: '', todo: '', memory: '', connection_mode: 'http_v2',
  server_url: '', autoconnect: false, enabled: true, context_budget: null, sort_order: 0, group_name: '' }

// --- fake LLM: streams scripted replies in the OpenAI chat-completions wire format ---
type Reply = { text: string } | { tool: string; args: Record<string, unknown> }
let script: Reply[] = []
let requests = 0
const sse = (chunks: object[]) =>
  chunks.map(c => `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', ...c })}\n\n`).join('') + 'data: [DONE]\n\n'
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
    requests++
    const reply = script.shift() ?? { text: '(script exhausted)' }
    trace.push('tool' in reply ? `tool:${reply.tool}` : `text:${reply.text.slice(0, 30)}`)
    const chunks: object[] = 'tool' in reply
      ? [{ choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }] },
         { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      : [{ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] },
         { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    // 40 of the 50 prompt tokens served from cache — the shape a real turn has, where the
    // summary's "input" figure is the uncached remainder (see the llm_call summary line).
    chunks.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_tokens_details: { cached_tokens: 40 } } })
    return new Response(sse(chunks), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
// Not a local provider on purpose: those get the 300s timeout and the 3.5 chars/token estimate.
const model = {
  id: 'fake-model', name: 'fake-model', api: 'openai-completions', provider: 'fake-test',
  baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
} as any

function connection() {
  return {
    mode: 'http_v2', isConnected: () => true, supportsNotifications: () => false, onNotification: () => {},
    getLocalState: () => null,
    execute: async (cmd: string) => ({ result: { action: cmd, ok: true } }),
  } as any
}
const game = (command: string): Reply => ({ tool: 'game', args: { command } })
const text = (t: string): Reply => ({ text: t })

let n = 0
async function turn(replies: Reply[], opts: { systemPrompt?: string; messages?: any[]; expectSystemPrompt?: boolean } = {}) {
  const id = `p-zero-${++n}`
  createProfile({ ...base, id, name: `Zero ${n}`, username: `Zero ${n}` } as any)
  script = [...replies]
  const before = requests
  const logs: Array<{ type: string; summary: string; detail?: string }> = []
  const context = {
    systemPrompt: opts.systemPrompt ?? 'sys',
    messages: opts.messages ?? [{ role: 'user', content: 'Begin your mission: hold at War Citadel and await orders.', timestamp: Date.now() }],
    tools: [],
  } as any
  const outcome = await runAgentTurn(
    model, context, connection(), id, `Zero ${n}`,
    ((type: string, summary: string, detail?: string) => { logs.push({ type, summary, detail }); recent.push(`${type}: ${summary.slice(0, 160)}`) }) as any,
    { value: '' } as any, { value: '' } as any,
    // pi-ai's OpenAI client throws before sending when the key is empty, which lands in the retry ladder.
    { maxToolRounds: 4, llmTimeoutMs: 10_000, apiKey: 'test', expectSystemPrompt: opts.expectSystemPrompt },
  )
  return {
    outcome,
    calls: requests - before,
    system: logs.filter(l => l.type === 'system').map(l => l.summary),
    llmCalls: logs.filter(l => l.type === 'llm_call').map(l => l.summary),
    retryNotes: context.messages.filter((m: any) => m.role === 'user' && /text, not an action/.test(String(m.content))).length,
    refusalDetail: logs.find(l => l.type === 'system' && /Refusing to send/.test(l.summary))?.detail ?? null,
  }
}

const out: Record<string, unknown> = { constants: { MIN_EXPECTED_REQUEST_TOKENS, MAX_NO_TOOL_ROUNDS_PER_TURN }, dbInsideWorkspace: true }
// Bob Comet's 3-call turn: prose → the one "call the tool" retry → a free query → prose again.
out.bob = await turn([text('Mission complete. Docked at War Citadel. Standing by for orders.'), game('get_status'), text('Player status confirmed. Standing by.')])
// The 2-call shape: a free query, then prose.
out.queryThenProse = await turn([game('get_status'), text('Docked, holding. Nothing to do.')])
// Prose twice: the per-turn cap ends the turn after the single retry.
out.proseTwice = await turn([text('I will hold position.'), text('Still holding.')])
// The case the retry exists for — prose, then the real action — is still a completed turn.
out.retryThenAction = await turn([text('I will undock now.'), game('undock')])
out.action = await turn([game('undock')])
// A state write alone is progress: the next turn reads it.
out.todoOnly = await turn([{ tool: 'update_todo', args: { content: 'next: await orders' } }, text('Done. Standing by.')])
// Request sanity check: a three-character prompt is refused when a full one is expected...
out.tinyRefused = await turn([game('undock')], { expectSystemPrompt: true })
// ...so is an empty message list behind a full-size prompt...
out.emptyRefused = await turn([game('undock')], { expectSystemPrompt: true, systemPrompt: 'x'.repeat(4000), messages: [] })
// ...while a full-size request goes out normally...
out.fullSent = await turn([game('undock')], { expectSystemPrompt: true, systemPrompt: 'x'.repeat(4000) })
// ...and without the option the tiny prompt every unit test uses is still sent.
out.tinyUnguarded = await turn([game('undock')])

clearTimeout(guard)
server.stop(true)
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
