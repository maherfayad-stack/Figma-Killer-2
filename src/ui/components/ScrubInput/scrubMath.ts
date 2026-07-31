/**
 * scrubMath — pure value math behind `ScrubInput`.
 *
 * Kept separate from the component so the drag/keyboard arithmetic is
 * testable without a DOM (`scrubMath.test.ts`) independently of the pointer
 * event wiring (`scrubInput.test.tsx`, which drives the real component).
 *
 * A value is either:
 *   - a CSS length string this module CAN scrub: an optional leading `-`,
 *     digits, an optional decimal part, then an optional unit/`%` suffix
 *     (`"120px"`, `"1.5rem"`, `"50%"`, `"12"`);
 *   - a keyword this module recognizes but does NOT scrub numerically
 *     (`auto` / `fill` / `hug` — see `SCRUB_KEYWORDS`);
 *   - anything else (`"calc(100% - 8px)"`, `""`, a var() reference) — not
 *     scrubbable; drag is a no-op and typing is the only way to change it.
 */

export interface ParsedScrubValue {
  magnitude: number
  unit: string
}

const NUMERIC_LENGTH_RE = /^(-?\d*\.?\d+)([a-z%]*)$/i

/** The Figma-style layout keywords a size/dimension field may hold instead of a length. */
export const SCRUB_KEYWORDS = ['auto', 'fill', 'hug'] as const
export type ScrubKeyword = (typeof SCRUB_KEYWORDS)[number]

/** True when `raw` (trimmed, case-insensitive) is one of `SCRUB_KEYWORDS`. */
export function isScrubKeyword(raw: string): raw is ScrubKeyword {
  const normalized = raw.trim().toLowerCase()
  return (SCRUB_KEYWORDS as readonly string[]).includes(normalized)
}

/**
 * Parse a scrubbable numeric CSS length. Returns `null` for keywords,
 * `calc()`/`var()` expressions, empty strings, or anything else that isn't a
 * bare `<number><unit?>`.
 */
export function parseScrubValue(raw: string): ParsedScrubValue | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const match = NUMERIC_LENGTH_RE.exec(trimmed)
  if (!match) return null
  const magnitude = Number.parseFloat(match[1]!)
  if (!Number.isFinite(magnitude)) return null
  return { magnitude, unit: match[2] ?? '' }
}

/** Format a magnitude + unit back into a CSS length string, rounded to 2 decimal places. */
export function formatScrubValue(magnitude: number, unit: string): string {
  const rounded = Math.round(magnitude * 100) / 100
  return `${rounded}${unit}`
}

export interface ScrubDeltaOptions {
  /** Units of magnitude change per pixel of pointer movement. Default 1 (1px drag = 1 unit). */
  scale?: number
  min?: number
  max?: number
  /** Unit assigned when `raw` is empty (drag/nudge starting from nothing). Default `'px'`. */
  fallbackUnit?: string
}

/**
 * Apply a pixel-space delta (pointer drag distance, or a keyboard step
 * expressed as `direction * amount`) to a scrubbable value. Returns `null`
 * when `raw` isn't scrubbable (a keyword or an unparseable expression) —
 * callers should leave the field alone in that case, never silently coerce
 * a keyword to a number.
 */
export function applyScrubDelta(raw: string, pixelDelta: number, opts: ScrubDeltaOptions = {}): string | null {
  const fallbackUnit = opts.fallbackUnit ?? 'px'
  const parsed = parseScrubValue(raw) ?? (raw.trim() === '' ? { magnitude: 0, unit: fallbackUnit } : null)
  if (!parsed) return null
  const scale = opts.scale ?? 1
  let next = parsed.magnitude + pixelDelta * scale
  if (opts.min !== undefined) next = Math.max(opts.min, next)
  if (opts.max !== undefined) next = Math.min(opts.max, next)
  return formatScrubValue(next, parsed.unit)
}

export interface KeyboardStepOptions {
  step?: number
  shiftStep?: number
  shift?: boolean
  min?: number
  max?: number
  fallbackUnit?: string
}

/** Apply one keyboard arrow-key step (±`step`, or ±`shiftStep` with Shift held). */
export function applyKeyboardStep(raw: string, direction: 1 | -1, opts: KeyboardStepOptions = {}): string | null {
  const amount = opts.shift ? (opts.shiftStep ?? 10) : (opts.step ?? 1)
  return applyScrubDelta(raw, direction * amount, {
    scale: 1,
    min: opts.min,
    max: opts.max,
    fallbackUnit: opts.fallbackUnit,
  })
}
