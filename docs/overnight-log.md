
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
