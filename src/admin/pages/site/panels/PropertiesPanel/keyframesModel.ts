/**
 * keyframesModel — the bridge from `animation-name: fade-in` to the
 * `@keyframes fade-in` block that name refers to, and to whether that block
 * can be edited.
 *
 * ## Where a `@keyframes` block actually lives
 *
 * Nowhere special. `siteImport/keyframesToStyleRule.ts` stores it as an
 * ORDINARY `StyleRule` — `kind: 'ambient'`, `selector: '@keyframes fade-in'`,
 * and the whole block verbatim in `rawCss`, because a keyframes body is a list
 * of steps rather than a property→value map and has no `CSSPropertyBag` to
 * live in. `publisher/classCss.ts` emits that `rawCss` back out, which is why
 * an edit to it shows on the canvas immediately.
 *
 * So resolving a name is a lookup in the same `site.styleRules` registry
 * everything else in this panel already reads, and the "registry of known
 * keyframes" the Animations section needs is just that registry, filtered.
 * There is no second index to build or keep in sync.
 *
 * ## Writability is the class rule's, unchanged
 *
 * A keyframes rule is mapped to a `(file, selector)` by `studioCss.ts` exactly
 * like any other rule parsed out of a hand-authored `.css`, so
 * `resolveClassCssEditability` answers "can this be written?" for it with no
 * special case. A block that came from compiled output, or that Studio could
 * not map back to a file, gets the SAME lock reason and the same notice the
 * rest of the panel shows for an unwritable class — which is exactly what the
 * work order asks for ("compiled/module-sourced animations gray out with the
 * standard lock notice"), and it is the honest answer rather than a second
 * opinion invented here.
 *
 * ## Editing a step
 *
 * `applyKeyframeStepEdit` computes the new `rawCss` with
 * `@core/css-codemods`'s `setDeclarationAtKeyframe` /
 * `removeDeclarationAtKeyframe` — the SAME functions the server runs against
 * the real `.css` file. The canvas preview and the disk write therefore cannot
 * disagree about what an edit means; the client is not modelling the write, it
 * is performing it against a copy of the text.
 */
import type { StyleRule } from '@core/page-tree'
import {
  insertKeyframes,
  keyframesNameFromSelector,
  readKeyframeSteps,
  removeDeclarationAtKeyframe,
  setDeclarationAtKeyframe,
  type KeyframeStep,
} from '@core/css-codemods'
import { classCssWriteLockReason, resolveClassCssEditability } from './classCssWritability'

/**
 * The animation name a `@keyframes` rule defines, or `null` for any other
 * rule. The prelude parsing itself is `@core/css-codemods`', beside the
 * matcher it has to agree with — see `keyframesNameFromSelector`.
 */
export function keyframesRuleName(rule: StyleRule): string | null {
  if (rule.kind !== 'ambient') return null
  return keyframesNameFromSelector(rule.selector)
}

/** The selector a NEW `@keyframes` rule is created with — the one shape `keyframesRuleName` reads back. */
export function keyframesSelector(name: string): string {
  return `@keyframes ${name}`
}

/** Every `@keyframes` rule in the registry, by animation name. A later rule with the same name wins, matching the CSS cascade. */
export function indexKeyframesRules(styleRules: Record<string, StyleRule>): ReadonlyMap<string, StyleRule> {
  const byName = new Map<string, StyleRule>()
  for (const rule of Object.values(styleRules)) {
    const name = keyframesRuleName(rule)
    if (name) byName.set(name, rule)
  }
  return byName
}

/**
 * What the section knows about one animation's keyframes: the rule, its steps,
 * and why (if at all) they cannot be edited.
 */
export interface ResolvedKeyframes {
  rule: StyleRule
  /** Parsed out of `rule.rawCss`. Empty when the block has no steps; `null` when the text could not be parsed at all. */
  steps: KeyframeStep[] | null
  /** The standard class write-lock sentence, or `null` when edits reach disk. */
  lockReason: string | null
}

/**
 * Resolve an animation name against the registry. `null` when no `@keyframes`
 * with that name exists — a real and common state (the name may be defined in
 * a stylesheet Studio could not parse, or simply be a typo), which the section
 * reports rather than hiding.
 */
export function resolveKeyframes(
  name: string,
  keyframesByName: ReadonlyMap<string, StyleRule>,
  options: { studioSession: boolean },
): ResolvedKeyframes | null {
  const rule = keyframesByName.get(name)
  if (!rule) return null
  const steps = typeof rule.rawCss === 'string' ? readKeyframeSteps(rule.rawCss, name) : null
  const lockReason = classCssWriteLockReason(resolveClassCssEditability(rule), options)
  return { rule, steps, lockReason }
}

/**
 * The new `rawCss` for one step declaration being set or cleared, or `null`
 * when nothing changed (an already-correct value, or a step/block the text
 * does not contain).
 *
 * `value: undefined` clears. Property names are CSS kebab-case here, not the
 * editor's camelCase: a keyframes body is CSS text, and `readKeyframeSteps`
 * hands its declarations back exactly as authored.
 */
export function applyKeyframeStepEdit(
  rawCss: string,
  name: string,
  keyText: string,
  property: string,
  value: string | undefined,
): string | null {
  const result =
    value === undefined
      ? removeDeclarationAtKeyframe(rawCss, name, keyText, property)
      : setDeclarationAtKeyframe(rawCss, name, keyText, property, value)
  return result.changed ? result.css : null
}

/** The new `rawCss` with `step` added (or merged into an existing step of the same offset), or `null` when nothing changed. */
export function applyKeyframeStepInsert(rawCss: string, name: string, step: KeyframeStep): string | null {
  const result = insertKeyframes(rawCss, name, [step])
  return result.changed ? result.css : null
}

/**
 * The `@keyframes` text a newly-created animation starts from: a two-step
 * fade, the least surprising thing a "new animation" can mean and the one
 * whose effect is visible on any element without further editing.
 */
export function newKeyframesCss(name: string): string {
  return insertKeyframes('', name, [
    { keyText: 'from', declarations: { opacity: '0' } },
    { keyText: 'to', declarations: { opacity: '1' } },
  ]).css
}

/**
 * A CSS identifier safe to use as an animation name, derived from `base` and
 * made unique against the names already in the registry. Refuses nothing —
 * the caller supplies a base this function can always sanitise into something
 * valid, because a "create" gesture must not be able to fail on naming.
 */
export function uniqueKeyframesName(base: string, taken: ReadonlySet<string>): string {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const stem = /^[a-z]/.test(cleaned) ? cleaned : `animation-${cleaned}`.replace(/-+$/, '')
  if (!taken.has(stem)) return stem
  let n = 2
  while (taken.has(`${stem}-${n}`)) n += 1
  return `${stem}-${n}`
}
