# Crimson Devastator — Full Audit

**Run:** 2026-08-06 ~02:00–03:00 UTC · **Method:** live `commission_quote` +
storage ledger rebuilt from scratch via `view_storage(station_id)` across every
(agent, station) pair · **Catalog:** codex v0.552.0

This audit overturned most of what the campaign believed. Read the corrections
before acting on any older note.

---

## 1. Headline

| | |
|---|---|
| Commission lines closed | **20 of 24** — already sitting at Krynn/war_citadel |
| Remaining raw shortfall | **thorium_ore 444** and **tritium_ice 265**. That is all. |
| Credits needed | **1,808,005** (labor 45,500 + yard fee 1,762,505) |
| Credits in Morg's wallet | ~672,785 → gap **~1,135,000** |
| Audited sellable surplus | **~19,500,000 cr** — the gap is 6% of what we're sitting on |
| Hard blocker | `mass_driver` ×2 (see §6) |

---

## 2. What we were wrong about

**Uranium is not needed.** The entire uranium chain exists to produce
`reactor_grade_plutonium`. Bob Comet already holds **30** of the **23** required,
at `confederacy_central_command`. The fleet spent the last cycle mining uranium
5× harder (82 → 617) for nothing.

**Fluorine gas is not needed.** It only ever entered the chain through
`synthesize_liquid_tritium` (the deuterium route). We are not taking that route.

**Tritium ice was never a "can't find it" problem — it was a tooling problem.**
Catalog field `items.<id>.extracted_by` has four values, and each needs its own
fitted module:

| class | module | notable members |
|---|---|---|
| `mining` | `mining_laser_*` | iron, copper, silicon, nickel, lead, adamantite, exotic_matter |
| `rad` | `rad_harvester_*` | uranium, **thorium**, polonium, radium |
| `ice` | `ice_harvester_*` | water, nitrogen, deuterium, helium, **tritium** |
| `gas` | `gas_harvester_*` | argon, hydrogen, xenon, fluorine |

The fleet owned **no ice or gas harvester fitted on anyone** until tonight. This is
the same trap that made CyberSpock the only polonium producer for months — he was
the only one with a rad harvester.

**The requirement was never 2,484 / 2,208 / 460 / 368.** Those were naive
raw-expansion figures that ignored the intermediates we already hold. Netting stock
at every level of the tree gives 444 / 265 / 0 / 0.

---

## 3. The four open lines

| line | need | at Krynn | route |
|---|---|---|---|
| `neutronium_ingot` | 18 (+5 for the 2nd reactor core = **23**) | 0 | build |
| `station_reactor_core` | 2 | 1 | build — needs 5 neutronium |
| `mass_driver` | 2 | 0 | **blocked, see §6** |
| `piercing_railgun_ii` | 2 | 0 | build — clean |

The other 20 lines (weapon_core 220, hull_plating 140, fury_alloy 120,
shield_emitter 95, weapon_housing 80, durasteel_plate 80, targeting_computer 70,
armor_plate 60, capital_ship_frame 12, railgun_capacitor 12, crimson_siege_plating 4,
reinforced_bulkhead 3, power_distribution_grid 2, crimson_ordnance_bay 2,
weapon_battery 2, railgun_ii 2, darksteel_armor 1, fury_cannon 1,
crimson_berserker_plating 1, reactive_armor_hardener 1) are **all closed with stock
physically at war_citadel**.

⚠️ Several sit at zero margin (`weapon_core` 223/220, `weapon_housing` 82/80,
`railgun_capacitor` 12/12, `reinforced_bulkhead` 3/3). One casual sale re-opens a
closed line.

---

## 4. Critical path

```
thorium_ore 444 ──> concentrate_thorium x74 ──> process_thorium x37
                                            ──> fabricate_thorium_fuel_rod x37
tritium_ice 265 ──> process_tritium_ice x53  (ice 5 -> liquid_tritium 2)
        └──> fabricate_fusion_fuel_rod x54 (thorium_fuel_rod 1 + liquid_tritium 2)
             └──> assemble_power_core x27 (+ helium_3, power_battery, energy_crystal)
                  └──> synthesize_neutronium x23
                       (weapons_grade_plutonium 1 + durasteel_plate 3 + power_core 2)
                            ^
        reactor_grade_plutonium 23 + polonium_ore 23 ──> refine_weapons_grade_plutonium x23
```

All recipes are hand-craftable — **no facility required**. A workshop runs one job
at a time; queue in order and never poll-and-cancel.

**Route choice, validated:** `process_tritium_ice` (265 tritium) beats
`synthesize_liquid_tritium` (~3,900 deuterium_ice **plus** 1,369 uranium **plus**
318 fluorine) by roughly 15×. Deuterium is the documented fallback only —
Albireo Ice Fields holds 4,508 if we are ever forced onto it.

---

## 5. Haul manifest — must physically reach Krynn

`supply_commission` pulls only from the commissioning agent's cargo and *that
station's* storage. Fleet-wide totals are irrelevant at the moment of truth.
Item gifts land at the **sender's** station, so this is real flying.

| item | need | @Krynn | short | holder |
|---|---|---|---|---|
| `reactor_grade_plutonium` | 23 | 0 | 23 | **Bob Comet @ confederacy_central_command ×30** |
| `energy_crystal` | 54 | 7 | 47 | Nova Reyes @ central_nexus ×66 |
| `power_cell` | 22 | 1 | 21 | Nova Reyes @ starfall_salvage_station ×101 |
| `thorium_fuel_rod` | 17 | 0 | 17 | Bob Comet @ grand_exchange_station ×16 |
| `thorium_ore` | 444 | 0 | 444 | Bob Comet @ nova_terra_central ×85 + **mine the rest** |
| `tritium_ice` | 265 | 0 | 265 | **nobody — must be found** |

Bob Comet's 30 plutonium is the single most valuable stack the fleet owns and it is
parked in a station nobody visits. Losing or selling it resets the build by weeks.

---

## 6. The one hard blocker: `mass_driver` ×2

`build_mass_driver` needs `adamantite_bar` ×2 each → **4 bars**. Only two routes
exist and both cost:

**A — hunt.** `adamant_tooth_forging` = `adamant_tooth` ×2 → 1 bar, so **8 teeth**.
`adamant_tooth` is a *legendary* drop from an "adamant-grinder" creature. No recipe.
We hold 0. Requires hunting, which the fleet is currently blocklisted from.

**B — mine.** `forge_adamantite` = `adamantite_ore` ×5 + `neutronium_ingot` ×1 +
`exotic_crystal` ×2 → 1 bar. For 4 bars: **20 adamantite_ore** (legendary, `mining`
class, we hold 0), **4 EXTRA neutronium** (pushing thorium to ~521 and tritium to
~311), and **8 exotic_crystal** (hold 2; the rest needs 18 `exotic_matter` — we hold
14, and it is *"found only in Voidborn space"*).

**This needs your decision.** B is fully mineable but raises the whole build's
thorium/tritium cost ~17%. A is cheaper if adamant-grinders are findable, but means
lifting the wildlife blocklist.

---

## 7. Funding — solved, not scarce

Gap ~1,135,000 cr. Audited surplus the build never touches: **~19,500,000 cr** at
base value across 81 lines.

The old blanket ore lock existed only because nobody could separate BoM from
surplus. Now we can. Authorised for sale (bulk commons/uncommons only):

| item | held | note |
|---|---|---|
| `lithium_ore` | 37,510 | sell freely |
| `copper_ore` | 24,225 | sell freely |
| `nickel_ore` | 17,603 | sell freely |
| `steel_plate` | 15,002 | keep 2,000 |
| `vanadium_ore` | 13,180 | keep 500 |
| `argon_gas` | 10,895 | keep 900 |
| `fermentation_culture` | 8,206 | sell freely |
| `copper_piping` | 6,561 | sell freely |

That is ~2.26M at base value from commons alone — comfortably covering the gap even
at below-base market prices, **without touching a single exotic or legendary**
(phase_matrix, fury_crystal, quantum_fragments, darksteel_ore etc. — ~12M, held back).

⏱ **The yard fee drifts upward: 1,558,352 → 1,689,657 → 1,762,505, roughly
+36,000/day.** Delay has a price. Re-quote every session.

---

## 8. Fleet posture after retasking

| agent | fitted extraction | assignment |
|---|---|---|
| Ledger Voss | rad + **ice** + **gas** | only 3-class extractor — hunt tritium ice |
| Vera Lane | rad | **mining the confirmed thorium at Bunda Belt** |
| Grit Vane | rad + laser III | converge on Bunda Belt thorium |
| Zibal Prospector | rad + laser III | converge on Bunda Belt thorium |
| Bob Comet | rad + laser III | **haul the plutonium to Krynn** (top priority) |
| Nova Reyes | rad | haul energy_crystal + power_cell to Krynn |
| CyberSapper | rad | collect ice harvester @ starfall, then hunt tritium |
| CyberSpock | rad | collect ice harvester @ Krynn, then hunt tritium |
| Cass Margin | rad | funding — sell surplus, gift credits to Morg |
| Juno Freight | rad | funding + haul reserve |
| Morg'Thar | laser I (stationary) | vault keeper + assembly line |

**Thorium source found:** `Bunda / bunda_belt` — richness 15, **446 remaining**
against 444 needed. First confirmed thorium deposit of the campaign; three miners
converging.

---

## 9. Method notes

Scripts live in the session scratchpad: `refresh_ledger.py` (rebuild ledger from
`view_storage`), `audit.py` (chain solver), `manifest.py` (haul list),
`surplus_v2.py` (sellable surplus), `watch.py` (hourly fleet watch),
`probe.py` / `drive.py` (free queries / driven commands).

**Solver correctness traps, all of which bit during this audit:**
- Must skip `wrap_`/`unwrap_` packaging recipes — they consume and produce the same
  item and generate an infinite cycle (first run produced 1,271,435 craft runs and
  a "3.8M iron ore" shortfall before this was fixed).
- Must ban ancestor re-entry along the expansion path (`forge_adamantite` needs
  `neutronium_ingot`, which needs… ).
- Must net stock at **every** level, not just at the leaves, or held intermediates
  get re-expanded into raw ore that we do not actually need.
- Must respect recipe **yields** (`copper_piping` makes 4/run).


---

# ⚠️ MAJOR CORRECTION — 10:45 UTC — THE CHAIN IS FACILITY-GATED

Everything above §4 assumed the neutronium chain was hand-craftable, because
`catalog.recipes[*].facility` is `None` for every step. **The catalog is wrong, or
rather it does not describe reachability.** Dry-running each recipe against the live
engine shows every single step requires a named facility, and **none of them exist
at Krynn / War Citadel**.

This invalidates the "haul everything to Morg at Krynn" strategy. Krynn is the
SHIPYARD (where the ship is commissioned). It is not, and cannot be, the factory.

## Where the chain can actually be run

| step | facility required | nearest public | jumps from Krynn |
|---|---|---|---|
| `concentrate_thorium` | Thorium Ore Crusher | Nova Terra Central (Nova Terra) | 18 |
| `process_thorium` | Thorium Roaster | Starfall Salvage Station (Starfall) | 30 |
| `fabricate_thorium_fuel_rod` | Thorium Rod Foundry | Starfall Salvage Station | 30 |
| `fabricate_fusion_fuel_rod` | Fuel Rod Caster | Nova Terra Central | 18 |
| `breed_plutonium` | Breeder Reactor Core | Nova Terra Central | 18 |
| `refine_weapons_grade_plutonium` | Polonium Doping Cell | **Confederacy Central Command (Sol)** | 19 |
| `assemble_power_core` | Power Core Assembly Line | **Confederacy Central Command (Sol)** | 19 |
| `synthesize_neutronium` | Neutronium Compression Chamber | **Confederacy Central Command (Sol)** | 19 |
| `build_station_reactor_core` | Reactor Core Production Line | **Confederacy Central Command (Sol)** | 19 |
| `build_mass_driver` | Heavy Railgun Assembly Facility | **Confederacy Central Command (Sol)** | 19 |
| `process_tritium_ice` | Tritium Cryo-Extractor | **NONE IN THE GALAXY** | — |
| `synthesize_liquid_tritium` | Neutron Bombardment Cell | **NONE IN THE GALAXY** | — |
| `build_piercing_railgun_ii` | Enhanced Driver Workshop | **NONE IN THE GALAXY** | — |

**Confederacy Central Command in Sol runs five of the back-half steps** — and it is
exactly where Bob Comet's 30 `reactor_grade_plutonium` already sits. All night I was
trying to haul that stack 19 jumps *away* from the only place it can be refined.
**The plutonium should stay in Sol. The work goes to it.**

## The three facilities that do not exist anywhere

Both routes to `liquid_tritium` are blocked, so tritium cannot be processed by
anyone in the galaxy today. We must build one ourselves.

| facility | credits | materials | build time |
|---|---|---|---|
| **Tritium Cryo-Extractor** | 151,000 | steel_plate 2,600 · copper_piping 1,100 · control_node 300 | 130 |
| Neutron Bombardment Cell | 144,000 | steel_plate 2,400 · copper_piping 1,000 · control_node 250 | 240 |
| Enhanced Driver Workshop | 1,125,000 | steel_plate 17,600 · copper_piping 6,800 · control_node 1,700 · weapon_housing 3,150 · barrel_assembly 1,550 | 180 |

Stock check — steel_plate 15,002 ✅ and copper_piping 6,561 ✅ are fine for the
cryo-extractor. **`control_node` is the universal blocker: we hold ZERO.**

`assemble_control_node` = circuit_board 2 + copper_wiring 4 + gold_wiring 1 + silver_wiring 1.
For the 300 needed by the cryo-extractor:

| input | need | have | gap |
|---|---|---|---|
| copper_wiring | 1,200 | 2,664 | ✅ |
| circuit_board | 600 | 115 | 485 (silicon-limited) |
| gold_wiring | 300 | 63 | needs ~950 more gold_ore (hold 241) |
| silver_wiring | 300 | 0 | needs ~1,200 silver_ore (hold 113) |

Gold and silver ore are ordinary `mining`-class uncommons — any laser can pull them.
**That is the new critical path for tritium.**

Note: Morg was already crafting `copper_wiring` ×150 when I interrupted him. He had
likely worked out the control_node requirement himself.

## Revised standing

| line | status |
|---|---|
| thorium_ore | ✅ 726 at Krynn vs 444 — **but must be moved to Nova Terra / Starfall to process** |
| polonium_ore | ✅ 258 vs 23 — **must go to Sol** for the doping cell |
| tritium_ice | 141 of 265 mined — **unprocessable until we build a facility** |
| reactor_grade_plutonium | ✅ 30 vs 23 — **already in Sol, exactly where it is needed** |
| credits | ~1.08M fleet; commission needs 1,808,005, plus ~151,000 for the cryo-extractor |

## What this means

The materials war is essentially won. The remaining problem is **industrial
geography**, not mining. Three decisions are now yours:

1. **Move the operation to Sol** (five facilities, plus the plutonium is already
   there), running thorium processing through Nova Terra/Starfall en route — versus
   building our own facilities at Krynn.
2. **Build the Tritium Cryo-Extractor** (151,000 cr). This is unavoidable for the
   tritium route; nobody in the galaxy can process tritium ice. Gated on 300
   control_node → ~1,200 silver_ore + ~950 gold_ore of mining.
3. **`piercing_railgun_ii` ×2** needs an Enhanced Driver Workshop at 1,125,000 cr
   plus 3,150 weapon_housing (we hold 108) and 1,550 barrel_assembly (we hold 0).
   That is a far bigger project than the ship itself. Buying the two finished
   railguns from another player is almost certainly cheaper — worth a market sweep
   before committing.

**Your instinct months ago to build the Enhanced Driver Workshop was right.** It is
not optional flavour — it is one of only three ways to finish this hull, and the
other two are also facilities nobody has built.
