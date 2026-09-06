/**
 * studioCssKeyframes — the `@keyframes` ops of the `kind: 'css'` studio edit
 * (W5-5, animation editing).
 *
 * A sibling of `studioCssWriteback.ts` rather than three more branches inside
 * it, for two reasons. The obvious one is size: that module is already at its
 * budget and these ops carry their own schemas. The load-bearing one is that
 * everything here is PURE — text in, text (or a refusal) out, no filesystem,
 * no path resolution, no knowledge of a workspace. `studioCssWriteback.ts`
 * owns all four of those things and runs them BEFORE dispatching here, so the
 * containment guard, the compiled-stylesheet check, and the actual
 * `writeFileSync` happen in exactly one place for every op regardless of which
 * module implements it. The dependency therefore runs one way, which is also
 * what keeps `no-circular-dependencies.test.ts` green.
 *
 * ## Three ops, matching the three the class path already has
 *
 *   - `keyframe-set`      ← `set`,    via `setDeclarationAtKeyframe`
 *   - `keyframe-unset`    ← `unset`,  via `removeDeclarationAtKeyframe`
 *   - `keyframes-insert`  ← `insert`, via `insertKeyframes`
 *
 * A keyframe step's declarations are diffed and written ONE AT A TIME, the
 * same as a class rule's, rather than by re-serialising the block the client
 * has in memory. Rewriting the whole block would discard every comment,
 * every blank line, and every step the editor's own parser did not
 * understand — a `@keyframes` body in a real repository is hand-authored text
 * and this pipeline's whole promise is that it stays that way.
 *
 * ## The refusal
 *
 * `analyzeKeyframesTarget` runs first, and it needs only one rule where
 * `analyzeDeclarationTarget` needs four. A second `@keyframes` block with the
 * same name does not merge with the first the way two rules with the same
 * selector do — it REPLACES it entirely — so editing the first when a second
 * exists would change the file and change nothing on screen. That is exactly
 * the outcome the "one honest target" invariant exists to prevent, so it is
 * refused by name with a sentence the user can act on.
 */
import {
  analyzeKeyframesTarget,
  insertKeyframes,
  removeDeclarationAtKeyframe,
  setDeclarationAtKeyframe,
} from '@core/css-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One declaration set inside one step of one `@keyframes` block.
 *
 * `name` is the animation name (`fade-in`), NOT the at-rule text — the client
 * reads it off the rule's `@keyframes fade-in` selector and the codemod
 * matches it against the at-rule's `params`. `step` is the offset exactly as
 * authored (`from`, `to`, `50%`, or a list like `0%, 100%`); it is matched
 * case- and whitespace-insensitively but never rewritten, so `from` never
 * silently becomes `0%`. `property` is kebab-case, like every other CSS edit's.
 */
const CssKeyframeSetEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('keyframe-set'),
  nodeId: Type.String(),
  file: Type.String(),
  name: Type.String(),
  step: Type.String(),
  property: Type.String(),
  value: Type.String(),
})

/** One declaration CLEARED from one step — the exact counterpart of `keyframe-set`. An emptied step, and an emptied block, are removed with it. */
const CssKeyframeUnsetEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('keyframe-unset'),
  nodeId: Type.String(),
  file: Type.String(),
  name: Type.String(),
  step: Type.String(),
  property: Type.String(),
})

/**
 * A WHOLE `@keyframes` block's first write — the animation a user just
 * created in the inspector, which has never existed on disk.
 *
 * `steps` is the full block, not a diff, exactly as `op: 'insert'`'s
 * `declarations` is a rule's full bag for the same reason: there is nothing to
 * diff against yet. A block of this name already in the file is MERGED into
 * rather than duplicated (`insertKeyframes`), so a retried save converges
 * instead of writing a second, shadowing definition.
 */
const CssKeyframesInsertEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('keyframes-insert'),
  nodeId: Type.String(),
  file: Type.String(),
  name: Type.String(),
  steps: Type.Array(
    Type.Object({
      keyText: Type.String(),
      declarations: Type.Record(Type.String(), Type.String()),
    }),
  ),
})

/** The three schemas, folded into `CssEditSchema`'s union by `studioCssWriteback.ts`. */
export const CssKeyframeEditSchemas = [
  CssKeyframeSetEditSchema,
  CssKeyframeUnsetEditSchema,
  CssKeyframesInsertEditSchema,
] as const

export type CssKeyframeEdit = Static<
  | typeof CssKeyframeSetEditSchema
  | typeof CssKeyframeUnsetEditSchema
  | typeof CssKeyframesInsertEditSchema
>

/** `applyKeyframeEdit`'s outcome. A `refusal` is a named, expected result carrying a sentence for the user — never an error. */
export type KeyframeEditOutcome =
  | { changed: boolean; css: string }
  | { refusal: { reason: string; message: string } }

/**
 * True for the three ops this module owns. Takes the structural minimum
 * (`{ op: string }`) rather than importing `CssEdit` from
 * `studioCssWriteback.ts`, which would make the dependency circular; the
 * narrowing at the call site still works, because these three ARE members of
 * that union.
 */
export function isKeyframeEdit(edit: { op: string }): edit is CssKeyframeEdit {
  return edit.op === 'keyframe-set' || edit.op === 'keyframe-unset' || edit.op === 'keyframes-insert'
}

/**
 * Apply one `@keyframes` edit to a stylesheet's TEXT. Pure — the caller has
 * already resolved and guarded the file, and writes the result itself. See
 * this module's doc for the check order and why the duplicate-block refusal
 * runs first.
 */
export function applyKeyframeEdit(cssText: string, edit: CssKeyframeEdit): KeyframeEditOutcome {
  const analysis = analyzeKeyframesTarget(cssText, edit.name)
  if (!analysis.ok) return { refusal: analysis.refusal }

  if (edit.op === 'keyframes-insert') {
    return insertKeyframes(cssText, edit.name, edit.steps)
  }
  if (edit.op === 'keyframe-unset') {
    return removeDeclarationAtKeyframe(cssText, edit.name, edit.step, edit.property)
  }
  return setDeclarationAtKeyframe(cssText, edit.name, edit.step, edit.property, edit.value)
}
