import type { Context } from '@mariozechner/pi-ai'

// Surrogate-safe text helpers. Two concerns, two functions:
//   1. safeTruncate()        — cheap root-cause fix at every truncation site.
//                              Slices by UTF-16 code unit (as before) but never
//                              leaves a DANGLING HIGH surrogate at the cut, so the
//                              suffix is appended to well-formed text.
//   2. stripLoneSurrogates() — full scrub of UNPAIRED surrogates ANYWHERE in a
//                              string. Used by the pre-send Context scrub to HEAL
//                              already-poisoned history so the next complete()
//                              succeeds without a restart.
//
// Why this lives here and not in pi-ai: pi-ai sanitizes most request fields with
// an identical regex (dist/utils/sanitize-unicode.js) but does NOT re-export it,
// and — critically — does NOT sanitize tool_use `input` (ToolCall.arguments) or
// tool definitions, which it serializes raw. A lone surrogate that lands in a
// tool-call argument (e.g. an emoji in an outbound game(chat, ...) call truncated
// mid-pair) therefore reaches the Anthropic API unsanitized and 400s the request,
// permanently looping the agent because the poisoned message stays in history.
// scrubContextSurrogates() closes that gap.

/**
 * Matches any UNPAIRED UTF-16 surrogate code unit: a high surrogate not followed
 * by a low surrogate, or a low surrogate not preceded by a high surrogate.
 * Well-formed surrogate PAIRS (complete astral-plane emoji) never match.
 * Byte-for-byte identical to pi-ai's sanitizeSurrogates.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Matches a single trailing high surrogate at the very end of a string. */
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/

/**
 * Tool-definition arrays already scrubbed. `context.tools` is a module-level
 * shared singleton (allTools) reused across all agents and every turn, and its
 * definitions are static (command descriptions are already surrogate-safe at the
 * source via safeTruncate in schema.ts). We therefore scrub a given tools array
 * at most once instead of deep-walking the shared singleton on every complete().
 */
const scrubbedTools = new WeakSet<object>()

/**
 * Truncate `text` to at most `maxLen` UTF-16 code units, then append `suffix`.
 * Never splits a surrogate pair: a fixed-length head slice can only ever orphan a
 * trailing HIGH surrogate (its low partner was cut off), so that orphan is dropped
 * before the suffix is appended. Returns the original string unchanged when it
 * already fits (no suffix added), preserving prior call-site behavior.
 */
export function safeTruncate(text: string, maxLen: number, suffix = ''): string {
  if (text.length <= maxLen) return text
  let cut = text.slice(0, maxLen)
  if (TRAILING_HIGH_SURROGATE_RE.test(cut)) cut = cut.slice(0, -1)
  return cut + suffix
}

/**
 * Remove every UNPAIRED surrogate code unit anywhere in `text`. Valid surrogate
 * pairs (complete emoji) are left intact. Idempotent and O(n). Deletes the orphan
 * (matches pi-ai's behavior) rather than substituting U+FFFD, avoiding a visible
 * replacement char in chat/game text.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '')
}

/**
 * Recursively scrub every string leaf of an arbitrary JSON-ish value IN PLACE.
 * Handles nested objects/arrays (e.g. ToolCall.arguments and TypeBox schemas) and
 * renames object KEYS that contain lone surrogates (a bad key would equally break
 * the JSON body).
 */
function deepScrub(node: unknown): unknown {
  if (typeof node === 'string') return stripLoneSurrogates(node)
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = deepScrub(node[i])
    return node
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      const cleanKey = stripLoneSurrogates(key)
      const value = deepScrub(obj[key])
      if (cleanKey !== key) { delete obj[key]; obj[cleanKey] = value }
      else { obj[key] = value }
    }
    return obj
  }
  return node // number | boolean | null | undefined — nothing to scrub
}

/**
 * Walk `context` and strip lone surrogates from every field pi-ai serializes into
 * the Anthropic request body. Call RIGHT BEFORE every complete() invocation. This
 * heals already-poisoned history in place AND covers tool_use `input` and tool
 * definitions, which pi-ai serializes raw. In-place; returns the same Context.
 */
export function scrubContextSurrogates(context: Context): Context {
  if (typeof context.systemPrompt === 'string') {
    context.systemPrompt = stripLoneSurrogates(context.systemPrompt)
  }
  for (const msg of context.messages as any[]) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      msg.content = stripLoneSurrogates(msg.content) // the only bare-string content
    } else if (Array.isArray(msg.content)) {
      // text + thinking blocks + ToolCall.id/name/arguments. Scrubbing thinking
      // text while leaving thinkingSignature intact is intentional and mirrors
      // pi-ai's own anthropic.js (sanitizeSurrogates(thinking) + signature passed
      // through), so the bytes the API receives are unchanged — no signature desync.
      deepScrub(msg.content)
    }
    if (typeof msg.toolCallId === 'string') msg.toolCallId = stripLoneSurrogates(msg.toolCallId)
    if (typeof msg.toolName === 'string') msg.toolName = stripLoneSurrogates(msg.toolName)
  }
  // Tool definitions are static and shared across agents/turns — scrub each array
  // at most once rather than deep-walking the shared singleton on every call.
  if (Array.isArray(context.tools) && !scrubbedTools.has(context.tools)) {
    deepScrub(context.tools) // name/description/schema
    scrubbedTools.add(context.tools)
  }
  return context
}
