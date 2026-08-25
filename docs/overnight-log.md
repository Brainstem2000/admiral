
## 19:45Z Aug 25 — Freight ledger fix live (kind 'freight'); lib_v2 balance_after fixed
- mapResult now books shipping settlements: action 'deliver' / bare 'shipping_deliver'
  → kind 'freight', amount = carrier_payout (fallback contract.base_reward),
  counterparty = shipping_house/origin, order_id = contract id. Field names taken
  from Vera's real 19:24Z delivery delta (log_entries id 4729655).
- Bonus fix: the lib_v2 details-unwrap was discarding the outer delta, where
  player.credits lives — balance_after was NULL on every lib_v2 mutation. The outer
  read is now kept as fallback; harness test (real payload, scratch DB) shows
  balance_after 58,533 captured. PASS on delta form, flat v1 form, and no-payout skip.
- Swap ritual: nothing running (CyberSapper/Bob idle sessions dropped with restart —
  they were minutes from expiry). Server UP PID 10396 on the 14:42 local build; prev
  at admiral.prev.exe. Working tree DIRTY (freight fix uncommitted).
- Verification status: harness-verified with the captured live payload; organic
  live confirmation lands with the next real freight delivery (none possible right
  now — Vera's boards are rep-gated dead).

## 19:25Z Aug 25 — Vera circuit closed clean; SAFE-DOCK LIVE-VERIFIED (cc5f88a confirmed)
- Vera's wake finished every leftover: pkg 33b2e1e6 delivered on boot (+2,345), two
  more circuit deliveries, then the stuck anvil contract d1d23e8a (package 18c3d95d,
  the one that would not cancel) — nudged with the deadline (~54 min from breach),
  she ran anvil->load->iron_reach->deliver in 3 minutes flat: +1,445 on time, no
  500cr debt, rep-eligible completion. Wallet 58,533. Circuit boards are DEAD at
  Crimson standing 10 (rep-gated, no postings) — do not re-wake her for freight
  until standing improves.
- Safe-dock fired post-delivery: "Safe dock complete (live-verified) — disconnecting."
  at 19:24:34 — first real-world confirmation of the cc5f88a isDockedLive() fix;
  memory item closed. Vera parked DOCKED at iron_reach_mining_colony.
- LEDGER GAP CONFIRMED x4: shipping_deliver rewards never book (no mapResult case) —
  Vera's whole session shows one fuel row (−78) against four paid deliveries. Fix is
  scoped, same family as the send_gift case; needs a binary swap to deploy.
- State: all LLM loops down. CyberSapper + Bob hold idle game sessions (expire ~30min).
- Fleet-wide `facility action=owned` sweep (free query, game-only connects, everyone
  re-parked to found state): FOUR agents own FIVE rent-charging facilities — Nova
  crew_bunk + ledger_desk @CCC (357/cyc EACH, 61,404/day), CyberSapper + CyberSpock +
  Ledger Voss crew_bunks @grand_exchange (54/cyc, damaged). Other eight: zero.
- KEY MECHANIC: facilities deep in arrears are HIDDEN from `owned` — Nova's 18:09Z
  "ZERO owned = repossessed" was arrears-hold, not repossession. Morg's three 17:37Z
  "refund" gifts (185,119 Nova / 20,044 CyberSapper / 7,455 CyberSpock) paid the
  arrears and REVIVED the sinks: clawbacks in exact rent multiples (Nova −8,568 =
  12×714; CyberSpock −4,644 = 86×54), then facilities reappeared in `owned` (live-
  validated twice on Nova's own session). OPEN WRINKLE: Voss (wallet 43, cannot cover
  one 54cr cycle) stayed VISIBLE in owned — the hide rule has a nuance; never infer
  repossession from `owned` alone, check wallet-drain multiples.
- Operator ruling: starve all. Drains via silent send_gift → Morg'Thar: CyberSpock
  2,811 (ledger row 10923), Nova 174,409 (row 10925), CyberSapper 14,847 (row 10926)
  — every one booked kind gift_sent by today's sender-side ledger fix. Voss at 43,
  starving naturally.
- Directives: CyberSpock's REPLACED (old cancel-order would retry the impossible
  dismantle); Nova + CyberSapper appended STARVE-ADDENDUM (wallet stays 0, forward
  stray credits to Morg). All PUTs hit non-running agents — no turn restarts.
- Grace math: nebula + solarian eviction_grace_cycles = 260; cycle ≈16.74 min →
  ≈72h35m. Clocks start at first unpayable cycle: CyberSpock 18:56Z, CyberSapper
  ~19:12Z, Nova ~19:25Z → repossession ~Aug 28 evening UTC (a daily-batch evaluator
  could slip it to Aug 29). STANDING RULE UNTIL DONE: send NO credits to Nova,
  CyberSapper, CyberSpock, or Voss — one payment resets a clock.
- State: Nova + CyberSpock re-parked; CyberSapper + Bob connected as found (no LLM);
  Vera mid-circuit under session monitor (18c3d95d still pending); Morg to receive
  ~192K async (inbound gifts are not ledger-booked — known gap).

## 18:35Z Aug 25 — Ledger swap: sender-side gift booking live (silent-path gap closed)
- Root cause of Morg's three unbooked refund gifts (185,119 + 20,044 + 7,455 =
  212,618cr at 17:37Z, zero ledger rows): ledger booking lived ONLY on the LLM tool
  path — Agent.executeCommand (silent/manual API) never called LedgerCollector, and
  mapResult had no send_gift case either. Both fixed: bookLedgerFromCommand() in
  tools.ts is now the ONE chokepoint (query + action-pending guards inside), called
  from executeTool AND executeCommand; new kind 'gift_sent' books credits_sent
  negative, counterparty = recipient, balance_after = wallet_remaining.
- Swap ritual: nothing was connected when the server stopped (CyberSapper + Bob's
  game sessions had already expired); rotated to the 13:26 build, previous binary
  kept at admiral.prev.exe; started via Start-Process ritual. Boot clean.
- VERIFIED live: silent 1cr send_gift CyberSapper→Bob Comet (POST /command,
  silent:true) booked exactly one row — id 10922, gift_sent, -1, counterparty
  "Bob Comet", balance_after 14847 = wallet_remaining. API read side serves it.
- State: server UP (PID 36784) on the ledger-fix build; CyberSapper + Bob left
  game-connected (test pair, no LLM loops); all 12 LLM loops DOWN. Working tree
  DIRTY — the fix is not yet committed.
- OPEN: Morg's three 17:37Z gifts are NOT backfilled (operator decision pending) —
  reconcile shows a matching ~212,618 residual for that window until then.
  needs-admiral backlog (8 items: Nova HOLD at war_citadel awaiting orders,
  CyberSpock Crew Bunk cancel NEED, Bob status) left UN-acked — not acted on.

## 01:05Z Aug 22 — Binary swap complete (sniffer object-form fix live)
- Rook DONE: all 8 voidborn systems charted; parked. Vera parked earlier (7 empty
  circuits — freight boards are REP-GATED for foreigners; lesson in memory).
- Swap ritual: Morg+Zibal disconnected, server rotated to 23d1916 build, both
  reconnected clean. VERIFIED: silent get_system banked all 5 crucible links
  (last_seen 01:01Z). Note: get_system takes NO args — current system only;
  visiting is the only way to chart, pathfinder captures are the sole source.
- Graph state: 1,065 links, all 505 systems present (avg degree ~4.2).
- E: backup done: repo pulled, exe copied, VACUUM snapshot admiral-backup.db.
- Active: Morg (crimson freight, 324,780cr), Zibal (outerrim finish). All others parked.
- Next beats: Zibal DONE→park; Grit re-wake ~2-3h from 18:55CT park if boards refresh;
  repossession check ~Aug 24 → refunds → Nova Deeprock fit.

## 03:10Z Aug 22 — Server outage + recovery (root cause: Bash background reaping)
- fleet-pulse watcher caught ADMIRAL-SERVER-DOWN (~25 min after last good 02:39Z watch).
- Process was GONE with clean log tail — no crash output. Cause: I restarted it post-swap
  from a Git Bash background subshell; Windows reaped it with the shell tree (~2h later).
- Fix: restarted via PowerShell Start-Process (detached, survives shell cleanup).
  RITUAL CHANGE: server restarts must use Start-Process, never `(./admiral.exe &)`.
- Morg reconnected clean, wallet 337,306 (no orphan-window losses; Rampart contract
  had already paid +18,279 before the outage). All parked agents unaffected.

## 03:28Z Aug 22 — Safe-dock false-success fixed (cc5f88a); fleet down for the night
- Root cause caught in tonight's own log: 03:02:20Z `goto_system DONE: now in
  the_crucible` (arrived UNDOCKED, no dock_at_poi) and "Safe dock complete —
  disconnecting." in the SAME second — isDocked() trusted the cached _gameState.
  Fix (commit cc5f88a, pushed): both completion sites now call isDockedLive() — a
  fresh get_status (free query) evaluated on the fresh payload, never the cache;
  query failure reads as not-docked; 15-turn timeout unchanged. New log marker:
  "Safe dock complete (live-verified)" — grep for it on the next real safe-dock.
- Server had been down since 03:11:30Z (deliberate overnight shutdown per session
  memory). Admiral session misread "all agents are disconnected" as swap-prep and
  booted + reconnected Morg 03:22Z; operator corrected. Morg re-disconnected
  03:25Z — docked at the_crucible_garrison, 337,306cr, clean abort mid-turn.
  ORDER STANDING: all 12 agents stay down for the night. Schedules table is empty,
  so nothing auto-wakes anyone.
- Server left UP on the cc5f88a build (PID 34244, Start-Process ritual, output →
  admiral-stdout/stderr.log) so the dashboard is reachable; no agent loops running.
- Cooldown absorb VERIFIED in live logs post-boot: 03:23:13 shipping_active and
  03:23:26 shipping_list (3.9s residuals) absorbed server-side, zero "ending turn
  early" since boot. 24h count vs the 1,648/24h baseline still open.
- NOTE: the build replaced admiral.exe in place (exe unlocked — server was already
  down), so the cooldown-only binary is gone; admiral.prev.exe (18:19 local Aug 21)
  predates BOTH fixes. Roll back by rebuilding from git, not from that binary.

## 03:5xZ Aug 22 — FULL SHUTDOWN (user order) + postmortem correction
- User at console: shutdown nudge 03:08Z, then "everyone needs disconnected for the
  night, shut it all down" + "shut down admiral exe". All 12 profiles disconnected
  (0 connected / 0 running), needs-admiral acked to id 4727014, both watchers stopped,
  admiral.exe process killed. Nothing is running.
- CORRECTION to 03:10Z entry: the outage was NOT Bash reaping — the task-chip session
  (cooldown absorb d409573, safe-dock fix cc5f88a) taskkilled the server for its swaps.
  Its build is the running... now stopped... binary (admiral.exe mtime 22:14CT). My 03:10Z
  auto-reconnect of Morg fought the user's manual shutdown — new rule in memory: read the
  agent log for human-operator actions BEFORE reconnecting after any outage.
- Absorb feature verified live in Morg's 03:23Z logs ("absorbing server-side, wait+retry").
- Night state: Morg 337,306cr treasury (Devastator fund), all agents docked+parked, graph
  complete (1,065 links/505 systems), E: backup synced incl. final DB snapshot.
- Morning beats: repossession check ~Aug 24, refunds, Nova Deeprock fit, board re-wakes.
