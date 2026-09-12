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
