# Prompt Architecture & Token Efficiency

**Status:** steps 1–5 EXECUTED 2026-08-19. Step 5 is live on 2 agents; 9 are the control.
Fleet is shut down.
**Analysed:** 2026-08-19. **Evidence window:** 2026-08-06 00:18–15:28 UTC.

This document exists so the plan is not re-derived from scratch. Read it before
touching `buildSystemPrompt`, agent directives, or provider/model routing.

---

## 1. Prompt caching is ALREADY ON. There is nothing to enable.

`@mariozechner/pi-ai` (not the official Anthropic SDK) sets `cache_control`
automatically in `providers/anthropic.ts`: on the system block(s) and on the last
user message. Retention defaults to `"short"` (5-minute TTL). `PI_CACHE_RETENTION=long`
gives a 1h TTL **but only when the base URL contains `api.anthropic.com`**. Admiral
passes no `cacheRetention` option, so it runs on the 5-minute default.

**Measured over the 2026-08-06 window** (13,355 calls with usage, 10–11 agents):

| | tokens |
|---|---|
| served from cache | **804,965,155** |
| cache writes | 149,476,256 |
| uncached input | 17,189 |
| output | 2,571,415 |
| **cache hit rate** | **84.3% of all prompt tokens** — 100% of calls got a read |

Baseline preserved at `data/baselines/llm-usage-2026-08-06.json` (log retention is
14 days; the source rows will prune).

**The Claude Console "Prompt caching — Not enabled" card is not a setting.** Caching
is a per-request parameter, never an org toggle. It reads "not enabled" — alongside
`$0.00 spend` and `no activity` — because the fleet runs on the **claude-max OAuth
subscription**, so no traffic reaches the metered API at all.

⚠️ **`systemPromptTokens` in `llm_call` logs is NOT real tokens.** `CHARS_PER_TOKEN = 2`
in `loop.ts` is a deliberately conservative estimate for game JSON. The logged median
of ~49,979 corresponds to ~100,000 chars ≈ ~25,000 real tokens. Only `cacheRead` /
`cacheWrite` / `input` / `output` come from the provider and are real.

---

## 2. The real cost lever is cache WRITES, not size

Writes were **15.7% of prompt tokens**, billed at 1.25×. Morg'Thar rewrote his entire
prompt on **~51% of his 4,239 turns**.

Cause: **volatile content lives inside the cached system prompt.** `buildSystemPrompt`
interpolates, in order — directive, prompt.md, credentials, connection mode, **memory**,
**fleet intel briefing**, **situational briefing (refreshed every 60s)**, **TODO list**,
**pending fleet orders**, command list, phase block.

Every one of the bolded items invalidates the whole prefix when it changes. The 60-second
situational briefing alone guarantees a rewrite at least once a minute. On top of that:
`update_memory`/`update_todo` (451 calls that day) and directive edits (133 versions).

**Secondary cause — the planner/executor fork.** `buildSystemPrompt(..., phase, ...)`
emits different text for `planning` vs `executing`. pi-ai caches the whole system prompt
as ONE block, so each phase is a separate cache entry and every flip
(`planning_interval` 8–10) is a full rewrite.

---

## 3. Directive decomposition (measured, all 11 agents)

**506,570 chars of directive fleet-wide. 339,393 (67%) is byte-identical duplication.**
80 distinct section titles.

| destination | chars | % | what |
|---|---|---|---|
| `prompt.md` — fleet-frozen | 267,968 | 52.9% | doctrine identical across agents, copied 11× |
| `todo` — current mission | 142,301 | 28.1% | HOT ROCK v4, SOL FORGE v5, FUNDING v2, platinum route |
| **DELETE** — superseded | 79,046 | 15.6% | HOT ROCK v3, GOLD RUSH, July objectives, closed quotas |
| `directive` — per-agent | 17,255 | 3.4% | character, job, role constraints |

Per-agent mapping: `data/baselines/directive-mapping.json`.
Section inventory: `data/baselines/directive-sections.json`.

**Both HOT ROCK v3 and v4 are live in all 11 agents right now** — v4's own header says
"SUPERSEDES v3" and v3 is still there. That is 6,450 chars of self-contradiction per agent.

---

## 4. What the change actually buys — measured, not assumed

Naive relocation **makes the prompt 16% BIGGER**. Moving all 46 distinct fleet-frozen
blocks into `prompt.md` means every agent carries every variant, instead of the subset it
had. The plan only works if variants are reconciled to one canonical block per topic first.

Reconciled (one block per topic, 26 blocks, 42,100 chars):

| | per-agent system prompt |
|---|---|
| now | ~93,200 chars |
| after | ~81,900 chars |
| **size reduction** | **~12%** |

**Size is the smaller half of the win. The bigger half is stopping invalidation** —
memory (5,000) + todo (3,885) + the 60s briefing leave the cached prefix entirely, so
they stop rewriting it. If writes drop ~70%, prompt-token cost falls roughly **40–45%**
on top of the 12%.

### Variants needing a human reconciliation decision

| variants | chars | topic |
|---|---|---|
| **11** | 1,293 | GAME KNOWLEDGE |
| 3 | 3,369 | COMMAND AUTHORITY |
| 3 | 1,389 | MACRO TOOLS |
| 3 | 2,456 | ANTI-IDLE |
| 2 | 2,076 | ANTI-CASCADE |
| 2 | 1,679 | FACTION STORAGE |
| 2 | 1,205 | BULK-BUY VERIFICATION |
| 2 | 2,645 | INVIOLABLE DOCTRINES |

---

## 5. Does a smaller directive keep agents on mission?

Evidence says yes — and that bulk actively *hurt*:

- Morg ignored "place no buy orders" **four times** while that rule sat in a 55k-char
  directive, because a section titled **"JOB — Krynn Market Buyer"** was still present.
  The fix that worked was **deleting the contradiction**, not adding a fifth restatement.
- Deleting the `PROCUREMENT SIZING — HARD CAPS` block on 2026-08-06 at 08:12 (as "stale
  July content") led directly to a **500,000cr** buy order at 500× base value at 15:11.
  **Relocate, never delete, without a mapping.** That incident is why this document exists.

Mission focus comes from the **todo**, which is what agents read and act on each turn.
Moving it out of the cached prompt into a late message makes it *more* salient, not less.

---

## 6. Execution order (not yet started)

1. **Reconcile the 8 multi-variant topics** above into one canonical block each. Human review.
2. **Write `prompt.md`** with the 26 reconciled fleet-frozen blocks.
3. **Rewrite each `directive`** to character + job + agent-specific constraints (~1,600 chars).
4. **Move mission content to `todo`**; delete the 79,046 chars of superseded blocks.
5. **Move `memory` / `todo` / briefings OUT of `buildSystemPrompt`** into a late message —
   this is the change that actually stops the cache churn, and it is a code change, not
   a content edit.
6. Consider whether the planner/executor phase fork is worth two cache entries.
7. Re-measure against `data/baselines/llm-usage-2026-08-06.json`.

---

## 7. Moving agents to the metered Anthropic API

Currently 10 of 11 agents are `provider=claude-max`, `model=claude-sonnet-4-6`
(Cass Margin is on local `ollama`). The `anthropic` provider row exists in the DB with
**no API key**.

Cost of the 2026-08-06 window at Sonnet 4.6 rates ($3/$15 per 1M):

| | |
|---|---|
| with caching (as measured) | **~$841** (reads $241 + writes $561 + output $39) |
| without caching | ~$2,900 |
| **per agent-hour** | **~$5.60** |

**Org credits at time of writing: $3.26 ≈ 35 agent-minutes.** Fund before testing, and
do step 1–5 first — writes scale with prompt size, and writes are the dominant cost.

**Test design:** two agents, not one — one high-volume (Morg or Ledger) and one
low-volume (Vera) — pointed at `anthropic`, with the other nine left on claude-max as a
control. `cacheRead`/`cacheWrite` are already logged per call, so the comparison is free.
Provider is per-agent in `profiles`; switching it changes nothing about directives,
tooling, or the game connection, so agents stay on mission throughout.


---

## 9. Execution log — 2026-08-19

**Steps 1–4 are done.** Operator decisions and what was built:

| decision | ruling |
|---|---|
| GAME KNOWLEDGE (11 variants) | union — body de-personalised into `prompt.md`; the per-agent `YOUR GUIDES` stanza stays in each directive |
| COMMAND AUTHORITY (3 variants) | **rewritten, not merged.** Orders come only from the Admiral, the human operator, or Admiral-interface nudges. Peer requests between agents are *encouraged* where complementary/supportive and where they do not take either agent off mission; must be refused where they would. Escalate reassignment to the Admiral. |
| MACRO TOOLS (3 variants) | union — fullest set |
| ANTI-IDLE / ANTI-CASCADE / FACTION STORAGE | mechanical: identical openings, fullest version is a superset |
| doctrine scope | **universal** — every agent carries all of it; roles change too often here for a role-tiered split |
| doctrine home | **`prompt.md` on disk**, in git, diffable |
| BoM lock list | **regenerated** from the live commission_quote; harness named as the real authority |
| step 5 (code change) | **test on 2 agents first**, behind a per-agent flag |

### Result

| | before | after |
|---|---|---|
| fleet directive total | 506,570 | **25,635** (−95%) |
| `prompt.md` | 4,168 | **44,149** (26 doctrine blocks) |
| per-agent directive + doctrine | ~50,300 | ~46,500 |

Per-agent directives now hold only: an orientation header, the role-guides stanza,
the preserved CHARACTER block, and a **current-reality JOB block**.

### The stale-job problem, and why the job blocks were rewritten

Mechanically preserving the sections classified `DIRECTIVE-per-agent` would have kept
July job descriptions that no longer matched what the agents do — CyberSapper as a
*Long-Haul Freight Trader*, Nova as a *Missions Specialist*, CyberSpock as *Production
Chief* for a closed line, Ledger as an *Iron & Steel Miner*. Zibal had no identity block
at all and would have ended with an empty directive.

That is precisely the failure this whole effort exists to remove: Morg'Thar kept placing
buy orders because a `JOB — Krynn Market Buyer` section outlived the job. So the job
blocks were **rewritten to current reality** rather than preserved:

| agent | role now |
|---|---|
| Morg'Thar | Vault Keeper & Commissioning Agent — stationary at Krynn/war_citadel; **no buy orders**; use `http_v2` for `commission_ship` |
| Bob Comet | The Sol Forge — posted to Confederacy Central Command; holds the 30 plutonium |
| Ledger Voss | Three-Class Extractor — the only rad+ice+gas hull; no mining laser |
| Nova Reyes | Ice Specialist & Component Bank — found the tritium; largest hold |
| CyberSapper | Prospector-Miner — Prospect hull, laser + survey scanner, no rad harvester |
| CyberSpock | Miner, Radioactive & Bulk — keeps the rad harvester fitted |
| Grit Vane | Heavy Miner — laser III + rad harvester; **check `supported_power`** |
| Zibal Prospector | Surveyor — new character block written; **dock when ordered** |
| Vera Lane | Ore Hauler & Thorium Miner — found Bunda Belt |
| Cass Margin | Ore Hauler — runs on local ollama, useful as a control |
| Juno Freight | Ore Hauler — ask in chat before leaving a station empty |

### What step 5 still has to do

The 12% size reduction has landed. **The larger win has not** — memory, TODO and the
60-second situational briefing are still interpolated inside the cached system prompt by
`buildSystemPrompt`, so they still invalidate the prefix on every change. Until they
move to a late message, cache writes stay where they were. Ship it behind a per-agent
flag, run Morg and one miner on it, and compare `cacheWrite` against the other nine.


---

## 10. Step 5 — the volatile/stable split (shipped, on 2 agents)

`buildSystemPrompt` used to interpolate memory, the fleet-intel briefing, the 60-second
situational briefing, the TODO and pending fleet orders directly into the cached system
prompt. Every change to any of them invalidated the whole prefix.

That region is now extracted into **`buildVolatileState(profile, profileId)`** and, for
agents with `profiles.volatile_split = 1`, delivered as a **`## CURRENT STATE` block at
the front of the per-turn user message** — i.e. at the END of the conversation, after
the cached prefix.

Two details that make or break it:

- **The rebuild test had to change too.** The cached prompt was rebuilt whenever
  todo/memory/briefing changed. Under the split those are gated out (`volatileChanged`
  is forced false), leaving only directive and phase as triggers. Without this the
  prompt would still churn every 60 seconds and the change would buy nothing.
- **Cross-references are layout-aware.** The prompt says "your TODO is shown *above*"
  in six places. Under the split that is false, so a `stateAt` variable renders either
  `above` or `in the CURRENT STATE message at the end of this conversation`. A stale
  pointer would send an agent hunting for a block that is not there.

**New read-only route: `GET /api/profiles/:id/prompt[?phase=planning|executing]`** —
renders an agent's prompt without running a turn or spending a tick, returning the
system prompt, the volatile block, and their sizes. This is how the split was verified.

### Verified 2026-08-19 (command list excluded — agents offline)

| agent | split | system prompt | volatile moved out |
|---|---|---|---|
| Morg'Thar | on | 53,091 | 9,200 |
| Grit Vane | on | 49,154 | 14,671 |
| Ledger Voss (control) | off | 65,123 | 0 — still in-prompt |

### What has NOT been proven yet

The saving is **structural, not yet measured**. Nothing has run since 2026-08-09, so
there is no post-change `cacheWrite` figure. The test is: run the fleet, then compare
`cacheWrite` per call for Morg and Grit against the nine control agents, using
`data/baselines/llm-usage-2026-08-06.json` as the before. Expect the control group to
be unchanged and the two split agents to drop sharply. If they do not, the gate is not
working and `volatileChanged` is the first thing to check.
