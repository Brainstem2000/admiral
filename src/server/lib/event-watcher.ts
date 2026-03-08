/**
 * Event-driven wake system.
 * Monitors agent notifications and fires triggers when matching events occur.
 * Trigger actions: wake (connect + start LLM), nudge (inject message), disconnect.
 */
import { listEventTriggers, markEventTriggerFired, addLogEntry, getProfile, type EventTrigger } from './db'
import { agentManager } from './agent-manager'

/**
 * Check a notification against all enabled triggers for a profile.
 * Called from the agent's notification handler.
 */
export async function checkEventTriggers(profileId: string, notification: Record<string, unknown>): Promise<void> {
  const triggers = listEventTriggers(profileId).filter(t => t.enabled)
  if (triggers.length === 0) return

  const notifType = (notification.type || notification.msg_type || '') as string
  const notifContent = JSON.stringify(notification).toLowerCase()

  for (const trigger of triggers) {
    if (!matchesTrigger(trigger, notifType, notifContent)) continue

    markEventTriggerFired(trigger.id)
    await executeTriggerAction(trigger, notification)
  }
}

function matchesTrigger(trigger: EventTrigger, notifType: string, notifContent: string): boolean {
  // Match event type (supports wildcards)
  if (trigger.event_type !== '*' && trigger.event_type !== notifType) {
    // Check if event_type is a partial match (e.g., "trade" matches "trade_fill")
    if (!notifType.includes(trigger.event_type)) return false
  }

  // Match content filter if specified
  if (trigger.event_match) {
    const pattern = trigger.event_match.toLowerCase()
    if (!notifContent.includes(pattern)) return false
  }

  return true
}

async function executeTriggerAction(trigger: EventTrigger, notification: Record<string, unknown>): Promise<void> {
  const profile = getProfile(trigger.profile_id)
  if (!profile) return

  const notifSummary = (notification.message || notification.content || JSON.stringify(notification)).toString().slice(0, 100)

  if (trigger.action === 'wake' || trigger.action === 'connect_llm') {
    addLogEntry(profile.id, 'system', `[Event Trigger] Waking agent: ${trigger.event_type} matched — ${notifSummary}`)
    try {
      let agent = agentManager.getAgent(profile.id)
      if (!agent || !agent.isConnected) {
        agent = await agentManager.connect(profile.id)
      }
      if (!agent.isRunning && profile.provider && profile.provider !== 'manual' && profile.model) {
        await agentManager.startLLM(profile.id)
      }
    } catch (err) {
      addLogEntry(profile.id, 'error', `[Event Trigger] Wake failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (trigger.action === 'nudge') {
    const nudgeMsg = trigger.action_params || `Event triggered: ${notifSummary}`
    addLogEntry(profile.id, 'system', `[Event Trigger] Nudging agent: ${trigger.event_type} — ${notifSummary}`)
    agentManager.nudge(profile.id, nudgeMsg)
  } else if (trigger.action === 'disconnect') {
    addLogEntry(profile.id, 'system', `[Event Trigger] Disconnecting agent: ${trigger.event_type} — ${notifSummary}`)
    try {
      await agentManager.disconnect(profile.id)
    } catch (err) {
      addLogEntry(profile.id, 'error', `[Event Trigger] Disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
