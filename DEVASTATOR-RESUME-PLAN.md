# Crimson Devastator — Resume Plan

**Shut down:** 2026-07-31 ~03:30 UTC (2026-07-30 ~10:30 PM local)
**Resume:** Wednesday (user out of tokens until then)
**Mission:** complete the Crimson Devastator build. Every agent's work ladders to that.

---

## 1. Where the build actually stands

**14 of 17 BoM lines are complete in the vault.** The BoM is 17 lines, read from
`catalog.json → ships.crimson_devastator.build_materials` (live catalog, v0.549.1).
Never hand-maintain it — re-read it.

| open line | vault | need | short | path |
|---|---|---|---|---|
| `targeting_computer` | 57 | 70 | 13 | **closable now** — see §2 |
| `neutronium_ingot` | 0 | 18 | 18 | the campaign's one real blocker — §3 |
| `station_reactor_core` | 1 | 2 | 1 | rides the neutronium line (needs neutronium ×5) |

Fleet cash ~1.84M = **118% of the 1,558,352 yard fee**. Cash is *not* the
constraint and has not been for some time. Material is.

### Corrections that cost this campaign weeks — do not re-inherit them
- **BoM is 17 lines, not 24.** `mass_driver`, `piercing_railgun_ii`, `railgun_ii`
  are `default_modules` — the loadout the ship ships with, never build inputs.
  The "uncraftable railgun blocker" was chasing something never required.
- **Steel was never a bottleneck.** Fleet holds **12,233 `steel_plate`** (Spock
  alone has 9,292 at Frontier Station). The old "~450 steel short" was a
  vault-only view mistaken for a fleet view.
- **`durasteel_plate` is 432 against a target of 80** — and also covers the 69
  needed for neutronium synthesis.
- **`armor_plate_i` ≠ `armor_plate`.** The former is a ship module and is legal
  to sell; the latter is the BoM component.

---

## 2. First action on resume — close `targeting_computer`

This is the only line that closes without solving neutronium, and it is blocked
on **one haul**.

Nova (`377a51c2…`, 640-cargo Caravan) has **`circuit_board` ×300 and
`silicon_ore` ×90 sitting in her own storage at `cargo_lanes_freight_depot`**.

1. Nova: `goto_system(cargo_lanes, dock_at_poi=cargo_lanes_freight_depot)`
2. Withdraw `circuit_board` ×300 + `silicon_ore` ×90
3. `goto_system(krynn, dock_at_poi=war_citadel)`, deposit
4. Craft at the **War Citadel workshop** (verified by dry-run, no travel needed):
   - `build_processing_core` ×5 = `circuit_board` ×5 + `platinum_ore` ×2 + `silicon_ore` ×3 each
   - `build_targeting_computer` ×10 = `circuit_board` ×4 + `processing_core` ×1 + `focused_crystal` ×1 each
5. `focused_crystal` (111) and `platinum_ore` (2,133) are **already at the citadel**.

> **Nudge discipline:** Nova stalled ~20 min because a sequenced order was split
> across two nudges — she read the follow-up "hold at war_citadel" as current and
> went to standby. Put the whole ordered sequence in ONE message, with numbered
> steps and an explicit "do not stand by".

---

## 3. The one real blocker — neutronium

Need **23 `weapons_grade_plutonium`** (18 for the BoM line + 5 consumed by the
second `station_reactor_core`).

```
neutronium_ingot  = weapons_grade_plutonium ×1 + durasteel_plate ×3 + power_core ×2
weapons_grade_plutonium = reactor_grade_plutonium ×1 + polonium_ore ×1
```

**Nobody in the galaxy sells any part of this chain.** Verified at both War
Citadel and Grand Exchange: `polonium_ore`, `uranium_ore`, `thorium_ore`, both
concentrates, `weapons_grade_plutonium`, `fusion_fuel_rod` all read `sell=0`.
Buy orders exist; supply does not. **It gets mined or the build stops.**

### Raw requirement (concentrate ratio is 6 ore → 2 concentrate = 3:1)

| material | need | held | status |
|---|---|---|---|
| `uranium_ore` | 2,208 | 14 | obtainable, need volume |
| `thorium_ore` | 1,380 | 90 | obtainable, need volume |
| `fluorine_gas` | 368 | **0** | RAW, mine-only, **no source located** |
| `polonium_ore` | 23 | **0** | RAW, mine-only, **no source, no substitute** |
| `nitrogen_ice` | 230 | 616 | ✅ already covered |

~3,979 units of raw ore total.

### Public facilities (confirmed by engine dry-run, jumps from Krynn)
- `synthesize_neutronium` + `refine_weapons_grade_plutonium` → **Confederacy
  Central Command (Sol)**, 19 jumps — *both at one station*
- `breed_plutonium` → Nova Terra Central, 18 jumps
- `enrich_uranium_low` → The Obsidian Well (Arneb), 6 jumps

Building our own is not viable (the level-4 facilities run 3.3M–24M each).

### Deferred: `power_core` ×37
Second chain, **user decision: investigate but do not action until plutonium is
solved.** It needs `fusion_fuel_rod` ×74 → `liquid_tritium` ×148 → **~370
`tritium_ice`** (held: 0), plus ~888 *more* thorium ore. Already covered:
`helium_3` 36/37, `power_battery` 173, `energy_crystal` 76/74.

---

## 4. Operation Deep Vein (running when we stopped)

All 11 agents briefed with this target list. **Dry cycle 1 at 03:24 UTC — no
Tier-1 finds.**

- **Tier 1** (zero held, no known source): `polonium_ore` ← highest value find in
  the game right now, `fluorine_gas`, `tritium_ice`, `deuterium_ice`
- **Tier 2** (confirmed obtainable, need volume): `uranium_ore`, `thorium_ore`
- **Already covered, do not spend time:** nitrogen_ice 616, argon_gas 10,672,
  power_battery 173, energy_crystal 76, steel/durasteel surplus

**Key mechanic:** deposits sit at **hidden POIs**, revealed only by
`survey_system()`, whose power scales with the **`scanning`** skill. Scanning
trains from *"Query POI details or survey systems"* — so **`get_poi()` is a FREE
query that grants scanning XP at zero tick cost.** Fleet-wide standing habit:
`get_poi()` on arrival at every POI.

Scanning levels: **Morg 12/100 (lead surveyor)**, Ledger 4, Grit 3. Only those
three have Survey Scanner I fitted.

**Unfinished work — the highest-leverage next move after §2:** craft more survey
scanners. Materials are already held and both craft with `facility_only=None`:
- `survey_scanner_i` = `sensor_array` ×1 + `circuit_board` ×2 + `focused_crystal` ×2
  → have sensor_array 5, circuit_board 315, focused_crystal 246 → **5 buildable now**.
  Scanners are **not sold** at either hub; crafting is the only route.
- `lead_lined_cargo_i` = `lead_sheet` ×8 + `steel_plate` ×6 + `flex_polymer` ×4 +
  `circuit_board` ×2 — **required to transport refined radioactive material**.
  Have steel_plate 12,233, flex_polymer 123, lead_ore 169 (smelt → roll to sheet).
  Spock already has one → designated radioactive hauler.

Nova cannot take a scanner — her three utility slots are full (2× Cargo Expander
+ Mining Laser) and her 640 cargo is worth more as bulk hauler.

---

## 5. Standing user decisions (2026-07-31) — do not re-litigate

| topic | decision |
|---|---|
| polonium | **Keep prospecting, no time limit.** Never commission short; never drop the reactor-core line. |
| traders | Cass, Juno, Vera **converted to ore haulers**. Cass's pure-trader charter is revoked by owner order. |
| surplus | **Freeze all BoM-category material** until commissioned. No sales, surplus or not. |
| Nova | Central ore ferry. Hold at citadel; do **not** send to CCC yet (nothing to refine there). |
| push trigger | **Started immediately** — ore need is independent of the polonium search. |
| yard fee | Consolidate to Morg **only at commission time**; leave cash distributed so agents self-fund. |
| Spock | Rebuild order **stays live** — further off-tether drift → `spock_rebuild.py`. |
| power_core | Investigate, but action only after plutonium is solved. |
| 11th agent | Recruited (see §6). |
| autonomy | Full, including code changes. (Expired with this session — reconfirm on resume.) |

---

## 6. Fleet roster — 11 active + 1 dormant

Three characters share the `VeraLane` stem. **Always disambiguate by `player_id`
— transfers target by username and a mistarget would silently misroute material.**

| agent | in-game | player_id | note |
|---|---|---|---|
| Nova Reyes | `Nova Reyes` | `c19ff0fb…` | 640-cargo Caravan, bulk hauler, Codex-routed |
| Ledger Voss | `Ledger Voss` | — | Survey Scanner, off the steel loop |
| Morg'Thar | `Morg'Thar` | — | **vault keeper + commissioning agent + lead surveyor** (scanning 12) |
| Bob Comet | `Bob Comet` | — | holds thorium_ore 85 @ nova_terra_central |
| CyberSapper | `CyberSapper` | — | steel_plate 9,292 @ frontier_station |
| CyberSpock | `CyberSpock` | — | **only Lead Lined Cargo I** → radioactive hauler; drift-prone |
| Grit Vane | `Grit Vane` | — | Survey Scanner, gas specialist (argon 10,672) |
| Cass Margin | `CassMargin` | — | converted to ore hauler |
| Juno Freight | `JunoFreight` | — | converted to ore hauler |
| Vera Lane | `VeraLane_Nebula` | `3a5120da…` | converted to ore hauler |
| Zibal Prospector | `VeraLane_Zibal` | `554de4e1…` | 11th agent, ship **"Deep Vein"**, self-funding |
| *[RESERVE] dormant* | `VeraLane` | `d23d1b12…` | profile `9cc6b6d1…`, `enabled=0`. **Do not activate without need.** |

The vault = **Morg's PERSONAL storage at `crimson_war_citadel`**. Other agents
also have personal storage at that station — that is *not* the vault. Summing
station-wide overstates it.

---

## 7. Operational gotchas learned the hard way

- **Password change requires a full server restart.** `connect_llm` on an
  already-connected agent does not re-login; the Agent object keeps serving the
  cached credential.
- **`POST /api/profiles` silently ignores `enabled:false` / `autoconnect:false`.**
  Set them with a follow-up `PUT`, or a "dormant" account auto-starts on restart.
- **Server restarts must use `scratchpad/start_admiral.py`** — it injects
  `SPACEMOLT_CLERK_API_KEY`, `CODEX_ACCESS_TOKEN`, `ADMIRAL_CODEX_BIN` from the
  HKCU registry. A hand-rolled launcher silently breaks the Codex-routed agents.
- **`view_storage` is free and accepts `station_id`** — works undocked, costs no
  tick, and auto-populates the DB ledger.
- **Sell quotas go stale.** All BoM-line quotas were zeroed on 2026-07-31; the
  worst was 14 units of `reinforced_bulkhead` quota against a line holding
  exactly 3.

### Use the DB ledger, never agent memory, for "what do we own and where"
```bash
curl -s http://127.0.0.1:3031/api/inventory/item/polonium_ore
```
`/api/inventory` · `/item/:itemId` · `/profile/:id` · `/ships` · `/stale?hours=N`.
Re-seed any time with `seed_ledger.py` (free queries, safe to re-run).

---

## 8. Resume checklist

1. `cd C:\dev\admiral` — **this is the live tree**, not the OneDrive path.
2. `python <scratchpad>/start_admiral.py` (brings up server + reconnects all 11).
3. Re-seed the ledger: `python seed_ledger.py`.
4. Verify BoM against the **live** catalog, not this document.
5. **Nova's haul (§2)** — closes `targeting_computer` → 15/17.
6. Craft 5 survey scanners (§4) and fit them; that is the real constraint on the
   polonium hunt.
7. Resume Operation Deep Vein; reconfirm the autonomy grant.

State file with full history:
`<scratchpad>/fleet-watch-state-v2.json` → `resume_brief`, `decisions_2026_07_31`.
