/**
 * animationValue — the Animations section's read/write model for the two
 * shapes a CSS animation actually arrives in.
 *
 * `boxShadowLayers.ts` is the direct precedent: parse a comma-separated CSS
 * value into structured entries, refuse (whole-value, never partially) when
 * the text is something this module would have to guess at, and serialise back
 * so the write goes through the ORDINARY declaration path every other
 * inspector control uses. Everything about writability — the
 * `StyleWriteLockContext` graying, the `unmapped`/`compiled` refusals,
 * `analyzeDeclarationTarget` — comes free from that, and nothing here needs to
 * know a stylesheet exists.
 *
 * ## Two shapes, because the parser really does deliver two
 *
 * happy-dom's CSSOM (`cssToStyleRules`) does NOT expand the `animation`
 * shorthand into longhands, and it does not collapse longhands into a
 * shorthand either — whichever the author wrote is what lands in
 * `StyleRule.styles`. So a rule reaches this module as either:
 *
 *   - `shorthand` — one `animation` declaration, possibly a comma-separated
 *     list of several animations; or
 *   - `longhand` — some subset of `animation-name`/`-duration`/`-delay`/
 *     `-timing-function`/`-iteration-count`/`-direction`/`-fill-mode`/
 *     `-play-state`, each its own comma-separated list.
 *
 * An edit writes back into the SHAPE IT FOUND. That is the "one honest
 * target" invariant applied to a shorthand: a project that wrote `animation:
 * fade 300ms` gets that line rewritten, not a competing `animation-duration`
 * longhand appended below it whose cascade position the user never asked
 * about. A rule with BOTH is `mixed` and is refused as raw text — the
 * shorthand resets every longhand declared before it and is reset BY any
 * declared after it, so which one wins depends on source order this module
 * deliberately does not model.
 *
 * ## Strict parsing, whole-value refusal
 *
 * A shorthand component is claimed by exactly one slot. Two timing functions,
 * three times, an unrecognised token once the name slot is taken — any of
 * those and the WHOLE value becomes a `raw` entry the section renders as one
 * text field, with a sentence saying why. Never a partial parse: half-reading
 * an animation and rewriting it would silently drop the half that was not
 * understood.
 *
 * `none` is the one genuinely ambiguous token (`animation-name: none` and
 * `animation-fill-mode: none` are both spellable). It is read as the NAME when
 * the name slot is still open and as the fill-mode otherwise — the reading
 * that matches how the shorthand is written in practice (`animation: none` to
 * turn an inherited animation off), and it round-trips either way.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { readString } from './styleValueUtils'

// ---------------------------------------------------------------------------
// The resolved shape
// ---------------------------------------------------------------------------

/** One animation's eight components, each defaulted to its CSS initial value. */
export interface ResolvedAnimation {
  name: string
  duration: string
  timingFunction: string
  delay: string
  iterationCount: string
  direction: string
  fillMode: string
  playState: string
}

/** Which of `ResolvedAnimation`'s components a control edits. */
export type AnimationField = keyof ResolvedAnimation

/** The initial value of every component — what the shorthand omits and what the section shows as a placeholder. */
export const ANIMATION_DEFAULTS: Readonly<ResolvedAnimation> = {
  name: '',
  duration: '0s',
  timingFunction: 'ease',
  delay: '0s',
  iterationCount: '1',
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
}

/** The `animation-*` longhand each component is written to when the source uses longhands. */
const LONGHAND_PROPERTY: Readonly<Record<AnimationField, keyof CSSPropertyBag>> = {
  name: 'animationName',
  duration: 'animationDuration',
  timingFunction: 'animationTimingFunction',
  delay: 'animationDelay',
  iterationCount: 'animationIterationCount',
  direction: 'animationDirection',
  fillMode: 'animationFillMode',
  playState: 'animationPlayState',
}

export const ANIMATION_LONGHAND_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> =
  Object.values(LONGHAND_PROPERTY)

/**
 * How a rule's animations are stored, and therefore where an edit is written.
 * `raw` and `mixed` are honest refusals, each carrying the sentence the
 * section shows; see this module's doc.
 */
export type AnimationSource =
  | { kind: 'none' }
  | { kind: 'shorthand'; animations: ResolvedAnimation[] }
  | { kind: 'longhand'; animations: ResolvedAnimation[] }
  | { kind: 'raw'; raw: string; reason: string }
  | { kind: 'mixed'; raw: string; reason: string }

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * Split a CSS value on TOP-LEVEL commas — the ones between list items, not the
 * ones inside `cubic-bezier(…)` / `steps(…)` / `linear(…)`.
 */
export function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

/** Split one list item on top-level whitespace, keeping `cubic-bezier(0, 0, 1, 1)` whole. */
function splitComponents(part: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let current = ''
  for (const char of part) {
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

const TIME_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:s|ms)$/i
const NUMBER_RE = /^\d+\.?\d*$/
const TIMING_KEYWORDS = new Set([
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
])
const TIMING_FUNCTIONS_RE = /^(?:cubic-bezier|steps|linear)\(/i
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse'])
const FILL_MODES = new Set(['forwards', 'backwards', 'both'])
const PLAY_STATES = new Set(['running', 'paused'])

/** True for anything CSS accepts as an `<easing-function>`. */
export function isTimingFunction(token: string): boolean {
  return TIMING_KEYWORDS.has(token.toLowerCase()) || TIMING_FUNCTIONS_RE.test(token)
}

/** True for a `<time>` — the unit is required, as the shorthand grammar requires it. */
export function isTimeValue(token: string): boolean {
  return TIME_RE.test(token)
}

// ---------------------------------------------------------------------------
// Parsing one shorthand item
// ---------------------------------------------------------------------------

type ParseItem = { ok: true; animation: ResolvedAnimation } | { ok: false; reason: string }

function parseShorthandItem(part: string): ParseItem {
  const animation: ResolvedAnimation = { ...ANIMATION_DEFAULTS }
  const claimed = new Set<AnimationField>()
  let timeCount = 0

  for (const token of splitComponents(part)) {
    const lower = token.toLowerCase()

    if (isTimeValue(token)) {
      if (timeCount === 0) {
        animation.duration = token
        claimed.add('duration')
      } else if (timeCount === 1) {
        animation.delay = token
        claimed.add('delay')
      } else {
        return { ok: false, reason: `"${part}" lists more than two times, which the animation shorthand does not allow.` }
      }
      timeCount += 1
      continue
    }

    if (isTimingFunction(token) && !claimed.has('timingFunction')) {
      animation.timingFunction = token
      claimed.add('timingFunction')
      continue
    }

    if ((lower === 'infinite' || NUMBER_RE.test(token)) && !claimed.has('iterationCount')) {
      animation.iterationCount = token
      claimed.add('iterationCount')
      continue
    }

    if (DIRECTIONS.has(lower) && !claimed.has('direction')) {
      animation.direction = lower
      claimed.add('direction')
      continue
    }

    if (FILL_MODES.has(lower) && !claimed.has('fillMode')) {
      animation.fillMode = lower
      claimed.add('fillMode')
      continue
    }

    if (PLAY_STATES.has(lower) && !claimed.has('playState')) {
      animation.playState = lower
      claimed.add('playState')
      continue
    }

    // `none` — see this module's doc. The name slot wins while it is open.
    if (!claimed.has('name')) {
      animation.name = token
      claimed.add('name')
      continue
    }
    if (lower === 'none' && !claimed.has('fillMode')) {
      animation.fillMode = 'none'
      claimed.add('fillMode')
      continue
    }

    return {
      ok: false,
      reason: `Studio could not tell what "${token}" means in "${part}", so this animation stays as text.`,
    }
  }

  return { ok: true, animation }
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

/**
 * One animation back to shorthand text, in the canonical component order,
 * omitting every component still at its initial value.
 *
 * `duration` is emitted whenever `delay` is — the grammar reads the FIRST time
 * as the duration and the second as the delay, so a lone delay would silently
 * become a duration.
 */
export function serializeAnimation(animation: ResolvedAnimation): string {
  const parts: string[] = []
  if (animation.name && animation.name !== ANIMATION_DEFAULTS.name) parts.push(animation.name)
  const hasDelay = animation.delay !== ANIMATION_DEFAULTS.delay
  if (animation.duration !== ANIMATION_DEFAULTS.duration || hasDelay) parts.push(animation.duration)
  if (animation.timingFunction !== ANIMATION_DEFAULTS.timingFunction) parts.push(animation.timingFunction)
  if (hasDelay) parts.push(animation.delay)
  if (animation.iterationCount !== ANIMATION_DEFAULTS.iterationCount) parts.push(animation.iterationCount)
  if (animation.direction !== ANIMATION_DEFAULTS.direction) parts.push(animation.direction)
  if (animation.fillMode !== ANIMATION_DEFAULTS.fillMode) parts.push(animation.fillMode)
  if (animation.playState !== ANIMATION_DEFAULTS.playState) parts.push(animation.playState)
  return parts.length > 0 ? parts.join(' ') : 'none'
}

/** A whole list back to one `animation` declaration value. */
export function serializeAnimations(animations: readonly ResolvedAnimation[]): string {
  return animations.map(serializeAnimation).join(', ')
}

// ---------------------------------------------------------------------------
// Resolving a rule's animations
// ---------------------------------------------------------------------------

/** Read one longhand's comma list, or `undefined` when it is not set at all. */
function longhandList(styles: Record<string, unknown>, property: keyof CSSPropertyBag): string[] | undefined {
  const raw = readString(styles, property)
  return raw == null ? undefined : splitTopLevelCommas(raw)
}

/**
 * The animations a declaration bag defines, and which shape they are stored
 * in. See this module's doc for the four outcomes and why `mixed` refuses.
 */
export function resolveAnimations(styles: Record<string, unknown>): AnimationSource {
  const shorthand = readString(styles, 'animation')
  const setLonghands = ANIMATION_LONGHAND_PROPERTIES.filter((prop) => readString(styles, prop) != null)

  if (shorthand != null && setLonghands.length > 0) {
    return {
      kind: 'mixed',
      raw: shorthand,
      reason:
        'This rule sets both the `animation` shorthand and separate `animation-*` properties. Which one wins ' +
        'depends on the order they appear in the file, so Studio will not rewrite either.',
    }
  }

  if (shorthand != null) {
    const parts = splitTopLevelCommas(shorthand)
    const animations: ResolvedAnimation[] = []
    for (const part of parts) {
      const parsed = parseShorthandItem(part)
      if (!parsed.ok) return { kind: 'raw', raw: shorthand, reason: parsed.reason }
      animations.push(parsed.animation)
    }
    if (animations.length === 0) return { kind: 'none' }
    return { kind: 'shorthand', animations }
  }

  if (setLonghands.length === 0) return { kind: 'none' }

  // Longhand form. Each longhand is its own comma list; CSS repeats a shorter
  // list to the length of `animation-name`, and so do we — that is the actual
  // cascade behaviour, not a convenience.
  const names = longhandList(styles, 'animationName') ?? ['']
  const animations = names.map((name, index) => {
    const at = (field: AnimationField): string => {
      const list = longhandList(styles, LONGHAND_PROPERTY[field])
      if (!list || list.length === 0) return ANIMATION_DEFAULTS[field]
      return list[index % list.length] ?? ANIMATION_DEFAULTS[field]
    }
    return {
      name,
      duration: at('duration'),
      timingFunction: at('timingFunction'),
      delay: at('delay'),
      iterationCount: at('iterationCount'),
      direction: at('direction'),
      fillMode: at('fillMode'),
      playState: at('playState'),
    }
  })
  return { kind: 'longhand', animations }
}

// ---------------------------------------------------------------------------
// Writing one field back
// ---------------------------------------------------------------------------

/** The declaration patch that changes one component of one animation, in the shape the source already uses. */
export function animationFieldPatch(
  source: AnimationSource,
  index: number,
  field: AnimationField,
  value: string,
): Partial<Record<keyof CSSPropertyBag, string>> | null {
  if (source.kind !== 'shorthand' && source.kind !== 'longhand') return null
  const current = source.animations[index]
  if (!current) return null

  const next = source.animations.map((animation, i) => (i === index ? { ...animation, [field]: value } : animation))

  if (source.kind === 'shorthand') return { animation: serializeAnimations(next) }
  return { [LONGHAND_PROPERTY[field]]: next.map((animation) => animation[field]).join(', ') }
}

/** The declaration patch that removes one animation from the list, or `null` when the whole declaration should be cleared instead. */
export function animationRemovalPatch(
  source: AnimationSource,
  index: number,
): Partial<Record<keyof CSSPropertyBag, string>> | null {
  if (source.kind !== 'shorthand' && source.kind !== 'longhand') return null
  const next = source.animations.filter((_, i) => i !== index)
  if (next.length === 0) return null
  if (source.kind === 'shorthand') return { animation: serializeAnimations(next) }
  const patch: Partial<Record<keyof CSSPropertyBag, string>> = {}
  for (const field of Object.keys(LONGHAND_PROPERTY) as AnimationField[]) {
    patch[LONGHAND_PROPERTY[field]] = next.map((animation) => animation[field]).join(', ')
  }
  return patch
}

/** Every `animation-*` property a `longhand`-shaped rule may need cleared when its last animation goes. */
export function animationClearProperties(source: AnimationSource): ReadonlyArray<keyof CSSPropertyBag> {
  if (source.kind === 'longhand') return ANIMATION_LONGHAND_PROPERTIES
  return ['animation']
}
