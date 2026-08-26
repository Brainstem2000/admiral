# macOS setup — running Admiral on the MacBook

Written 2026-08-26 for the first Mac deployment. The repo is portable (Bun +
bun:sqlite, no Windows-only APIs); the only overlay needed is the database.

## The one rule that matters

**Run ONE Admiral at a time against the live game.** Even with every agent
parked, the server's offline-wallet refresher game-connects each credentialed
profile every 20 minutes — two servers fight over game sessions and invalidate
each other's logins. The Windows server (C:\dev\admiral on host CyberSapper)
was confirmed STOPPED when this doc was written; leave it stopped while the Mac
instance runs, and vice versa.

## Setup

```bash
# 1. Bun (skip if installed — check: bun --version)
curl -fsSL https://bun.sh/install | bash

# 2. Clone + deps
git clone https://github.com/Brainstem2000/admiral.git ~/dev/admiral
cd ~/dev/admiral
bun install

# 3. Database overlay — the populated live DB travels via OneDrive.
#    Find your OneDrive root (name varies):  ls ~/Library/CloudStorage/
#    The file is  <OneDrive root>/Claude-Code-Projects/admiral/data/admiral-backup.db
#    (~198 MB — let OneDrive finish syncing; check its cloud/local status first)
mkdir -p data
cp "$HOME/Library/CloudStorage/OneDrive-BWCLabs/Claude-Code-Projects/admiral/data/admiral-backup.db" data/admiral.db
```

Snapshot provenance: VACUUM'd from the live Windows DB 2026-08-26 ~14:26Z —
schema v5, all 12 profiles, wallet/facility state through the bunk-repossession
refunds. It contains **plaintext agent credentials and provider API keys**;
it stays on this machine and inside the private OneDrive, nowhere else.

## Run

**For testing agents (recommended): dev mode** — hot reload, no compile step:

```bash
bun run dev
```

UI at http://localhost:3030 (Vite) with the API on :3031.

**Or the compiled binary** (what production-style use looks like):

```bash
bun run build
./admiral
```

UI at http://127.0.0.1:3031. The `dist/` directory must sit beside the binary
(the build script arranges this). On macOS the binary is `./admiral`, not
`admiral.exe`; a locally-compiled binary needs no Gatekeeper exception.

## First-boot expectations

- The schema auto-migrates on start; the snapshot is already at v5 so boot logs
  should show no `[DB] migration` lines. `[Intel] stations backfill touched N
  systems` and a `[Prune] ...` line are normal.
- All agents are parked (disconnected) in the snapshot — connect from the UI.
  A game-only connect is free; `connect_llm` starts the paid loop.
- Catalog and OpenAPI caches refetch on their own (`data/.cache/`,
  `data/openapi-cache-*.json` — both gitignored, neither transferred).
- `bun scripts/db-doctor.ts` should report CLEAN — a good smoke test that the
  overlay worked.
- Ops scripts work unchanged: `bun scripts/needs-admiral.ts --catchup` first,
  per CLAUDE.md.

## Bringing changes back

Commit/push from whichever machine did the work; the other pulls. The DATABASE
does not merge — whichever machine last ran agents holds the truth, and the
other side must take a fresh snapshot before running again. When switching
machines: stop the server, `VACUUM INTO` a snapshot onto OneDrive, start on the
other side from that snapshot (see `e-drive-backup-ritual` in session memory,
and the snapshot command in CLAUDE.md's verification section).

## Environment variables

Only one secret matters, and only for lib_v2-mode profiles (currently Grit):
`SPACEMOLT_CLERK_API_KEY` — read by src/server/lib/connections/lib_v2.ts and the
connect gate in agent.ts. Every http_v2 agent authenticates with the passwords
stored in the DB; no env vars needed for them.

Set it in a `.env` file at the repo root (gitignored — never commit it; move the
value from the Windows user env var via a password manager, not the repo):

```bash
printf 'SPACEMOLT_CLERK_API_KEY=<value>\n' > .env
```

Bun auto-loads `.env` for `bun run dev` and `bun scripts/*.ts`. The COMPILED
binary does not — for `./admiral`, export it in ~/.zshrc or launch with
`set -a; source .env; set +a; ./admiral`.

Optional knobs, defaults fine: PORT (3031), ADMIRAL_HOST (127.0.0.1 — set
0.0.0.0 only to expose on the LAN), CODEX_ACCESS_TOKEN + ADMIRAL_CODEX_* (codex
executor roles only), YARD_TIER (ship-match script).
