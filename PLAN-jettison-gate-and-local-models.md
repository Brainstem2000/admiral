# PLAN — Jettison Gate + Local-Model Migration
Prepared 2026-07-30. Two independent workstreams; Part A is a prerequisite for Part B.

---

# PART A — Fleet-wide jettison gate (deploy now, ~30 min)

## Why
Directive-level prohibition has failed **four times across four agents**:

| Agent | Incident | Cost |
|---|---|---|
| Juno Freight | jettisoned vanadium | −28,000 cr |
| CyberSpock | aluminum + vanadium, twice | triggered full rebuild |
| Morg'Thar | copper_ore x7, one jump from a vault | minor, but he is the vault keeper |
| Vera Lane | declared intent on fuel cells (caught pre-execution) | 0 (intercepted) |

All four produced the *same* rationalization: *"this has no local bid → free the cargo
space."* That reasoning is economically sensible and locally correct, which is exactly why
prose rules lose to it. Enforcement must move out of the model.

This is the same lesson already banked twice: the wildlife-mission blocklist (three failed
written bans on one agent) and the DB sell quotas (agent-memory tracking oversold twice in
one night). Both became deterministic gates in `tools.ts` and both stopped failing.

## Design — mirror the existing guard pattern
`src/server/lib/tools.ts`, alongside the wildlife blocklist (~line 382) and the BoM sell
lock (~line 399). Same shape: intercept before dispatch, log the attempt, return a refusal
string the model can act on.

```ts
// Jettison gate: four agents in one campaign jettisoned sellable cargo on the
// same "no local bid → free the space" reasoning; written doctrine failed every
// time (one triggered a full agent rebuild). Deterministic refusal, fleet-wide.
// Toggle: preference `jettison_gate` = 'off' disables (default on).
{
  const bare0 = command.replace(/^spacemolt_/, '').replace(/^ship_/, '')
  if ((bare0 === 'jettison' || bare0.endsWith('_jettison')) && getPreference('jettison_gate') !== 'off') {
    const items = Array.isArray(commandArgs?.items)
      ? (commandArgs.items as Array<Record<string, unknown>>)
          .map(i => `${i.item_id ?? i.id}x${i.quantity ?? '?'}`).join(', ')
      : `${commandArgs?.item_id ?? commandArgs?.id ?? 'cargo'}`
    const msg =
      `BLOCKED by Admiral doctrine: jettison is disabled fleet-wide (attempted: ${items}). ` +
      `Nothing with a bid is worthless and the fleet decides what is scrap, not you. ` +
      `Instead: deposit the cargo at your next station (storage is free), gift it to an ` +
      `agent who needs it, or sell it at a hub that actually bids. If your hold is full ` +
      `and you are far from a station, finish the run and deposit on arrival.`
    ctx.log('tool_call', `game(${command}, ${formatArgs(commandArgs ?? {})})`)
    ctx.log('tool_result', msg)
    return msg
  }
}
```

### Notes
- **Hard block, not a value check.** A "block only if it has a bid" variant needs a market
  lookup per call, is wrong in exactly the cases that bit us (no *local* bid ≠ worthless),
  and adds latency. Hard block; the refusal text names the three legitimate alternatives.
- **Escape hatch** via the existing preference system, so a genuine need (contraband dump
  during a pursuit) is one setting away without a redeploy.
- **Refusal string, not an exception.** Matches the other gates — the agent reads it,
  adapts, and continues the turn instead of erroring out.

## Verification
1. `bun run build` (must succeed) + `bun test tests/` (Codex suites currently 9/9).
2. Deploy via `scratchpad/start_admiral.py`, reconnect fleet.
3. Live check: issue `jettison` through the command API for one docked agent; expect the
   BLOCKED string and **no** cargo change on `get_cargo`.
4. Watch one cycle for `BLOCKED by Admiral doctrine: jettison` lines — none expected
   unless an agent tries.

## Directive cleanup (after deploy)
The no-jettison prose stays (it explains *why*), but the four per-agent warning blocks
added during incidents can be removed — the gate makes them redundant.

---

# PART B — Local-model migration (when the MacBook arrives)

## Hardware — validated against Apple's published specs

| Spec | Your config (Apple published) | Note |
|---|---|---|
| Chip | **M5 Max** | announced March 2026 |
| CPU | **18-core** (6 super + 12 performance) | |
| GPU | **40-core**, Neural Accelerator in *each* core | |
| Neural Engine | **16-core** | ⚠️ your "11-core" guess doesn't match any published M5 Max config |
| Memory bandwidth | **614 GB/s** | up from M4 Max's 546 |
| Unified memory | **128 GB** (max for M5 Max) | |
| Storage | 4 TB (8 TB available) | ample — see budget below |
| AI compute | **>4× peak GPU compute vs M4 Max**; +15% MT CPU, +20% graphics | Apple explicitly cites "higher token generation for LLMs" |

**This changes my earlier caution.** I previously flagged prompt processing (prefill) as
the likely bottleneck, since Admiral's turns carry 20–28 KB directives plus briefings.
Prefill is compute-bound, and the per-GPU-core Neural Accelerators plus >4× AI compute
target exactly that. Prefill is no longer the primary worry; **concurrency and prompt-cache
behavior are.**

## Throughput math (614 GB/s ceiling, generation)

Generation streams active parameters per token, so tok/s ≈ bandwidth ÷ active-bytes.
Real-world MoE efficiency runs ~40–60% of theoretical.

| Model | Total / active | Weights on disk+RAM | Theoretical | Realistic | Verdict |
|---|---|---|---|---|---|
| **gpt-oss-120b** (MXFP4) | 117B / 5.1B | ~63 GB | ~225 tok/s | **90–140** | ✅ best fit — built for agentic tool use, adjustable reasoning effort |
| **GLM-4.5-Air** @4-bit | 106B / 12B | ~60 GB | ~100 tok/s | 40–70 | ✅ strong agentic alternative |
| **Llama 4 Scout** @4-bit | 109B / 17B | ~60 GB | ~72 tok/s | 30–45 | ✅ viable, long context |
| **Qwen3-32B dense** @8-bit | 32B dense | ~35 GB | ~19 tok/s | 10–15 | ⚠️ too slow for 10 agents; useful as a verifier |
| Qwen3-235B-A22B @4-bit | 235B / 22B | ~120 GB | — | — | ❌ leaves no room for KV cache at 128 GB |

**Memory budget:** ~63 GB weights + ~10–15 GB KV cache across concurrent agents + ~12 GB
macOS ⇒ ~90 GB of 128 GB. Comfortable. **Storage:** 3–4 candidate models ≈ 200–250 GB of
your 4 TB — non-issue.

## The two real constraints

1. **Concurrency.** One box serves one model instance. Ten agents queue on it. Use
   llama.cpp `--parallel` or an MLX server with batching — MoE batches well — but plan for
   3–4 local agents, not 10, at your current turn cadence.
2. **Prompt-cache thrash.** Anthropic's cache is why "don't invalidate the system prompt"
   is a documented invariant in CLAUDE.md. Local servers prefix-cache per slot; ten agents
   with ten distinct ~25 KB system prompts will evict each other. Pin local agents to
   dedicated slots, or accept re-prefill each turn (now cheap, given the compute above).
3. **24/7 thermals.** Your fleet runs continuously. Sustained inference on a laptop is
   fine but hot and loud, and it ties the machine down. If this becomes permanent
   infrastructure, a Mac Studio is the better host and the same models apply.

## Migration plan — reuse your own A/B pattern

You've done this twice successfully (lib_v2 trialled on Grit; Codex on Nova + Vera).

- **Phase 0 — prerequisite:** ship the Part A jettison gate. Weaker models are safe only
  to the degree enforcement lives in the harness. Also finish the pattern: price ceilings
  and the 25K floor are still prose in several directives.
- **Phase 1 — plumbing (zero code):** install LM Studio or Ollama, serve `gpt-oss-120b`.
  Admiral auto-discovers `:11434` / `:1234` and registers them as OpenAI-compatible
  providers (`src/server/lib/providers.ts:14-15`) — no adapter work, unlike the Codex path.
- **Phase 2 — single-agent trial:** move **Ledger** (banker: iron→steel→vault, most
  repetitive loop, smallest blast radius) to the local model for one week. Metrics to
  compare against his Sonnet baseline: deposits/day, doctrine violations, tool-call error
  rate, turns-per-completed-objective.
- **Phase 3 — tier out if clean:** add **Nova** and **Grit** (mining/hauling). Keep on
  Sonnet: Cass, Juno, Vera, Sapper (money at risk), Morg (six-figure escrow), Spock
  (production chain, rebuild-prone).
- **Expected saving:** ~30–40% of Claude usage, with judgment kept where it earns its keep.

## Honest expectation
No open-weight model available today matches Sonnet 4.6 for doctrine adherence over
20-turn horizons — and Sonnet itself still drifts (Spock's 30-jump salvage run, Morg's
idle freeze). What makes local models *viable here* is not their capability; it's that
your harness has been progressively taking discretion away from the model. Finish that
migration first, then the engine matters less.

## Sources
- https://www.apple.com/newsroom/2026/03/apple-debuts-m5-pro-and-m5-max-to-supercharge-the-most-demanding-pro-workflows/
- https://support.apple.com/en-us/126319
- https://www.apple.com/macbook-pro/specs/
