import { EMPIRE_COLORS, AGENT_COLORS } from '@shared/galaxy-types'

/** Deterministic z-coordinate from system_id using Box-Muller for Gaussian disc shape */
export function systemZ(systemId: string): number {
  let hash = 0
  for (let i = 0; i < systemId.length; i++) {
    hash = ((hash << 5) - hash + systemId.charCodeAt(i)) | 0
  }
  const u1 = ((hash & 0xFFFF) + 1) / 65537
  const u2 = (((hash >>> 16) & 0xFFFF) + 1) / 65537
  const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return gaussian * 1500
}

export interface ThemeColors {
  muted: string
  foreground: string
  primary: string
  card: string
  border: string
  background: string
  empires: Record<string, string>
  agents: string[]
}

function hslToHex(hslStr: string): string {
  // hslStr is raw CSS value like "210 40% 98%"
  if (!hslStr) return '#888888'

  // If already hex, return as-is
  if (hslStr.startsWith('#')) return hslStr

  const parts = hslStr.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  if (parts.length < 3) return '#888888'

  const h = parseFloat(parts[0])
  const s = parseFloat(parts[1]) / 100
  const l = parseFloat(parts[2]) / 100

  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function resolveVarHex(varName: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return hslToHex(raw)
}

export function resolveThemeColors(): ThemeColors {
  return {
    muted: resolveVarHex('--muted-foreground'),
    foreground: resolveVarHex('--foreground'),
    primary: resolveVarHex('--primary'),
    card: resolveVarHex('--card'),
    border: resolveVarHex('--border'),
    background: resolveVarHex('--background'),
    empires: Object.fromEntries(
      Object.entries(EMPIRE_COLORS).map(([k, v]) => [k, resolveVarHex(v)])
    ),
    agents: AGENT_COLORS.map(v => resolveVarHex(v)),
  }
}

export function getEmpireColor(empire: string | undefined, colors: ThemeColors): string {
  if (!empire) return colors.muted
  return colors.empires[empire] || colors.muted
}
