/**
 * Lightweight cron scheduler for agent automation.
 * Evaluates cron expressions and fires connect/disconnect actions on schedule.
 * No external dependencies — uses simple cron field matching.
 */
import { listSchedules, updateScheduleRun, type Schedule } from './db'
import { agentManager } from './agent-manager'
import { addLogEntry, getProfile } from './db'

const TICK_INTERVAL = 30_000 // Check every 30 seconds

/**
 * Parse a 5-field cron expression: minute hour dayOfMonth month dayOfWeek
 * Supports: *, numbers, ranges (1-5), lists (1,3,5), steps (e.g. star/5)
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2]) : 1
    const range = stepMatch ? stepMatch[1] : part

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i)
    } else {
      const rangeMatch = range.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1])
        const end = parseInt(rangeMatch[2])
        for (let i = start; i <= end; i += step) values.add(i)
      } else {
        values.add(parseInt(range))
      }
    }
  }

  return values
}

function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [minF, hourF, domF, monF, dowF] = parts
  const minute = parseCronField(minF, 0, 59)
  const hour = parseCronField(hourF, 0, 23)
  const dom = parseCronField(domF, 1, 31)
  const month = parseCronField(monF, 1, 12)
  const dow = parseCronField(dowF, 0, 6)

  return minute.has(date.getMinutes()) &&
    hour.has(date.getHours()) &&
    dom.has(date.getDate()) &&
    month.has(date.getMonth() + 1) &&
    dow.has(date.getDay())
}

/**
 * Compute the next matching time for a cron expression.
 * Scans forward minute by minute from the given start time, up to 7 days.
 */
export function nextCronTime(cron: string, from: Date = new Date()): Date | null {
  const check = new Date(from)
  check.setSeconds(0, 0)
  check.setMinutes(check.getMinutes() + 1)

  const maxIterations = 7 * 24 * 60 // 7 days of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(cron, check)) return check
    check.setMinutes(check.getMinutes() + 1)
  }
  return null
}

async function executeSchedule(schedule: Schedule): Promise<void> {
  const profile = getProfile(schedule.profile_id)
  if (!profile) return

  const now = new Date().toISOString()
  const nextRun = nextCronTime(schedule.cron)
  updateScheduleRun(schedule.id, now, nextRun?.toISOString() ?? null)

  if (schedule.action === 'connect_llm') {
    addLogEntry(profile.id, 'system', `[Scheduler] Starting agent (schedule: ${schedule.cron})`)
    try {
      let agent = agentManager.getAgent(profile.id)
      if (!agent || !agent.isConnected) {
        agent = await agentManager.connect(profile.id)
      }
      if (profile.provider && profile.provider !== 'manual' && profile.model) {
        await agentManager.startLLM(profile.id)
      }

      // If duration_hours is set, schedule auto-disconnect
      if (schedule.duration_hours && schedule.duration_hours > 0) {
        const durationMs = schedule.duration_hours * 3600_000
        setTimeout(async () => {
          const current = agentManager.getAgent(profile.id)
          if (current?.isRunning) {
            addLogEntry(profile.id, 'system', `[Scheduler] Session duration ${schedule.duration_hours}h reached, disconnecting`)
            await agentManager.disconnect(profile.id)
          }
        }, durationMs)
      }
    } catch (err) {
      addLogEntry(profile.id, 'error', `[Scheduler] Failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (schedule.action === 'disconnect') {
    addLogEntry(profile.id, 'system', `[Scheduler] Stopping agent (schedule: ${schedule.cron})`)
    try {
      await agentManager.disconnect(profile.id)
    } catch (err) {
      addLogEntry(profile.id, 'error', `[Scheduler] Failed to stop: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function tick(): void {
  const now = new Date()
  const schedules = listSchedules()

  for (const schedule of schedules) {
    if (!schedule.enabled) continue
    if (!schedule.next_run_at) {
      // First run — compute next
      const next = nextCronTime(schedule.cron, now)
      if (next) {
        updateScheduleRun(schedule.id, schedule.last_run_at ?? '', next.toISOString())
      }
      continue
    }

    const nextRun = new Date(schedule.next_run_at)
    if (now >= nextRun) {
      executeSchedule(schedule).catch(() => {})
    }
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null

export function startScheduler(): void {
  if (tickTimer) return
  // Initialize next_run_at for all schedules
  const schedules = listSchedules()
  for (const s of schedules) {
    if (s.enabled && !s.next_run_at) {
      const next = nextCronTime(s.cron)
      if (next) updateScheduleRun(s.id, s.last_run_at ?? '', next.toISOString())
    }
  }
  tickTimer = setInterval(tick, TICK_INTERVAL)
  console.log('[Scheduler] Started with 30s tick interval')
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}
