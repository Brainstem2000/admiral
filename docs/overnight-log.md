
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
