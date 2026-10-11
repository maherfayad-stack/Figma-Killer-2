/**
 * studioVariantWriteback — the three component-definition edits behind
 * Figma's "Add variant", "Remove variant" and "Add property" (CV-3):
 *
 *   - `add-variant`      a new value for an enum prop: the union member, plus a
 *                        copy of the default value's rule/entry as its starting
 *                        style (`planAddVariant`).
 *   - `remove-variant`   the reverse, refused while any call site passes the
 *                        value, with the sites listed in the refusal.
 *   - `add-component-prop` a new optional boolean, text or variant prop with a
 *                        default (`addComponentProp`).
 *
 * ## Addressing
 *
 * `nodeId` is `file:line:col` of the component's declaration (the catalog's
 * `line`/`column`), so every existing rule that reads a node id — the path
 * guard, ordering, the touched-file set, the syntax guard — applies unchanged.
 * `exportName` names which component in that file. Nothing else the client
 * could send is a write target: the stylesheet, the union and the lookup entry
 * are re-read from disk here (`variantEditPlan.ts`).
 *
 * ## One undo step
 *
 * All three are journaled kinds (`studioBatchUndoJournal.ts`): the batch
 * records a pre-image of every file in {@link variantEditTouchedFiles} before
 * the first write, and ⌘Z is `restore`, which puts every file back byte for
 * byte. That needs the file set BEFORE the batch runs, so the plan is made
 * once, there, and reused by the apply as long as the files still hold the text
 * it was made against.
 *
 * ## Atomic across files
 *
 * The plan holds every file's next text. They are written one by one
 * (stylesheet first); if one write throws, the ones already written are put
 * back before the error propagates, so a failed edit leaves nothing half done.
 *
 * Imports flow one way: this module is imported by `studioEditRouting.ts`
 * (which asks for the touched files) and by the dispatcher, and imports
 * neither — the canonical-path rule is injected.
 */
import { readFileSync } from 'node:fs'
import { writeSourceFile } from '@core/page-parser'
import { PROP_NAME_PATTERN, VARIANT_NAME_PATTERN } from '@core/component-variants'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { planVariantEdit, type CanonicalSourceRel, type VariantEditPlan, type VariantEditRequest } from './studio/variantEditPlan'
import { StudioEditRefusalError } from './studioEditRefusals'
import type { StudioEditApplyOutcome } from './studioEditSchemas'

const IDENTIFIER = PROP_NAME_PATTERN.source
const VARIANT_NAME = VARIANT_NAME_PATTERN.source

const AddVariantEditSchema = Type.Object({
  kind: Type.Literal('add-variant'),
  nodeId: Type.String(),
  exportName: Type.String({ maxLength: 128 }),
  prop: Type.String({ pattern: IDENTIFIER }),
  name: Type.String({ pattern: VARIANT_NAME }),
})

const RemoveVariantEditSchema = Type.Object({
  kind: Type.Literal('remove-variant'),
  nodeId: Type.String(),
  exportName: Type.String({ maxLength: 128 }),
  prop: Type.String({ pattern: IDENTIFIER }),
  name: Type.String({ pattern: VARIANT_NAME }),
})

/** What kind of prop to add, and its default. A variant prop's first member is its default. */
const NewPropSchema = Type.Union([
  Type.Object({ kind: Type.Literal('boolean'), defaultValue: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('text'), defaultValue: Type.String({ maxLength: 200 }) }),
  Type.Object({ kind: Type.Literal('variant'), members: Type.Array(Type.String({ pattern: VARIANT_NAME }), { minItems: 2, maxItems: 24 }) }),
])

const AddComponentPropEditSchema = Type.Object({
  kind: Type.Literal('add-component-prop'),
  nodeId: Type.String(),
  exportName: Type.String({ maxLength: 128 }),
  name: Type.String({ pattern: IDENTIFIER }),
  propType: NewPropSchema,
})

/** The three variant edit kinds, folded into `StudioEditSchema` by `studioEditSchemas.ts`. */
export const VariantEditSchemas = [AddVariantEditSchema, RemoveVariantEditSchema, AddComponentPropEditSchema] as const

export const VariantEditSchema = Type.Union([...VariantEditSchemas])
export type VariantEdit = Static<typeof VariantEditSchema>

export function isVariantEditKind(kind: string): kind is VariantEdit['kind'] {
  return kind === 'add-variant' || kind === 'remove-variant' || kind === 'add-component-prop'
}

/** {@link isVariantEditKind}, narrowing the edit itself. */
export function isVariantEdit(edit: { kind: string }): edit is VariantEdit {
  return isVariantEditKind(edit.kind)
}

function requestOf(edit: VariantEdit): VariantEditRequest {
  if (edit.kind === 'add-component-prop') {
    const { propType } = edit
    const prop =
      propType.kind === 'boolean'
        ? ({ kind: 'boolean', name: edit.name, defaultValue: propType.defaultValue } as const)
        : propType.kind === 'text'
          ? ({ kind: 'text', name: edit.name, defaultValue: propType.defaultValue } as const)
          : ({ kind: 'variant', name: edit.name, members: propType.members } as const)
    return { kind: edit.kind, exportName: edit.exportName, prop }
  }
  return { kind: edit.kind, exportName: edit.exportName, prop: edit.prop, name: edit.name }
}

/** Plans made ahead of a batch (for its touched-file set), keyed by the edit object the batch will apply. */
const planned = new WeakMap<VariantEdit, { componentRel: string; plan: VariantEditPlan }>()

function planFor(dir: string, edit: VariantEdit, componentRel: string, canonicalRel: CanonicalSourceRel): VariantEditPlan {
  const plan = planVariantEdit(dir, requestOf(edit), componentRel, canonicalRel)
  planned.set(edit, { componentRel, plan })
  return plan
}

/**
 * Every file this edit would write, absolute — so the batch can journal their
 * pre-images before it writes any. A refused plan has none: the apply plans
 * again and throws the refusal, so the person reads it from the batch.
 */
export function variantEditTouchedFiles(dir: string, edit: VariantEdit, componentRel: string, canonicalRel: CanonicalSourceRel): string[] {
  const plan = planFor(dir, edit, componentRel, canonicalRel)
  return plan.ok ? plan.writes.map((write) => write.abs) : []
}

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8')
  } catch (_err) {
    // A file that cannot be read no longer matches the plan; the apply plans again and refuses by name.
    return undefined
  }
}

/** The cached plan while every file it was made against still holds that text; else a fresh one. */
function currentPlan(dir: string, edit: VariantEdit, componentRel: string, canonicalRel: CanonicalSourceRel): VariantEditPlan {
  const cached = planned.get(edit)
  if (cached && cached.componentRel === componentRel && cached.plan.ok && cached.plan.writes.every((write) => readText(write.abs) === write.original)) {
    return cached.plan
  }
  return planFor(dir, edit, componentRel, canonicalRel)
}

/**
 * Writes the plan. If a write throws, every file already written is put back
 * to the text the plan was made against, then the error propagates.
 */
function commitWrites(plan: Extract<VariantEditPlan, { ok: true }>): void {
  const written: typeof plan.writes = []
  try {
    for (const write of plan.writes) {
      writeSourceFile(write.abs, write.next)
      written.push(write)
    }
  } catch (err) {
    for (const write of written.reverse()) writeSourceFile(write.abs, write.original)
    throw new Error('[studio:variants] a write failed; the files already written were put back', { cause: err })
  }
}

/**
 * Applies one variant edit. Throws a {@link StudioEditRefusalError} for every
 * named decline (the batch reports it); returns `applied: true` once every
 * file is written.
 */
export function applyVariantEdit(
  dir: string,
  edit: VariantEdit,
  location: { rel: string },
  canonicalRel: CanonicalSourceRel,
): StudioEditApplyOutcome {
  const plan = currentPlan(dir, edit, location.rel, canonicalRel)
  if (!plan.ok) throw new StudioEditRefusalError(plan.reason, plan.message)
  commitWrites(plan)
  planned.delete(edit)
  return { applied: true }
}
