/**
 * Animated SVG + CSS scenes for the Character activity graphic.
 *
 * Design constraints (see plan):
 *  - No new dependencies. Pure inline SVG + CSS keyframes (defined in globals.css).
 *  - Colors come ONLY from theme tokens (hsl(var(--smui-*))) so light/dark just work.
 *  - Moving particles/ships use absolutely-positioned HTML divs animated with
 *    translate (rock-solid cross-browser). SVG elements animate only opacity /
 *    rotate (via .svg-origin { transform-box: fill-box }).
 */
import type { ActivityKind } from '@/lib/activity'

const FROST = 'hsl(var(--smui-frost-2))'
const FROST3 = 'hsl(var(--smui-frost-3))'
const PRIMARY = 'hsl(var(--primary))'
const RED = 'hsl(var(--smui-red))'
const ORANGE = 'hsl(var(--smui-orange))'
const YELLOW = 'hsl(var(--smui-yellow))'
const GREEN = 'hsl(var(--smui-green))'
const PURPLE = 'hsl(var(--smui-purple))'
const MUTED = 'hsl(var(--muted-foreground))'

// Deterministic star field so layers don't reshuffle each render.
const STARS_A = [6, 14, 23, 31, 40, 52, 61, 70, 78, 88, 95]
const STARS_B = [10, 19, 27, 36, 47, 55, 66, 74, 83, 92]

/** A sleek rightward-pointing ship glyph. */
function Ship({ size = 44, color = FROST, className = '' }: { size?: number; color?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden>
      {/* nose points RIGHT (direction of travel) — exhaust trails left */}
      <path d="M33 20 L11 11 L15 20 L11 29 Z" fill={color} />
      <circle cx="18" cy="20" r="2" fill="hsl(var(--background))" />
    </svg>
  )
}

/** A cog/gear glyph (8 teeth). */
function Gear({ size = 46, color = PURPLE, className = '', style }: { size?: number; color?: string; className?: string; style?: React.CSSProperties }) {
  const teeth = Array.from({ length: 8 }, (_, i) => i * 45)
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} style={style} aria-hidden>
      <g className="svg-origin">
        {teeth.map(deg => (
          <rect key={deg} x="22" y="2" width="4" height="8" fill={color} transform={`rotate(${deg} 24 24)`} />
        ))}
        <circle cx="24" cy="24" r="13" fill="none" stroke={color} strokeWidth="3" />
        <circle cx="24" cy="24" r="4" fill={color} />
      </g>
    </svg>
  )
}

/** A blocky station silhouette. */
function Station({ width = 70, color = FROST3, glow = false }: { width?: number; color?: string; glow?: boolean }) {
  return (
    <svg width={width} height={width * 0.7} viewBox="0 0 70 50" aria-hidden>
      {glow && <circle cx="35" cy="25" r="22" fill="none" stroke={color} strokeWidth="1.5" className="dock-glow svg-origin" opacity="0.5" />}
      <rect x="26" y="6" width="18" height="38" fill={color} opacity="0.85" />
      <rect x="10" y="18" width="50" height="14" fill={color} />
      <rect x="4" y="22" width="8" height="6" fill={color} opacity="0.7" />
      <rect x="58" y="22" width="8" height="6" fill={color} opacity="0.7" />
      <rect x="31" y="0" width="8" height="6" fill={color} opacity="0.6" />
    </svg>
  )
}

function Stars({ strip, layer, color, dur }: { strip: number[]; layer: number; color: string; dur: number }) {
  // Two duplicated halves inside a 200%-wide strip → seamless leftward scroll.
  const half = (
    <div className="relative w-1/2 h-full shrink-0">
      {strip.map((x, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            left: `${x}%`,
            top: `${(i * 37 + layer * 13) % 100}%`,
            width: layer === 0 ? 2 : 1.5,
            height: layer === 0 ? 2 : 1.5,
            background: color,
            opacity: layer === 0 ? 0.8 : 0.4,
          }}
        />
      ))}
    </div>
  )
  return (
    <div
      className="absolute inset-0 flex star-strip"
      style={{ width: '200%', animationDuration: `${dur}s` }}
    >
      {half}
      {half}
    </div>
  )
}

function Scene({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 overflow-hidden">{children}</div>
}

function TravelingScene() {
  return (
    <Scene>
      <Stars strip={STARS_A} layer={1} color={FROST} dur={7} />
      <Stars strip={STARS_B} layer={0} color={PRIMARY} dur={4} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative">
          <span className="absolute top-1/2 -left-6 -translate-y-1/2 h-1.5 w-8 rounded-full engine-glow" style={{ background: ORANGE }} />
          <Ship color={FROST} />
        </div>
      </div>
    </Scene>
  )
}

function CombatScene() {
  return (
    <Scene>
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 62% 50%, hsl(var(--smui-red)/0.16), transparent 60%)' }} />
      {/* attacker ship, left */}
      <div className="absolute top-1/2 left-7 -translate-y-1/2">
        <Ship size={34} color={MUTED} />
      </div>
      {/* muzzle flashes */}
      {[0, 0.18, 0.36].map((d, i) => (
        <span
          key={i}
          className="absolute rounded-full muzzle-flash"
          style={{ top: '50%', left: `${36 + i * 6}%`, width: 4, height: 4, background: YELLOW, animationDelay: `${d}s` }}
        />
      ))}
      {/* target + reticle, right */}
      <div className="absolute top-1/2 right-9 -translate-y-1/2">
        <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden>
          <circle cx="23" cy="23" r="9" fill={RED} className="target-pulse svg-origin" />
          <g stroke={RED} strokeWidth="1.5" fill="none">
            <circle cx="23" cy="23" r="16" opacity="0.7" />
            <line x1="23" y1="2" x2="23" y2="9" />
            <line x1="23" y1="37" x2="23" y2="44" />
            <line x1="2" y1="23" x2="9" y2="23" />
            <line x1="37" y1="23" x2="44" y2="23" />
          </g>
        </svg>
      </div>
    </Scene>
  )
}

function MiningScene() {
  return (
    <Scene>
      {/* ship, left */}
      <div className="absolute top-1/2 left-8 -translate-y-1/2">
        <Ship size={36} color={FROST} />
      </div>
      {/* mining beam */}
      <div
        className="absolute top-1/2 left-[34%] h-[3px] w-[28%] -translate-y-1/2 beam-flicker"
        style={{ background: `linear-gradient(90deg, ${ORANGE}, ${YELLOW})`, transformOrigin: 'left center' }}
      />
      {/* asteroid, right */}
      <div className="absolute top-1/2 right-8 -translate-y-1/2">
        <svg width="50" height="50" viewBox="0 0 50 50" aria-hidden>
          <path d="M25 4 L40 12 L46 28 L36 44 L17 45 L5 30 L8 13 Z" fill={MUTED} opacity="0.55" stroke={ORANGE} strokeWidth="1.5" />
        </svg>
      </div>
      {/* sparks */}
      {[0, 0.25, 0.5, 0.75].map((d, i) => (
        <span
          key={i}
          className="absolute rounded-full spark-fly"
          style={{ top: '50%', right: '20%', width: 3, height: 3, background: YELLOW, animationDelay: `${d}s` }}
        />
      ))}
    </Scene>
  )
}

function CraftingScene() {
  return (
    <Scene>
      <div className="absolute inset-0 flex items-center justify-center gap-1">
        <Gear size={52} color={PURPLE} className="gear-spin" />
        <Gear size={36} color={FROST} className="gear-spin-rev" style={{ marginTop: 18 }} />
      </div>
    </Scene>
  )
}

function TradingScene() {
  return (
    <Scene>
      <div className="absolute inset-0 flex items-center justify-center">
        <Station width={76} color={FROST3} />
      </div>
      {[0, 0.3, 0.6, 0.9].map((d, i) => (
        <span
          key={i}
          className="absolute rounded-full coin-rise flex items-center justify-center"
          style={{ bottom: '24%', left: `${38 + i * 7}%`, width: 9, height: 9, background: YELLOW, color: 'hsl(var(--background))', animationDelay: `${d}s`, fontSize: 7, fontWeight: 700 }}
        >
          ¢
        </span>
      ))}
      <span className="absolute bottom-3 left-1/2 -translate-x-1/2 h-[2px] w-1/3" style={{ background: `${GREEN}`, opacity: 0.4 }} />
    </Scene>
  )
}

function DockingScene() {
  return (
    <Scene>
      <Stars strip={STARS_B} layer={1} color={FROST} dur={10} />
      <div className="absolute top-1/2 right-7 -translate-y-1/2">
        <Station width={64} color={FROST3} glow />
      </div>
      <div className="absolute top-1/2 left-2 -translate-y-1/2 dock-slide">
        <Ship size={34} color={FROST} />
      </div>
    </Scene>
  )
}

function DockedScene() {
  return (
    <Scene>
      <div className="absolute inset-0 flex items-center justify-center">
        <Station width={84} color={FROST3} glow />
      </div>
      <div className="absolute top-1/2 left-[34%] -translate-y-1/2">
        <Ship size={28} color={FROST} />
      </div>
    </Scene>
  )
}

function ThinkingScene() {
  const nodes = [
    { x: 30, y: 50 }, { x: 50, y: 28 }, { x: 50, y: 72 },
    { x: 72, y: 40 }, { x: 72, y: 64 },
  ]
  return (
    <Scene>
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full" preserveAspectRatio="xMidYMid meet" aria-hidden>
        <g stroke={FROST} strokeWidth="0.6" opacity="0.35">
          <line x1="30" y1="50" x2="50" y2="28" />
          <line x1="30" y1="50" x2="50" y2="72" />
          <line x1="50" y1="28" x2="72" y2="40" />
          <line x1="50" y1="72" x2="72" y2="64" />
          <line x1="72" y1="40" x2="72" y2="64" />
        </g>
        {nodes.map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r="3.5"
            fill={FROST}
            className="think-pulse svg-origin"
            style={{ animationDelay: `${i * 0.22}s` }}
          />
        ))}
      </svg>
    </Scene>
  )
}

function IdleScene() {
  return (
    <Scene>
      <Stars strip={STARS_B} layer={1} color={MUTED} dur={22} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="idle-blink">
          <Ship size={34} color={MUTED} />
        </div>
      </div>
    </Scene>
  )
}

function OfflineScene() {
  return (
    <Scene>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <Ship size={30} color={MUTED} />
          <span className="h-[1px] w-10" style={{ background: MUTED }} />
        </div>
      </div>
    </Scene>
  )
}

export const SCENES: Record<ActivityKind, React.FC> = {
  traveling: TravelingScene,
  docking: DockingScene,
  docked: DockedScene,
  combat: CombatScene,
  mining: MiningScene,
  crafting: CraftingScene,
  trading: TradingScene,
  thinking: ThinkingScene,
  idle: IdleScene,
  offline: OfflineScene,
}

/** Accent color per kind — used by the caption dot/border. */
export const KIND_ACCENT: Record<ActivityKind, string> = {
  traveling: FROST,
  docking: FROST3,
  docked: FROST3,
  combat: RED,
  mining: ORANGE,
  crafting: PURPLE,
  trading: YELLOW,
  thinking: FROST,
  idle: MUTED,
  offline: MUTED,
}
