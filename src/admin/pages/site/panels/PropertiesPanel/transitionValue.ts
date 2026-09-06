/**
 * transitionValue — the Animations section's read/write model for CSS
 * transitions.
 *
 * Deliberately smaller than `animationValue.ts`, and the difference is the
 * point. W5-5 scopes transitions to READING the ones a rule declares and
 * editing their TIMING (duration, easing, delay). Authoring the property list
 * itself — deciding that `.card` should transition `transform` as well as
 * `opacity` — is out of scope, because a transition's property list is a
 * statement about which of the element's OTHER declarations are animatable,
 * and the inspector has no surface for that relationship yet. The section says
 * so in copy rather than offering a control that half-works.
 *
 * Everything else mirrors `animationValue.ts`: top-level comma splitting,
 * strict per-item parsing with a whole-value refusal, canonical
 * re-serialisation, and writes that go through the ordinary declaration path
 * so `StyleWriteLockContext` and the save-time refusals apply unchanged.
 *
 * Only the `transition` SHORTHAND is modelled. The `transition-*` longhands
 * exist and round-trip through the store untouched, but a rule that uses them
 * is reported as raw rather than restructured — the same refusal posture the
 * animation model takes for a `mixed` rule, for the same reason.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { isTimeValue, isTimingFunction, splitTopLevelCommas } from './animationValue'
import { readString } from './styleValueUtils'

/** One transition's four components, each defaulted to its CSS initial value. */
export interface ResolvedTransition {
  property: string
  duration: string
  timingFunction: string
  delay: string
}

/** Which of `ResolvedTransition`'s components a control edits — the property list is read-only (see this module's doc). */
export type TransitionField = 'duration' | 'timingFunction' | 'delay'

export const TRANSITION_DEFAULTS: Readonly<ResolvedTransition> = {
  property: 'all',
  duration: '0s',
  timingFunction: 'ease',
  delay: '0s',
}

export type TransitionSource =
  | { kind: 'none' }
  | { kind: 'shorthand'; transitions: ResolvedTransition[] }
  | { kind: 'raw'; raw: string; reason: string }

type ParseItem = { ok: true; transition: ResolvedTransition } | { ok: false; reason: string }

function parseTransitionItem(part: string, whole: string): ParseItem {
  const transition: ResolvedTransition = { ...TRANSITION_DEFAULTS }
  let timeCount = 0
  let sawProperty = false
  let sawTiming = false

  // Split on top-level whitespace, keeping `cubic-bezier(…)` whole. The
  // helper lives here rather than in `animationValue` because the two models
  // are the only callers and neither should have to import the other's
  // internals to get one loop.
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

  for (const token of tokens) {
    if (isTimeValue(token)) {
      if (timeCount === 0) transition.duration = token
      else if (timeCount === 1) transition.delay = token
      else {
        return { ok: false, reason: `"${whole}" lists more than two times, which the transition shorthand does not allow.` }
      }
      timeCount += 1
      continue
    }
    if (isTimingFunction(token) && !sawTiming) {
      transition.timingFunction = token
      sawTiming = true
      continue
    }
    if (!sawProperty) {
      transition.property = token
      sawProperty = true
      continue
    }
    return {
      ok: false,
      reason: `Studio could not tell what "${token}" means in "${whole}", so this transition stays as text.`,
    }
  }

  return { ok: true, transition }
}

/** One transition back to shorthand text, omitting components still at their initial value. */
export function serializeTransition(transition: ResolvedTransition): string {
  const parts: string[] = [transition.property]
  const hasDelay = transition.delay !== TRANSITION_DEFAULTS.delay
  if (transition.duration !== TRANSITION_DEFAULTS.duration || hasDelay) parts.push(transition.duration)
  if (transition.timingFunction !== TRANSITION_DEFAULTS.timingFunction) parts.push(transition.timingFunction)
  if (hasDelay) parts.push(transition.delay)
  return parts.join(' ')
}

export function serializeTransitions(transitions: readonly ResolvedTransition[]): string {
  return transitions.map(serializeTransition).join(', ')
}

/** The transitions a declaration bag defines. `raw` carries the sentence the section shows. */
export function resolveTransitions(styles: Record<string, unknown>): TransitionSource {
  const shorthand = readString(styles, 'transition')
  if (shorthand == null) return { kind: 'none' }
  if (shorthand.trim().toLowerCase() === 'none') return { kind: 'none' }

  const transitions: ResolvedTransition[] = []
  for (const part of splitTopLevelCommas(shorthand)) {
    const parsed = parseTransitionItem(part, shorthand)
    if (!parsed.ok) return { kind: 'raw', raw: shorthand, reason: parsed.reason }
    transitions.push(parsed.transition)
  }
  if (transitions.length === 0) return { kind: 'none' }
  return { kind: 'shorthand', transitions }
}

/** The declaration patch that changes one timing component of one transition. */
export function transitionFieldPatch(
  source: TransitionSource,
  index: number,
  field: TransitionField,
  value: string,
): Partial<Record<keyof CSSPropertyBag, string>> | null {
  if (source.kind !== 'shorthand') return null
  if (!source.transitions[index]) return null
  const next = source.transitions.map((transition, i) =>
    i === index ? { ...transition, [field]: value } : transition,
  )
  return { transition: serializeTransitions(next) }
}

/** The declaration patch that drops one transition, or `null` when the whole `transition` declaration should be cleared. */
export function transitionRemovalPatch(
  source: TransitionSource,
  index: number,
): Partial<Record<keyof CSSPropertyBag, string>> | null {
  if (source.kind !== 'shorthand') return null
  const next = source.transitions.filter((_, i) => i !== index)
  if (next.length === 0) return null
  return { transition: serializeTransitions(next) }
}
