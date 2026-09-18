import { describe, expect, test } from 'bun:test'

/**
 * Two defects reported from the UI on 2026-09-18, both on the Vault Item Ledger.
 *
 * 1. A 110 silicon_ore deposit made by the HUMAN operator (UMan) "did not show". It was in
 *    the database the whole time — ingested from the faction audit log, returned correctly by
 *    /api/faction/vault-ledger with agent "UMan" and via_audit_log true. The pane simply never
 *    refetched: it loaded once on mount while two sibling panes in the same file poll every
 *    30s. A human deposit is only discoverable through `recent_activity` on some agent's next
 *    view_faction_storage, so the window between depositing and seeing it was unbounded.
 *
 * 2. A PACKAGE carries its entire manifest as its item name. The longest in the ledger is 138
 *    characters and rendered raw into a table cell, blowing the column across the table.
 */
const UI = await Bun.file('src/frontend/src/components/FactionVaultPane.tsx').text()
const SEG = UI.slice(UI.indexOf('function VaultItemLedger'), UI.indexOf('function TreasuryStatement'))

describe('the vault item ledger refreshes itself', () => {
  test('it polls rather than loading once on mount', () => {
    expect(SEG).toContain('setInterval(load, 30000)')
    expect(SEG).toContain('clearInterval(t)')
    // the regression: a bare mount-only effect
    expect(SEG).not.toContain('useEffect(load, [load])')
  })
})

describe('long item names are truncated, not hidden', () => {
  test('a truncation helper exists with a sane cap', () => {
    expect(SEG).toContain('const shortItem')
    expect(SEG).toMatch(/ITEM_MAX\s*=\s*\d+/)
  })

  test('both views truncate AND keep the full value on hover', () => {
    // movements view
    expect(SEG).toContain('title={m.item_id}>{shortItem(m.item_id)}')
    // by-item view
    expect(SEG).toContain('shortItem(r.item_id ?? \'\')')
    // neither renders the raw string into the cell any more
    expect(SEG).not.toContain('<td className="pr-3">{m.item_id}</td>')
    expect(SEG).not.toContain('<td className="py-0.5 pr-3">{r.item_id}</td>')
  })
})
