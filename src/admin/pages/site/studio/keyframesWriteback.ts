/**
 * keyframesWriteback — the client half of W5-5's `@keyframes` write-back:
 * which keyframe declarations changed since the last save, and the
 * `kind: 'css'` edits that diff produces.
 *
 * A sibling of `styleRuleWriteback.ts` rather than three more branches inside
 * it, for the same reason `studioCssKeyframes.ts` is a sibling on the server:
 * that module diffs a rule's `CSSPropertyBag`, and a `@keyframes` rule does
 * not have one. Its body is a single opaque `rawCss` string — a list of steps,
 * not a property→value map — so "what changed?" is a different question with a
 * different answer, asked of a different field. Everything the two DO share
 * (the `StyleRule.id → (file, selector)` registry, `resolveCssInsertDestination`,
 * the refusal vocabulary) is imported from there; nothing is re-derived.
 *
 * ## The diff is still per-declaration, and that is the point
 *
 * The obvious implementation is to send the new block text and let the server
 * write it. That would be a rewrite, not an edit: every comment, every blank
 * line, and every step the editor's parser did not understand would vanish on
 * the first duration change. So both sides of the diff are parsed into steps
 * with `readKeyframeSteps` and compared DECLARATION BY DECLARATION, exactly as
 * `diffDeclarations` compares two style bags — the result is a handful of
 * one-property writes that postcss applies in place, and the user's file keeps
 * its shape.
 *
 * Adding and removing a whole STEP needs no separate op, and gets none: a step
 * that appears contributes its declarations as `keyframe-set` edits (and
 * `setDeclarationAtKeyframe` creates a missing step), while a step that
 * disappears contributes its declarations as `keyframe-unset` edits (and
 * `removeDeclarationAtKeyframe` drops a step it empties). Two ops, four
 * behaviours, no fourth code path to keep in agreement with the other three.
 *
 * ## The one honest gap
 *
 * A brand-new animation in a project that has NO editable stylesheet at all
 * is refused, by name, rather than written. The class path answers this case
 * with `op: 'create'`, where the SERVER invents a co-located stylesheet and
 * wires its `import` into the page — machinery that is about reaching a CLASS
 * from JSX (`ensureStylesheetImport`'s "reachability by construction") and
 * that has no meaning for an at-rule, which no `className` ever refers to.
 * Rather than half-reuse it, this reports the refusal with a sentence saying
 * what would fix it. The first class the user creates in such a project
 * creates the stylesheet; the animation is writable from then on.
 */
import type { Page, StyleRule } from '@core/page-tree'
import { keyframesNameFromSelector, readKeyframeSteps, type KeyframeStep } from '@core/css-codemods'
import {
  buildClassPageIndex,
  getStudioStyleRuleSources,
  isEditorAuthoredRuleId,
  resolveCssInsertDestination,
  type UnmappedStyleRule,
} from './cssInsertDestination'

/** One declaration set inside one keyframe step — matches `studioCssKeyframes.ts`'s `CssKeyframeSetEditSchema`. */
export interface CssKeyframeSetEditPayload {
  kind: 'css'
  op: 'keyframe-set'
  nodeId: string
  file: string
  name: string
  step: string
  property: string
  value: string
}

/** The counterpart removal — matches `CssKeyframeUnsetEditSchema`. */
export interface CssKeyframeUnsetEditPayload {
  kind: 'css'
  op: 'keyframe-unset'
  nodeId: string
  file: string
  name: string
  step: string
  property: string
}

/** A whole new block's first write — matches `CssKeyframesInsertEditSchema`. */
export interface CssKeyframesInsertEditPayload {
  kind: 'css'
  op: 'keyframes-insert'
  nodeId: string
  file: string
  name: string
  steps: KeyframeStep[]
}

export type CssKeyframeEditPayload =
  | CssKeyframeSetEditPayload
  | CssKeyframeUnsetEditPayload
  | CssKeyframesInsertEditPayload

/**
 * Every `@keyframes` rule's `rawCss` as last synced, keyed by rule id. The
 * same "only write what the user actually changed" discipline
 * `styleRuleWriteback.ts`'s `baseline` applies to declaration bags, one field
 * over.
 */
let keyframesBaseline = new Map<string, string>()

/** The animation name and body of a rule that is a `@keyframes` block, or `null`. */
function keyframesOf(rule: StyleRule): { name: string; rawCss: string } | null {
  if (rule.kind !== 'ambient') return null
  const name = keyframesNameFromSelector(rule.selector)
  if (!name) return null
  if (typeof rule.rawCss !== 'string') return null
  return { name, rawCss: rule.rawCss }
}

/**
 * Advance the keyframes diff baseline to the state just sent. Called from
 * `commitBaseline`, under the same rule: a rule whose write was REFUSED keeps
 * its previous entry, so the same change is attempted again on the next save
 * rather than being silently adopted as already-applied (`style-02`'s lesson,
 * which cost a user's work once already).
 */
export function commitKeyframesBaseline(
  styleRules: Record<string, StyleRule>,
  refusedRuleIds?: ReadonlySet<string>,
): void {
  const previous = keyframesBaseline
  keyframesBaseline = new Map()
  for (const [id, rule] of Object.entries(styleRules)) {
    const block = keyframesOf(rule)
    if (!block) continue
    if (refusedRuleIds?.has(id)) {
      const before = previous.get(id)
      if (before !== undefined) keyframesBaseline.set(id, before)
      continue
    }
    keyframesBaseline.set(id, block.rawCss)
  }
}

/** One keyframe declaration's diff outcome: a new value, or a removal. */
type StepChange = { step: string; property: string; value: string | null }

/** Steps as a lookup, keyed the way `setDeclarationAtKeyframe` matches them (case- and whitespace-insensitive). */
function stepMap(steps: readonly KeyframeStep[]): Map<string, KeyframeStep> {
  const map = new Map<string, KeyframeStep>()
  for (const step of steps) map.set(step.keyText.trim().toLowerCase().replace(/\s*,\s*/g, ','), step)
  return map
}

/**
 * The declaration-level changes between two `@keyframes` bodies, in BOTH
 * directions — see this module's doc for why a step appearing or disappearing
 * needs no op of its own.
 *
 * `null` when either side could not be parsed at all: an unparseable block is
 * not "everything changed", and emitting a write from a guess about text this
 * module could not read is precisely the corruption the whole pipeline
 * refuses.
 */
export function diffKeyframeSteps(before: string, after: string, name: string): StepChange[] | null {
  const beforeSteps = readKeyframeSteps(before, name)
  const afterSteps = readKeyframeSteps(after, name)
  if (beforeSteps === null || afterSteps === null) return null

  const beforeByKey = stepMap(beforeSteps)
  const afterByKey = stepMap(afterSteps)
  const changes: StepChange[] = []

  for (const [key, step] of afterByKey) {
    const previous = beforeByKey.get(key)
    for (const [property, value] of Object.entries(step.declarations)) {
      if (previous && previous.declarations[property] === value) continue
      changes.push({ step: step.keyText, property, value })
    }
  }

  for (const [key, step] of beforeByKey) {
    const next = afterByKey.get(key)
    for (const property of Object.keys(step.declarations)) {
      if (next && property in next.declarations) continue
      changes.push({ step: step.keyText, property, value: null })
    }
  }

  return changes
}

/** What a save should do about the `@keyframes` half of the document. */
export interface KeyframesEditPlan {
  edits: CssKeyframeEditPayload[]
  /** Animations the user changed that have no hand-editable `.css` source — reported, never dropped. */
  unmapped: UnmappedStyleRule[]
  /** Every emitted edit's synthetic `nodeId` mapped back to its `StyleRule.id`, for refusal join-back. */
  ruleIdByNodeId: Record<string, string>
}

/** The sentence for a new animation in a project with nowhere to put it — see this module's "one honest gap". */
const NO_STYLESHEET_FOR_KEYFRAMES =
  'Studio has no hand-authored stylesheet to write this animation into yet. Creating a class on this page ' +
  'makes one, and the animation saves with it from then on.'

/**
 * Diff every `@keyframes` rule's body against the last synced baseline and
 * produce its `kind: 'css'` edits, plus the changes that could not be written
 * and must therefore be reported.
 */
export function collectKeyframesEdits(
  styleRules: Record<string, StyleRule>,
  pages: readonly Page[] = [],
): KeyframesEditPlan {
  const edits: CssKeyframeEditPayload[] = []
  const unmapped: UnmappedStyleRule[] = []
  const ruleIdByNodeId: Record<string, string> = {}
  const pageIndex = buildClassPageIndex(pages)

  for (const [ruleId, rule] of Object.entries(styleRules)) {
    const block = keyframesOf(rule)
    if (!block) continue

    const before = keyframesBaseline.get(ruleId)
    if (before === block.rawCss) continue

    const label = rule.selector || rule.name
    const source = getStudioStyleRuleSources()[ruleId]

    if (!source) {
      // An IMPORTED block with no source has a real reason to stay unmapped
      // (it came from compiled output, or from a file Studio could not map);
      // only one the user created in the editor is an insert candidate.
      if (!isEditorAuthoredRuleId(ruleId)) {
        unmapped.push({ label, reason: null })
        continue
      }
      const destination = resolveCssInsertDestination(rule, pageIndex)
      if (!destination.ok) {
        unmapped.push({ label, reason: destination.message })
        continue
      }
      if (destination.kind !== 'existing') {
        unmapped.push({ label, reason: NO_STYLESHEET_FOR_KEYFRAMES })
        continue
      }
      const steps = readKeyframeSteps(block.rawCss, block.name)
      if (steps === null || steps.length === 0) continue
      const nodeId = `css:keyframes:insert:${destination.file}#${block.name}`
      ruleIdByNodeId[nodeId] = ruleId
      edits.push({ kind: 'css', op: 'keyframes-insert', nodeId, file: destination.file, name: block.name, steps })
      continue
    }

    // A block already on disk: diff it. A rule seen for the first time (no
    // baseline entry) diffs against its own text, which is a no-op — the
    // baseline is seeded by `commitBaseline` at load, so this only happens for
    // a block that arrived mid-session.
    const changes = diffKeyframeSteps(before ?? block.rawCss, block.rawCss, block.name)
    if (changes === null || changes.length === 0) continue

    for (const change of changes) {
      const nodeId = `css:keyframes:${source.file}#${block.name}#${change.step}#${change.property}`
      ruleIdByNodeId[nodeId] = ruleId
      edits.push(
        change.value === null
          ? {
              kind: 'css',
              op: 'keyframe-unset',
              nodeId,
              file: source.file,
              name: block.name,
              step: change.step,
              property: change.property,
            }
          : {
              kind: 'css',
              op: 'keyframe-set',
              nodeId,
              file: source.file,
              name: block.name,
              step: change.step,
              property: change.property,
              value: change.value,
            },
      )
    }
  }

  return { edits, unmapped, ruleIdByNodeId }
}
