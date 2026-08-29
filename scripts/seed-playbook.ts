/**
 * Seed the Playbook with 2026-08-28's ledger-verified plays. Idempotent
 * (title-keyed upsert). Run again any time to re-verify the whole seed set.
 *
 *   bun scripts/seed-playbook.ts
 */
import { getDb, promotePlaybookEntry, listPlaybook } from '../src/server/lib/db'

getDb()
const V = 'v0.567.1' // server version at verification (get_guide reports it)

const SEED: Parameters<typeof promotePlaybookEntry>[0][] = [
  // ── LAWS — game mechanics, hold until a server patch ──
  { class: 'LAW', title: 'Gifts land at the SENDER\'s station', server_version: V,
    body: 'Item/credit gifts to a player park in the recipient\'s storage AT THE STATION THE SENDER WAS DOCKED AT. Same-station gifts arrive in ~90 seconds; cross-station gifts wait until the recipient docks THERE. To hand something over, be co-docked.',
    evidence: '8/28: 36x titanium + 14x fuel_tank + 4x sensors all parked at sender stations; Vera\'s same-station 5k landed in 90s',
    kill_condition: 'a cross-station gift arrives in the recipient\'s wallet/home storage after a patch' },
  { class: 'LAW', title: 'Sell-order fills are silent', server_version: V,
    body: 'The game sends NO notification when your sell order fills — the wallet just grows. Check view_orders periodically to reconcile; a fully-filled order VANISHES from the list.',
    evidence: '8/28: Cass +86k and +197k arrived with zero notifications; ledger needed manual reconciliation twice',
    kill_condition: 'a fill notification appears in the game feed' },
  { class: 'LAW', title: 'Commissions pull from ONE storage', server_version: V,
    body: 'commission_ship with provide-materials consumes ONLY the commissioning player\'s own storage at that station. Fleet-wide totals are fiction for building; consolidate into the builder\'s storage first.',
    evidence: 'Devastator build 8/28 + documented platinum shortfall incident',
    kill_condition: 'a commission accepts materials from another player\'s or faction storage' },
  { class: 'LAW', title: 'Jumps train piloting', server_version: V,
    body: 'Every jump grants piloting XP (observed +6/jump) and navigation XP. Route mileage is skill training — low-piloting agents grow into better hulls by working.',
    evidence: 'Nova\'s 8/28 jump log: piloting_xp: 6 per jump',
    kill_condition: 'jump results stop granting piloting_xp' },
  { class: 'LAW', title: 'Station refuel beats fuel cells ~50x', server_version: V,
    body: 'Docked station-tank refuel costs 2-20cr/unit (plus tax); fuel cells cost 60+cr/unit and crisis-price to 3,000/cell. Cells are an 8-max emergency reserve and a SELL-side asset in shortages — never travel fuel.',
    evidence: '180k cell-buying disaster 8/27; 8/28 crisis asks 3,000/cell vs ~1,000 full-tank station fills',
    kill_condition: 'station fuel pricing rises to parity with cells' },
  // ── TERRAIN — weeks-scale, refreshed by fleet traffic ──
  { class: 'TERRAIN', title: 'The Crucible corridor crosses empires safely',
    body: 'The verified policed crossing between solarian space and krynn (crimson): node systems <-> the_crucible <-> iron_reach <-> krynn. The learned route graph may not know it — plot leg by leg.',
    evidence: 'Morg flew crucible<->iron_reach<->krynn repeatedly 8/28, zero danger flags',
    kill_condition: 'any leg grades RISKY/DANGEROUS on a live fleet_route or a patrol disappears' },
  { class: 'TERRAIN', title: 'Dheneb + the Gudja pocket are lawless',
    body: 'Dheneb (Hex Star), Gudja, Pipirima, HD-147513, LHS-1140, Adhara: zero police. Goldcrest and Bluerift remain forbidden. Hex Star itself is an allied dock (HEXC) but the transit is the danger.',
    evidence: 'system_danger_daily grades 8/26-8/28; AetherWraith destroyed Hex Star 7/29',
    kill_condition: 'empire patrols appear in these systems' },
  { class: 'TERRAIN', title: 'War Citadel yard is tier 3',
    body: 'crimson_war_citadel shipyard builds up to tier-3 hulls (built the tier-4 Devastator via commission). The fleet\'s capital: fuel, storage, market depth on bulk goods.',
    evidence: 'Devastator commission 7f4c3f0c built here 8/28',
    kill_condition: 'yard tier changes or station is destroyed' },
  // ── PATTERNS — days-scale trends, 2-in / 2-out ──
  { class: 'PATTERN', title: 'Patient crystal listing beats bids', role_scope: 'trader',
    body: 'focused_crystal has no honest bid wall (legit bids ~40) but SCARCE asks at 1,900-3,700. List at 1,900-2,200 and wait — buyers come. Never dump into bids; never touch the pirate 5,340 bid.',
    evidence: 'Cass 8/28: +44k, +46k, +86k, +197k across four fill waves at 1,850-2,100',
    kill_condition: 'listings at ~2,000 sit unfilled for 24h, or a deep honest bid wall appears' },
  { class: 'PATTERN', title: 'Empire fuel crisis: sell cells, mind dry tanks',
    body: 'An empire-wide fuel shortage is running: some station tanks are DRY (Grand Exchange 8/28) and crimson stations BID 1,400+ for fuel_cell. Selling held cells into crisis bids pays; route via stations with working tanks.',
    evidence: 'GE tank empty 8/28; WC fuel_cell bid 1,408x49 station-verified; forum thread "Fuel Cell for a Starving Empire" 8/25',
    kill_condition: 'station tanks read full at 2 consecutive checks and cell bids drop under ~300' },
  { class: 'PATTERN', title: 'Ally recon missions pay for showing up', role_scope: 'explorer',
    body: 'Allied factions (HEXC) post exploration missions paying ~1,000cr just to dock at their station. Check faction-adjacent mission boards for visit/survey contracts — trivial income for anyone passing.',
    evidence: 'Grit banked 1,000cr "HEXC recon: Hex Star" 8/28 (auto-settled on dock)',
    kill_condition: 'two board rotations with no such missions posted' },
  { class: 'PATTERN', title: 'MAYDAY rescues do not pay',
    body: 'Stranded-ship maydays (the Wexler fleet especially) are unpaid charity: no escrow, no tips, no replies. Related "Distress:" board missions carry zero reward. Ignore the emergency channel for income.',
    evidence: 'Juno\'s 8/28 rescue trial: ~13.2k spent, 0 received, no reply; Morg\'s distress-mission triage: zero-reward',
    kill_condition: 'a rescue bounty/escrow mechanic appears in a patch (would make this a LAW-level change)' },
]

for (const e of SEED) promotePlaybookEntry(e)
const all = listPlaybook(undefined, true)
console.log(`playbook seeded: ${all.length} entries (${all.filter(e => e.status === 'active').length} active)`)
for (const e of all) console.log(`  [${e.class}] ${e.title}`)
