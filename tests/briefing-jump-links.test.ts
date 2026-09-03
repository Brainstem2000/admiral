import { describe, expect, test } from 'bun:test'
import { normalizeSystem, renderJumpLinks } from '../src/server/lib/briefing'

/**
 * Morg'Thar, 2026-09-02 22:08: jump(nashira) from gsc_0051, then jump(scheat),
 * then jump(segin) — collecting `not_connected` until the loop-breaker fired.
 * The adjacency list was sitting in get_system the whole time, but get_system
 * answers as TEXT on his connection and the briefing only kept object
 * payloads, so his prompt never carried it.
 */

// The exact reply shape, taken from a live get_system at Krynn.
const TEXT = `System: Krynn (krynn) | Empire: crimson | Security: Maximum Security (empire capital)
POIs (7):
id\tname\ttype\tclass\tbase\tonline
krynns_fury\tKrynn's Fury\tsun\tM2III\t\t0
war_citadel\tWar Citadel\tstation\t\tCrimson War Citadel\t28
war_materials\tWar Materials\tasteroid_belt\tmetallic\t\t1
Connections (4):
system_id\tname\tdistance
the_anvil\tThe Anvil\t593 GU
iron_reach\tIron Reach\t399 GU
blood_forge\tBlood Forge\t295 GU
valor\tValor\t425 GU`

describe('normalizeSystem', () => {
  test('parses the text report an object-only check used to discard', () => {
    const s = normalizeSystem(TEXT)!
    expect(s.id).toBe('krynn')
    expect(s.name).toBe('Krynn')
    expect(s.empire).toBe('crimson')
    expect(s.security).toContain('Maximum Security')
  })

  test('recovers both tables, not just the first', () => {
    const s = normalizeSystem(TEXT)!
    expect((s.pois as unknown[]).length).toBe(3)
    const conns = s.connections as Record<string, string>[]
    expect(conns.length).toBe(4)
    expect(conns.map((c) => c.system_id)).toEqual(['the_anvil', 'iron_reach', 'blood_forge', 'valor'])
    expect(conns[1].distance).toBe('399 GU')
  })

  test('keeps empty cells aligned rather than shifting columns', () => {
    const pois = normalizeSystem(TEXT)!.pois as Record<string, string>[]
    const citadel = pois.find((p) => p.id === 'war_citadel')!
    expect(citadel.type).toBe('station')
    expect(citadel.class).toBe('')                 // genuinely blank in the source
    expect(citadel.base).toBe('Crimson War Citadel')
  })

  test('an object payload passes straight through', () => {
    const obj = { id: 'krynn', connections: [{ system_id: 'valor' }] }
    expect(normalizeSystem(obj)).toBe(obj as unknown as Record<string, unknown>)
  })

  test('an in-transit reply is not a system report — keep the cached one', () => {
    expect(normalizeSystem('IN TRANSIT (jump) | From: gsc_0051 → To: segin | ETA: 2 ticks')).toBeNull()
    expect(normalizeSystem(null)).toBeNull()
    expect(normalizeSystem('')).toBeNull()
  })
})

describe('renderJumpLinks', () => {
  test('names every reachable system id', () => {
    const out = renderJumpLinks(normalizeSystem(TEXT)).join('\n')
    for (const id of ['the_anvil', 'iron_reach', 'blood_forge', 'valor']) expect(out).toContain(id)
    expect(out).toContain('JUMP LINKS FROM HERE (4)')
  })

  test('says what a failed jump means, so it is not retried', () => {
    const out = renderJumpLinks(normalizeSystem(TEXT)).join('\n')
    expect(out).toContain('not_connected')
    expect(out).toContain('goto_system')
    expect(out).toContain('Do NOT retry')
  })

  test('handles the object form and bare id strings too', () => {
    expect(renderJumpLinks({ connections: [{ id: 'valor', name: 'Valor' }] }).join('\n')).toContain('valor (Valor)')
    expect(renderJumpLinks({ links: ['iron_reach', 'valor'] }).join('\n')).toContain('iron_reach · valor')
  })

  test('stays silent when there is nothing to say', () => {
    expect(renderJumpLinks(null)).toEqual([])
    expect(renderJumpLinks({})).toEqual([])
    expect(renderJumpLinks({ connections: [] })).toEqual([])
    expect(renderJumpLinks({ connections: [null, {}, 'x'] }).join('\n')).toContain('x')
  })
})
