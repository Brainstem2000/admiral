/** Skills tab — get_skills as a dossier: summary stats, one pinnable "hero" skill,
 *  and per-category rows with percentage-labeled XP bars. Free query, 60s refresh. */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { GraduationCap, RefreshCw, Pin } from 'lucide-react'
import type { Profile } from '@/types'
import { DossierCard } from '../DossierCard'
import { DISPLAY, StatCell, Chip, Freshness, SectionLabel } from '../dossier-shared'

interface Skill {
  name: string
  category: string
  level: number
  max_level: number
  xp: number
  next_level_xp: number
}

const skillsCache = new Map<string, { skills: Record<string, Skill>; fetchedAt: number }>()

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

function isMaxed(s: Skill): boolean { return !s.next_level_xp || s.next_level_xp <= 0 }

function SkillRow({ skillKey, skill, pinned, onPin }: {
  skillKey: string
  skill: Skill
  pinned: boolean
  onPin: (key: string) => void
}) {
  const pct = xpPct(skill)
  const maxed = isMaxed(skill)
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
      <span className="text-[10px] uppercase tracking-wider shrink-0 tabular-nums" style={DISPLAY}>
        <span className="text-muted-foreground">Lv </span>
        <span className="text-foreground/90">{skill.level}</span>
        {skill.max_level > 0 && <span className="text-muted-foreground/50">/{skill.max_level}</span>}
      </span>
      <div className="flex-1 h-1 bg-border/40 overflow-hidden min-w-[40px]">
        <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: maxed ? 'hsl(var(--smui-green))' : 'hsl(var(--smui-frost-2))' }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/60">{Math.round(pct)}%</span>
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
        {maxed
          ? <span style={{ color: 'hsl(var(--smui-green))' }}>MAX</span>
          : <>{(skill.xp ?? 0).toLocaleString()}<span className="text-muted-foreground/50">/{skill.next_level_xp.toLocaleString()}</span></>}
      </span>
    </div>
  )
}

export function SkillsTab({ profile, connected }: { profile: Profile; connected: boolean }) {
  const [skills, setSkills] = useState<Record<string, Skill> | null>(() => skillsCache.get(profile.id)?.skills || null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(() => skillsCache.get(profile.id)?.fetchedAt ?? null)
  const [loading, setLoading] = useState(false)
  const [pinnedKey, setPinnedKey] = useState<string | null>(() => loadPin(profile.id))
  const profileIdRef = useRef(profile.id)

  useEffect(() => {
    profileIdRef.current = profile.id
    const cached = skillsCache.get(profile.id)
    setSkills(cached?.skills || null)
    setFetchedAt(cached?.fetchedAt ?? null)
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
        const now = Date.now()
        skillsCache.set(targetId, { skills: result.skills as Record<string, Skill>, fetchedAt: now })
        setSkills(result.skills as Record<string, Skill>)
        setFetchedAt(now)
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

  // Summary: trained count, total levels, and the non-maxed skill closest to leveling.
  const summary = useMemo(() => {
    const list = Object.values(skills || {})
    if (!list.length) return null
    const totalLevels = list.reduce((n, s) => n + (s.level ?? 0), 0)
    const maxedCount = list.filter(isMaxed).length
    let closest: Skill | null = null
    for (const s of list) {
      if (isMaxed(s)) continue
      if (!closest || xpPct(s) > xpPct(closest)) closest = s
    }
    return { trained: list.length, totalLevels, maxedCount, closest }
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
        <span className="flex items-center gap-2">
          <Freshness at={fetchedAt} />
          <button onClick={fetchSkills} disabled={!connected || loading} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </span>
      }
    >
      {!connected && !skills ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">Connect to load skills</div>
      ) : !skills ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/50 italic">{loading ? 'Loading...' : 'No skill data'}</div>
      ) : (
        <>
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 px-3 py-3 border-b border-border/40">
              <StatCell label="Trained" value={String(summary.trained)} />
              <StatCell label="Total Levels" value={summary.totalLevels.toLocaleString()} accent="var(--smui-frost-2)" />
              <StatCell label="Maxed" value={String(summary.maxedCount)} accent={summary.maxedCount > 0 ? 'var(--smui-green)' : undefined} />
              {summary.closest && (
                <StatCell
                  label="Next Level-Up"
                  value={summary.closest.name}
                  accent="var(--smui-yellow)"
                  sub={`${Math.round(xpPct(summary.closest))}% · ${Math.max(0, summary.closest.next_level_xp - (summary.closest.xp ?? 0)).toLocaleString()} xp to go`}
                  hint="Non-maxed skill closest to its next level"
                />
              )}
            </div>
          )}
          {hero && (
            <div className="m-3 mb-1 p-3 border border-primary/40 bg-primary/5">
              <div className="flex items-center gap-2 mb-1.5">
                <Pin size={11} fill="currentColor" className="text-[hsl(var(--smui-yellow))] shrink-0" />
                <span className="text-sm font-medium text-foreground flex-1 truncate" style={DISPLAY}>{hero.name}</span>
                <Chip label={hero.category} />
                <span className="text-sm tabular-nums" style={{ color: 'hsl(var(--smui-frost-2))', ...DISPLAY }}>Lv {hero.level}</span>
              </div>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="h-1.5 flex-1 bg-border/40 overflow-hidden">
                  <div className="h-full transition-all duration-300" style={{ width: `${xpPct(hero)}%`, background: 'hsl(var(--smui-frost-2))' }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground/60">{Math.round(xpPct(hero))}%</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {(hero.xp ?? 0).toLocaleString()}<span className="text-muted-foreground/50">{hero.next_level_xp ? `/${hero.next_level_xp.toLocaleString()} xp` : ' MAX'}</span>
                </span>
                {!isMaxed(hero) && (
                  <span className="text-[11px] tabular-nums" style={{ color: 'hsl(var(--smui-yellow))' }}>
                    {heroToGo.toLocaleString()} XP to go
                  </span>
                )}
              </div>
            </div>
          )}
          {byCategory.map(([category, list]) => (
            <div key={category}>
              <SectionLabel className="px-3 pt-3 pb-1">
                {category} <span className="text-muted-foreground/50 tabular-nums normal-case tracking-normal">· {list.length}</span>
              </SectionLabel>
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
