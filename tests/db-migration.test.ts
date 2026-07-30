import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex persistence migration', () => {
  test('keeps Claude settings, histories Admiral state, and separates role threads', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admiral-codex-test-'))
    tempDirectories.push(directory)
    const helper = path.join(import.meta.dir, 'helpers', 'db-migration-check.ts')
    const child = Bun.spawn([process.execPath, helper, directory], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.saved).toEqual({
      provider: 'claude-max',
      model: 'claude-sonnet-4-5',
      planner_provider: 'claude-max',
      planner_model: 'claude-opus-4-8',
      codex_executor_enabled: 1,
    })
    expect(result.history.sort((a: { field: string }, b: { field: string }) => a.field.localeCompare(b.field))).toEqual([
      { field: 'directive', value: 'Original directive' },
      { field: 'memory', value: 'Original memory' },
      { field: 'todo', value: 'Original TODO' },
    ])
    expect(result.plannerThread).toBe('thread-planner')
    expect(result.executorThread).toBe('thread-executor')
  })
})
