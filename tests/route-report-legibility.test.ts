import { describe, expect, test } from 'bun:test'

/**
 * The Places & routes jump report rendered at 10-11px — the per-hop rows, the risk grade and
 * the detour block all sat below the pane's own body size, which made the one table an
 * operator actually reads before committing a fleet movement the hardest thing on the page to
 * read. Reported 2026-09-18.
 *
 * Sizes are asserted rather than eyeballed because this block has three near-identical row
 * renderers (main hops, detour hops, place card) and it is easy to bump one and miss another.
 */
const UI = await Bun.file('src/frontend/src/components/IntelLookups.tsx').text()
const ROUTE = UI.slice(UI.indexOf('{route && ('), UI.indexOf('{place && ('))

describe('the jump report is legible', () => {
  test('the headline jump count is prominent', () => {
    expect(ROUTE).toContain('text-[17px] font-semibold tabular-nums">{route.jumps} jumps')
  })

  test('every per-hop row is at least 13px — both main and detour', () => {
    const rows = ROUTE.match(/<div key=\{i\} className="flex items-baseline gap-3 text-\[13px\]">/g) ?? []
    expect(rows.length).toBe(2)          // main hop list + detour hop list
    // nothing in the route block still renders hops at the old size
    expect(ROUTE).not.toContain('items-baseline gap-2 text-[11px]')
  })

  test('the risk grade is no longer 10px', () => {
    expect(ROUTE).not.toContain('text-muted-foreground text-[10px]')
    expect(ROUTE).toContain('text-muted-foreground text-[11.5px]">{h.grade}')
  })

  test('columns widened to match the larger type', () => {
    expect(ROUTE).toContain('font-mono w-60">{h.system_id}')
    expect(ROUTE).not.toContain('font-mono w-52">{h.system_id}')
  })

  test('the killzone warning and detour banner scale with it', () => {
    expect(ROUTE).toContain('text-[13px] font-semibold" style={{ color: \'hsl(var(--smui-red))\' }}>CROSSES')
    expect(ROUTE).toContain('text-[13px] tabular-nums font-semibold">{route.detour.jumps} jumps')
  })
})
