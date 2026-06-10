/** Skills tab — get_skills grouped by category, with one pinnable "hero" skill per agent. */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { GraduationCap, RefreshCw, Pin } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'

interface Skill {
  name: string
  category: string
  level: number
  max_level: number
  xp: number
  next_level_xp: number
}

const skillsCache = new Map<string, Record<string, Skill>>()

const PIN_KEY_PREFIX = 'admiral-skill-pin-'

function loadPin(profileId: string): string | null {
  try { return localStorage.getItem(`${PIN_KEY_PREFIX}${profileId}`) } catch { return null }
}

function savePin(profileId: string, skillKey: string | null) {
  try {
    if (skillKey) localStorage.setItem(`${PIN_KEY_PREFIX}${profileId}`, skillKey)
    else localStorage.removeItem(`${PIN_KEY_PREFIX}${profileId}`)
  } catch { /* ignore */ }
}

function xpPct(s: Skill): number {
  if (!s.next_level_xp || s.next_level_xp <= 0) return 100
  return Math.max(0, Math.min(100, (s.xp / s.next_level_xp) * 100))
}

function SkillRow({ skillKey, skill, pinned, onPin }: {
  skillKey: string
  skill: Skill
  pinned: boolean
  onPin: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border/30 first:border-t-0">
      <button
        onClick={() => onPin(skillKey)}
        title={pinned ? 'Unpin skill' : 'Pin skill'}
        className={`shrink-0 transition-colors ${pinned ? 'text-[hsl(var(--smui-yellow))]' : 'text-muted-foreground/40 hover:text-foreground'}`}
      >
        <Pin size={10} fill={pinned ? 'currentColor' : 'none'} />
      </button>
      <span className="text-xs text-foreground/90 truncate w-36 shrink-0">{skill.name}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0 tabular-nums">Lv {skill.level}</span>
      <div className="flex-1 h-1 bg-border/40 overflow-hidden min-w-[40px]">
        <div className="h-full transition-all duration-300" style={{ width: `${xpPct(skill)}%`, background: 'hsl(var(--smui-frost-2))' }} />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
        {(skill.xp ?? 0).toLocaleString()}<span className="text-muted-foreground/50">{skill.next_level_xp ? `/${skill.next_level_xp.toLocaleString()}` : ' MAX'}</span>
      </span>
    </div>
  )
}

export function SkillsTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [skills, setSkills] = useState<Record<string, Skill> | null>(() => skillsCache.get(profile.id) || null)
  const [loading, setLoading] = useState(false)
  const [pinnedKey, setPinnedKey] = useState<string | null>(() => loadPin(profile.id))
  const profileIdRef = useRef(profile.id)

  useEffect(() => {
    profileIdRef.current = profile.id
    setSkills(skillsCache.get(profile.id) || null)
    setPinnedKey(loadPin(profile.id))
  }, [profile.id])

  const fetchSkills = useCallback(async () => {
    if (!connected) return
    const targetId = profile.id
    setLoading(true)
    try {
      const resp = await fetch(`/api/profiles/${targetId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'get_skills', silent: true }),
      })
      if (profileIdRef.current !== targetId) return
      const data = await resp.json()
      const result = data.structuredContent || data.result || data
      if (result?.skills && typeof result.skills === 'object') {
        skillsCache.set(targetId, result.skills as Record<string, Skill>)
        setSkills(result.skills as Record<string, Skill>)
      }
    } catch { /* ignore */ } finally {
      if (profileIdRef.current === targetId) setLoading(false)
    }
  }, [profile.id, connected])

  useEffect(() => {
    if (!connected) return
    fetchSkills()
    const t = setInterval(fetchSkills, 60_000)
    return () => clearInterval(t)
  }, [connected, fetchSkills])

  const togglePin = useCallback((key: string) => {
    setPinnedKey(prev => {
      const next = prev === key ? null : key
      savePin(profileIdRef.current, next)
      return next
    })
  }, [])

  // Category -> sorted [key, skill] pairs; categories alphabetical, skills by level desc.
  const byCategory = useMemo(() => {
    const groups = new Map<string, [string, Skill][]>()
    for (const [key, s] of Object.entries(skills || {})) {
      const cat = s.category || 'Other'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push([key, s])
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (b[1].level ?? 0) - (a[1].level ?? 0) || (a[1].name || a[0]).localeCompare(b[1].name || b[0]))
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [skills])

  const hero = pinnedKey && skills ? skills[pinnedKey] : null
  const heroToGo = hero?.next_level_xp ? Math.max(0, hero.next_level_xp - (hero.xp ?? 0)) : 0

  return (
    <DossierCard
      title="Skills"
      icon={<GraduationCap size={12} />}
      source="Server"
      className="min-h-[140px]"
      action={
        <button onClick={fetchSkills} disabled={!connected || loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      }
    >
      {!connected ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Connect to load skills</div>
      ) : !skills ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">{loading ? 'Loading...' : 'No skill data'}</div>
      ) : (
        <>
          {hero && (
            <div className="m-3 mb-1 p-3 border border-primary/40 bg-primary/5">
              <div className="flex items-center gap-2 mb-1.5">
                <Pin size={11} fill="currentColor" className="text-[hsl(var(--smui-yellow))] shrink-0" />
                <span className="text-sm font-medium text-foreground flex-1 truncate">{hero.name}</span>
                <span className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{hero.category}</span>
                <span className="text-sm tabular-nums" style={{ color: 'hsl(var(--smui-frost-2))' }}>Lv {hero.level}</span>
              </div>
              <div className="h-1.5 w-full bg-border/40 overflow-hidden mb-1.5">
                <div className="h-full transition-all duration-300" style={{ width: `${xpPct(hero)}%`, background: 'hsl(var(--smui-frost-2))' }} />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {(hero.xp ?? 0).toLocaleString()}<span className="text-muted-foreground/50">{hero.next_level_xp ? `/${hero.next_level_xp.toLocaleString()} xp` : ' MAX'}</span>
                </span>
                <span className="text-[11px] tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }}>
                  {heroToGo.toLocaleString()} XP to go
                </span>
              </div>
            </div>
          )}
          {byCategory.map(([category, list]) => (
            <div key={category}>
              <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{category}</div>
              {list.map(([key, s]) => (
                <SkillRow key={key} skillKey={key} skill={s} pinned={key === pinnedKey} onPin={togglePin} />
              ))}
            </div>
          ))}
        </>
      )}
    </DossierCard>
  )
}
