/**
 * bun test preload (bunfig.toml): every test that imports db.ts IN the test
 * process opens a throwaway database instead of data/admiral.db. Subprocess
 * helpers are not affected — they chdir into their own temp workspace and this
 * global does not cross a process boundary. See the DB_DIR note in db.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-test-data-'))
;(globalThis as { __ADMIRAL_DATA_DIR?: string }).__ADMIRAL_DATA_DIR = dir
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })

/**
 * Macro pacing is real wall-clock time in production — the game's combat tick is
 * ~10s and actions are rate-limited — but a test has no server to stay in step
 * with. Left alone, tests wait those ticks for real: hunt-here-macro.test.ts
 * took 572 SECONDS on its own, printing nothing and sitting at 0% CPU, which
 * reads as a hang rather than a slow file.
 *
 * macroSleep in tools.ts caps itself against this global, so every await still
 * happens in the same order — only the duration collapses. Only tests set it.
 */
;(globalThis as { __ADMIRAL_MAX_MACRO_SLEEP_MS?: number }).__ADMIRAL_MAX_MACRO_SLEEP_MS = 1
