/**
 * LiquidProgressRing — a circular progress badge that fills with animated
 * liquid as the onboarding checklist ticks.
 *
 * Composition (one SVG, layered back-to-front):
 *
 *   1. Background disc — a faint radial sheen for the empty container.
 *   2. A clipping group so every animated shape stays inside the circle:
 *      - three wave paths at different speeds, amplitudes and tints, scrolled
 *        horizontally by CSS `translateX` for the moving-surface effect;
 *      - six bubbles that rise from the bottom to the wave surface and pop;
 *      - a thin highlight stripe on the front wave's crest.
 *   3. The outer ring outline, over everything, so the silhouette stays crisp.
 *   4. The centred `value/total` fraction.
 *
 * The surface height tracks `pct` (0..1) as `surfaceY = 100 - 100*pct` in the
 * SVG's 0..100 user-unit grid. Bubbles read the same number through the
 * `--rise-distance` custom property, so they always rise to the current level.
 *
 * Colour comes from tokens, never from literals: `--accent-1` and `--success`
 * for the liquid, the `--overlay-*` white scale for glass and bubbles. This is
 * one of the few places colour is not identity or state — it is the progress
 * itself, which is why it gets an accent rather than an achromatic fill.
 *
 * Reduced motion: the waves stop, the bubbles disappear, and the liquid renders
 * as a static shape at the right level. The number is still the number.
 */
import { useId, type CSSProperties } from 'react'
import styles from './LiquidProgressRing.module.css'

interface LiquidProgressRingProps {
  value: number
  total: number
  /** Pixel size of the ring. Defaults to 112. */
  size?: number
}

// SVG user-coordinate space — independent of the rendered pixel size.
const VIEW = 100
const STROKE = 4
const R = (VIEW - STROKE) / 2
const CX = VIEW / 2
const CY = VIEW / 2

// Wave geometry. The front and back parallax layers share the smaller shape;
// the deep layer uses a bigger amplitude AND wavelength so it reads as a
// slower, larger swell behind them.
//
// Wavelength is not only visual: the CSS scroll animation translates each path
// by exactly one of its own wavelengths per loop, so the geometry has to match
// the keyframe distance or the loop visibly jumps. The matching pairs are
// front/back → `translateX(-18px)` and deep → `translateX(-30px)`.
const WAVE_AMPLITUDE = 2.2
const WAVE_WAVELENGTH = 18
const DEEP_WAVE_AMPLITUDE = 4.2
const DEEP_WAVE_WAVELENGTH = 30

/**
 * A smooth wave polygon filling from `baseY` down to y=100.
 *
 * Quadratic Béziers with the `T` smooth-continuation command, which alternates
 * the implicit control point above and below the baseline — exactly a wave.
 * Each path is built two wavelengths wider than the viewBox on both sides so
 * the horizontal scroll never reveals an end cap.
 */
function buildWavePath(
  baseY: number,
  amplitude: number = WAVE_AMPLITUDE,
  wavelength: number = WAVE_WAVELENGTH,
): string {
  const overrun = wavelength * 2
  const left = -overrun
  const right = VIEW + overrun
  // The first Q seeds the implicit control point above the baseline so the
  // first reflected T dives below it. Each subsequent T flips direction.
  let d = `M ${left} ${baseY} Q ${left + wavelength * 0.25} ${baseY - amplitude} ${left + wavelength * 0.5} ${baseY}`
  for (let x = left + wavelength * 0.5; x < right; x += wavelength * 0.5) {
    d += ` T ${x + wavelength * 0.5} ${baseY}`
  }
  d += ` L ${right} ${VIEW} L ${left} ${VIEW} Z`
  return d
}

interface BubbleSpec {
  cx: number
  r: number
  delay: number
  duration: number
}

/**
 * Hand-tuned bubble lineup — staggered across the width with different sizes
 * and timings so the eye does not lock onto a period. Six is the balance
 * between lively and a noisy SVG repaint.
 */
const BUBBLES: readonly BubbleSpec[] = [
  { cx: 30, r: 2.2, delay: 0.0, duration: 3.0 },
  { cx: 42, r: 1.4, delay: 1.8, duration: 3.6 },
  { cx: 55, r: 2.6, delay: 0.9, duration: 3.4 },
  { cx: 64, r: 1.8, delay: 2.3, duration: 3.2 },
  { cx: 72, r: 1.2, delay: 0.4, duration: 3.8 },
  { cx: 48, r: 1.6, delay: 1.4, duration: 3.5 },
]

/** Below this fill the bubbles would float above the liquid, so they are not drawn. */
const BUBBLE_FILL_FLOOR = 0.05

export function LiquidProgressRing({ value, total, size = 112 }: LiquidProgressRingProps) {
  const pct = total === 0 ? 0 : Math.max(0, Math.min(1, value / total))
  // At pct=0 the surface sits at the bottom (y=100), at pct=1 at the top.
  const surfaceY = (1 - pct) * VIEW
  const wavePath = buildWavePath(surfaceY)
  const wavePathBack = buildWavePath(Math.min(VIEW, surfaceY + 1.4))
  const wavePathDeep = buildWavePath(surfaceY, DEEP_WAVE_AMPLITUDE, DEEP_WAVE_WAVELENGTH)

  // Unique gradient / clip ids so two rings on one page cannot collide.
  const idBase = useId().replace(/:/g, '')
  const liquidGrad = `${idBase}-liquid`
  const liquidGradBack = `${idBase}-liquid-back`
  const liquidGradDeep = `${idBase}-liquid-deep`
  const ringClip = `${idBase}-clip`
  const innerGlow = `${idBase}-glow`

  const containerStyle: CSSProperties = {
    // The rendered size and the bubbles' rise distance are per-render values
    // the stylesheet reads back through `var()` — the one sanctioned use of
    // inline `style` (docs/design.md, "No inline style").
    ['--ring-size' as string]: `${size}px`,
    ['--rise-distance' as string]: `${((96 - surfaceY) / VIEW) * size}px`,
  }

  return (
    <div
      className={styles.ring}
      style={containerStyle}
      role="img"
      aria-label={`${value} of ${total} steps done`}
    >
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true" className={styles.svg}>
        <defs>
          {/* The bottle. Every liquid and bubble pixel lives inside it. */}
          <clipPath id={ringClip}>
            <circle cx={CX} cy={CY} r={R} />
          </clipPath>

          {/* Front liquid — a bright crest falling to a deeper base. */}
          <linearGradient id={liquidGrad} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-1)" stopOpacity="0.95" />
            <stop offset="55%" stopColor="var(--accent-1)" stopOpacity="0.88" />
            <stop offset="100%" stopColor="var(--success)" stopOpacity="0.85" />
          </linearGradient>

          {/* Back wave — lower opacity, for the parallax read. */}
          <linearGradient id={liquidGradBack} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--success-bright)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--success)" stopOpacity="0.4" />
          </linearGradient>

          {/* Deep wave. Painted with `multiply` (see the stylesheet), so a
              saturated fill of the same hue lands as a darker silhouette of a
              swell behind the liquid rather than a solid green hump. */}
          <linearGradient id={liquidGradDeep} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--success)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--success)" stopOpacity="0.75" />
          </linearGradient>

          {/* Sheen on the empty bottle — white at low alpha, so it reads as glass. */}
          <radialGradient id={innerGlow} cx="50%" cy="35%" r="65%">
            <stop offset="0%" stopColor="var(--overlay)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--overlay)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={CX} cy={CY} r={R} fill={`url(#${innerGlow})`} />
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--overlay-5)" strokeWidth={STROKE - 1} />

        <g clipPath={`url(#${ringClip})`}>
          <path d={wavePathDeep} fill={`url(#${liquidGradDeep})`} className={styles.waveDeep} />
          <path d={wavePathBack} fill={`url(#${liquidGradBack})`} className={styles.waveBack} />
          <path d={wavePath} fill={`url(#${liquidGrad})`} className={styles.waveFront} />

          {/* Light catching the meniscus. */}
          <path
            d={wavePath}
            fill="none"
            stroke="var(--overlay-20)"
            strokeWidth="0.6"
            className={styles.waveFront}
          />

          {pct > BUBBLE_FILL_FLOOR && BUBBLES.map((bubble) => (
            <circle
              key={bubble.cx}
              cx={bubble.cx}
              cy={96}
              r={bubble.r}
              fill="var(--overlay-70)"
              stroke="var(--overlay-40)"
              strokeWidth="0.3"
              className={styles.bubble}
              // Per-bubble timing, the same sanctioned inline-style case as
              // `--rise-distance` above: the stylesheet owns every property
              // that does not vary per element.
              style={{
                ['--bubble-delay' as string]: `${bubble.delay}s`,
                ['--bubble-duration' as string]: `${bubble.duration}s`,
              } as CSSProperties}
            />
          ))}
        </g>

        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--accent-1)" strokeOpacity="0.55" strokeWidth={1.2} />
      </svg>

      <div className={styles.label}>
        <span className={styles.fraction}>
          {value}
          <small>/{total}</small>
        </span>
      </div>
    </div>
  )
}
