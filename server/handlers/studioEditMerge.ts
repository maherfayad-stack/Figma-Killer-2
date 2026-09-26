/**
 * studioEditMerge — what happens when two edits in one save batch name the
 * SAME source location (WB-7). `dedupeStudioEdits` (`studioEditRouting.ts`)
 * decides WHICH edits share a target; this module decides what the one edit
 * that reaches the codemod says.
 *
 * ## Why "keep the last" was wrong for two kinds
 *
 * Every instance of an inlined component writes back to the same `line:col`
 * in the component's own file. A `prop`/`text`/`literal`/`tag` edit
 * OVERWRITES that span with one value, so two of them are a genuine conflict
 * and the last is the honest reading — the file can only hold one title.
 *
 * `style` and `class` are not like that. Each carries a SET of changes to one
 * attribute: `{ padding }` on instance A and `{ margin }` on instance B are two
 * different declarations the user asked for, and `+a` / `+b` are two different
 * tokens. Keeping only B's edit wrote `margin` and `b`, reported `written: 2`,
 * and the client adopted both baselines — so `padding` and `a` stayed on the
 * canvas until the next reload and then disappeared for good. So:
 *
 * - **`style`** — the declarations are unioned, and so are the `remove` lists.
 *   A property both set and removed resolves by order: the later edit wins.
 * - **`class`** — the `add` and `remove` token sets are unioned. A token both
 *   added and removed resolves by order: the later edit wins.
 * - **everything else** — the later edit replaces the earlier one, unchanged.
 *
 * ## Every node behind a merged edit shares its outcome
 *
 * The merged edit keeps the LAST edit's `nodeId` — the codemod only needs one,
 * and they all decode to the same location. The others ride along as
 * `absorbedNodeIds`, so when the one write is refused or skipped,
 * `expandMergedOutcomes` reports the same outcome for every node that
 * contributed to it. Without that, a refused class edit held back only the
 * last instance's `classIds` baseline and silently adopted the rest.
 */
import type { StudioClassNameToken, StudioEdit } from './studioEditSchemas'

type StyleEdit = Extract<StudioEdit, { kind: 'style' }>
type ClassEdit = Extract<StudioEdit, { kind: 'class' }>

/** An edit after dedupe: the edit itself, plus the other node ids whose edits collapsed into it. */
export type DedupedStudioEdit<T> = T & { readonly absorbedNodeIds?: readonly string[] }

function isStyleEdit(edit: { kind: string }): edit is StyleEdit {
  return edit.kind === 'style'
}

function isClassEdit(edit: { kind: string }): edit is ClassEdit {
  return edit.kind === 'class'
}

/**
 * The one edit `earlier` and `later` (same target, same kind, same `prop`)
 * collapse into. See this module's doc for the per-kind rule.
 */
export function collapseSameTargetEdits<T extends { nodeId: string; kind: string }>(
  earlier: DedupedStudioEdit<T>,
  later: T,
): DedupedStudioEdit<T> {
  const merged: T =
    isStyleEdit(earlier) && isStyleEdit(later)
      ? { ...later, ...mergeStyle(earlier, later) }
      : isClassEdit(earlier) && isClassEdit(later)
        ? { ...later, ...mergeClass(earlier, later) }
        : later
  const absorbed = new Set([...(earlier.absorbedNodeIds ?? []), earlier.nodeId])
  absorbed.delete(merged.nodeId)
  return absorbed.size > 0 ? { ...merged, absorbedNodeIds: [...absorbed] } : merged
}

function mergeStyle(earlier: StyleEdit, later: StyleEdit): Pick<StyleEdit, 'style' | 'remove'> {
  const style: StyleEdit['style'] = {}
  const remove = new Set<string>()
  for (const edit of [earlier, later]) {
    for (const [property, value] of Object.entries(edit.style)) {
      style[property] = value
      remove.delete(property)
    }
    for (const property of edit.remove ?? []) {
      remove.add(property)
      delete style[property]
    }
  }
  return { style, remove: remove.size > 0 ? [...remove] : undefined }
}

/** A token's identity: two tokens are the same class exactly when these match. */
function tokenKey(token: StudioClassNameToken): string {
  return token.kind === 'literal' ? `literal:${token.token}` : `module:${token.file}#${token.local}`
}

function mergeClass(earlier: ClassEdit, later: ClassEdit): Pick<ClassEdit, 'add' | 'remove'> {
  const add = new Map<string, StudioClassNameToken>()
  const remove = new Map<string, StudioClassNameToken>()
  for (const edit of [earlier, later]) {
    for (const token of edit.add) {
      remove.delete(tokenKey(token))
      add.set(tokenKey(token), token)
    }
    for (const token of edit.remove) {
      add.delete(tokenKey(token))
      remove.set(tokenKey(token), token)
    }
  }
  return { add: [...add.values()], remove: [...remove.values()] }
}

/**
 * Repeats every refusal a merged edit earned for each node it absorbed, so the
 * refusals stay one per per-node outcome the client reads (WB-35 — every
 * contributing node's baseline is held back, not only the last one's).
 * Matched on kind AND node id: one node can carry a merged `style` edit and a
 * merged `class` edit in the same batch, each with its own absorbed set.
 */
export function expandMergedOutcomes<R extends { nodeId: string; kind: string }>(
  applied: readonly DedupedStudioEdit<{ nodeId: string; kind: string }>[],
  refusals: R[],
): void {
  const absorbedBy = new Map<string, readonly string[]>()
  for (const edit of applied) {
    if (edit.absorbedNodeIds?.length) absorbedBy.set(outcomeKey(edit), edit.absorbedNodeIds)
  }
  if (absorbedBy.size === 0) return
  repeatForAbsorbed(refusals, absorbedBy)
}

function outcomeKey(outcome: { nodeId: string; kind: string }): string {
  return `${outcome.kind}|${outcome.nodeId}`
}

function repeatForAbsorbed<O extends { nodeId: string; kind: string }>(
  outcomes: O[],
  absorbedBy: ReadonlyMap<string, readonly string[]>,
): void {
  for (const outcome of [...outcomes]) {
    for (const nodeId of absorbedBy.get(outcomeKey(outcome)) ?? []) outcomes.push({ ...outcome, nodeId })
  }
}
