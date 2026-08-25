
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
