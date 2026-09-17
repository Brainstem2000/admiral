#!/usr/bin/env bash
# Decision-threshold fleet watch. Emits ONLY lines that change what the Admiral does next.
#
# Written 2026-09-16 after a chattier watcher produced 30 of 34 events from routine agent
# HALT traffic, waking a full LLM turn each time for things already handled. The shell loop
# is free; every emitted line costs a turn, so the filter is the whole design.
#
# Re-arm from a fresh session with:
#   Monitor({ command: "bash /Users/brian/dev/admiral/scripts/watch-thresholds.sh",
#             description: "fleet decision thresholds", persistent: true, timeout_ms: 3600000 })
cd "$(dirname "$0")/.." || exit 1
DB=data/admiral.db
NODES_GATE=${NODES_GATE:-250}
TREASURY_FLOOR=${TREASURY_FLOOR:-250000}
fired_nodes=0; fired_treasury=0; prev_down=""
prev_facs=$(sqlite3 "$DB" "SELECT COUNT(*) FROM fleet_intel_facilities WHERE faction_owned=1;" 2>/dev/null || echo 0)
arm_nodes=$(sqlite3 "$DB" "SELECT CAST((SELECT COALESCE(SUM(quantity),0) FROM faction_storage_inventory WHERE item_id='control_node') AS INTEGER);" 2>/dev/null || echo 0)
arm_treas=$(sqlite3 "$DB" "SELECT credits FROM faction_treasury_snapshots ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo 0)
# This line fires once per arming and is the only guaranteed emission, so make it a real
# heartbeat: live figures, not the boilerplate it used to repeat every 30 minutes.
echo "WATCH ARMED: nodes ${arm_nodes}/${NODES_GATE} | treasury ${arm_treas} (floor ${TREASURY_FLOOR}) | ${prev_facs} faction facilities"
while true; do
  sleep "${POLL:-300}"
  # Gate on the FACTION VAULT only. facility action=faction_build draws from faction
  # storage at the station, then cargo — it NEVER sees a personal locker. Counting
  # personal stock too read 432 when only 202 were buildable, which would have
  # announced an open gate 48 nodes early. Measure what the consumer can actually reach.
  nodes=$(sqlite3 "$DB" "SELECT CAST((SELECT COALESCE(SUM(quantity),0) FROM faction_storage_inventory WHERE item_id='control_node') AS INTEGER);" 2>/dev/null || echo 0)
  if [ "$fired_nodes" -eq 0 ] && [ "${nodes:-0}" -ge "$NODES_GATE" ]; then
    echo "BUILD GATE OPEN: control_node ${nodes} >= ${NODES_GATE} - plasma_injector_assembly is buildable"
    fired_nodes=1
  fi
  facs=$(sqlite3 "$DB" "SELECT COUNT(*) FROM fleet_intel_facilities WHERE faction_owned=1;" 2>/dev/null || echo "$prev_facs")
  if [ "${facs:-0}" -gt "${prev_facs:-0}" ]; then
    newest=$(sqlite3 "$DB" "SELECT facility_type||' at '||station_id FROM fleet_intel_facilities WHERE faction_owned=1 ORDER BY last_seen DESC LIMIT 1;" 2>/dev/null)
    echo "FACILITY BUILT: ${newest} (faction facilities now ${facs}) - rent bill changes"
    prev_facs=$facs
  fi
  treas=$(sqlite3 "$DB" "SELECT credits FROM faction_treasury_snapshots ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo 999999)
  if [ "$fired_treasury" -eq 0 ] && [ "${treas:-999999}" -lt "$TREASURY_FLOOR" ]; then
    echo "TREASURY LOW: ${treas} below ${TREASURY_FLOOR} - rent 55,642/day, facilities repossess after the grace period"
    fired_treasury=1
  fi
  down=$(sqlite3 "$DB" "SELECT GROUP_CONCAT(name,', ') FROM profiles WHERE enabled=1 AND id NOT IN (SELECT DISTINCT profile_id FROM log_entries WHERE timestamp > datetime('now','-25 minutes'));" 2>/dev/null)
  if [ -n "$down" ] && [ "$down" != "$prev_down" ]; then
    echo "AGENTS SILENT >25min: ${down}"
    prev_down="$down"
  fi
done
