/**
 * structuralUndoPlan — how a structural gesture that wrote the user's source
 * says what its own undo is.
 *
 * ## Why an undo has to be a WRITE
 *
 * `store-08` already established the half of this that involves the tree:
 * `saveSite` diffs node VALUES and has no notion of parent, order or child
 * list, so replaying a structural transaction's inverse patches moves the
 * element on the canvas, leaves the `.tsx` saying the opposite, and the next
 * reparse silently wins. The undo has to be the inverse WRITE.
 *
 * The family this module covers — insert, duplicate, wrap, group, ungroup,
 * paste, transplant, the `<img>` an OS file drop becomes, DELETE, and the
 * instance rewrites (detach, swap, extract) — never even reaches the patch stack for its UNDO: `delete` itself
 * still mutates the tree eagerly, for the same-tick optimistic removal
 * `broadcastOptimisticDelete` exists for, but that mutation's own patches are
 * never replayed (see `structuralHistory.ts`'s `tagStructuralGesture`, which
 * tags the entry the mutation already pushed with a `source` gesture instead
 * of leaving it as a bare patch pair). Every OTHER member of the family
 * mutates NO tree at all (`studioSourceWrites.ts`'s own contract, "the board
 * is NOT updated here"), so before this module they pushed no history entry
 * at all and ⌘Z after one of them undid whatever came before it (`canvas-20`,
 * landmine 10).
 *
 * ## The inverse is expressed in the edit kinds that already exist
 *
 * Where the protocol can say it, the inverse is an ordinary edit:
 *
 * | gesture | inverse |
 * |---|---|
 * | insert / duplicate / paste / image drop | `delete` what it created |
 * | wrap / group | `ungroup` the container it created |
 * | ungroup | `group` the children it released, back into the same container |
 * | transplant (move) | `transplant` back to the parent it left |
 * | transplant (copy) | `delete` the copy it created |
 * | delete / detach / swap / extract | `restore` the undo-journal entry the write recorded |
 *
 * The last row is the exception, and the only one: what those four replace is
 * source text no edit kind describes (the deleted element's bytes, the call
 * site a detach inlined). The server keeps what the files were
 * (`server/handlers/studio/undoJournal.ts`, P3-F) and reports a token; the
 * inverse names that token. It applies only while every file is exactly what
 * the write left, so it can never overwrite a later change.
 *
 * That is why a codemod reporting the ids it CREATED (`store-13`) and the ids
 * it RELOCATED are both preconditions for undo: the inverse cannot be written
 * down at gesture time, because it addresses elements the write had not made
 * yet. So a gesture records a TEMPLATE, and `resolveStructuralInverse` fills
 * it in from what the commit came back with.
 *
 * ## Why a template and not a closure
 *
 * The resolved inverse has to be re-resolvable: after a ⌘⇧Z the gesture has
 * been performed a second time, at a position that may not be the first one's,
 * so the entry's inverse has to be recomputed from the REDO's own outcome. A
 * closure on a history entry would be a function living in store state; a
 * template is data, is inspectable in a test, and can be resolved twice.
 *
 * ## The ordering property this rests on
 *
 * A resolved inverse names absolute `rel:line:col` ids, and every later
 * structural write in the same file shifts them. That is safe because undo is
 * strictly LIFO: undoing the top entry restores the file to the state the
 * entry BELOW it was recorded against, so each inverse is always evaluated
 * against exactly the state it was computed in. What can break the chain is a
 * write that is not on the stack (an external editor, a prop edit that
 * collapsed a `style={{…}}` onto one line). `reissueStructuralSourceEdits`
 * checks every id the inverse names against the live tree before posting, and
 * refuses by name — with the file it was about to write — rather than deleting
 * whatever happens to sit at that line now.
 */

import { canvasLayerEditNodeId, type CanvasLayerPlacementChange } from '@core/studio-board'

/** One edit exactly as `postEdits` puts it on the wire. `kind`/`nodeId` are read back here; the rest rides through. */
export interface StructuralEditPayload {
  kind: string
  nodeId: string
  [field: string]: unknown
}

/** How a `wrap`/`group` edit spells its container — the registry's answer, carried so an undo can write the same one back. */
export interface StructuralContainerSpelling {
  name: string
  importSpecifier?: string
  designSystemImport?: true
}

/**
 * What a gesture's inverse is, before the write has said what it made.
 *
 * `unsupported` is a first-class member rather than "record nothing": a
 * gesture that pushes no entry lets ⌘Z silently undo something older, which is
 * the one behaviour worse than refusing. It carries the sentence the user is
 * shown.
 */
export type StructuralInverseTemplate =
  | { kind: 'delete-created' }
  | { kind: 'ungroup-created' }
  | { kind: 'group-relocated'; container: StructuralContainerSpelling }
  | {
      kind: 'transplant-back'
      /** The container it left. An ancestor's own tag sits ABOVE its children, so removing one does not move it. */
      parentNodeId: string
      /** Which child it was. The SIBLING to anchor against is resolved from the live tree at undo time — see {@link anchorTransplantBack}. */
      index: number
    }
  /**
   * P3-F — the inverse of a one-shot write (delete, detach, swap, extract):
   * `restore` the undo-journal entry its batch recorded. Nothing to capture at
   * gesture time — the token is the write's own answer
   * (`StructuralWriteOutcome.undoToken`), and a redo's write records a fresh one.
   */
  | { kind: 'restore-journal' }
  | {
      /**
       * P5-B (IMG-3) — an inverse that is fully known at gesture time,
       * because the gesture rewrites a value in place rather than creating or
       * moving markup: an image dropped onto an import-bound `<img>` repoints
       * the import (`kind: 'asset'`), and its undo points it back at the file
       * it named before. Nothing the write reports can change it.
       */
      kind: 'known'
      inverse: StructuralEditPayload[]
    }
  | { kind: 'unsupported'; message: string }
  // ── P5-G, the free canvas ────────────────────────────────────────────────
  /** A layer this gesture made (a create, a lifted COPY): delete its module. Known at gesture time — the layer id is minted by the client. */
  | { kind: 'canvas-layer-delete'; layerId: string }
  /** A layer delete: write each module back, byte for byte, from the `removed` bytes the delete reported. */
  | { kind: 'canvas-layer-restore-removed'; layerIds: string[] }
  /** A layer placed into a frame (a move): delete what it wrote into the page and write the module back. */
  | { kind: 'canvas-layer-unplace'; layerId: string }
  /**
   * An element lifted out of a frame (a move): place the new layer's root back
   * into the container it left — `transplant-back`'s shape, with the same
   * live-tree anchor resolution ({@link anchorTransplantBack}).
   */
  | { kind: 'canvas-layer-lift-back'; layerId: string; parentNodeId: string; index: number }

/** One `canvas-layer-delete`'s module bytes — `StructuralWriteOutcome.removed`'s own shape, keyed by the edit's `nodeId`. */
export interface StructuralRemovedText {
  nodeId: string
  text: string
  wholeLine: boolean
}

/** What a landed structural write reported about the elements it touched. */
export interface StructuralWriteOutcome {
  createdNodeIds: readonly string[]
  relocatedNodeIds: readonly string[]
  /** P5-G — every `canvas-layer-delete`'s module bytes. Empty when the batch removed no layer. */
  removed: readonly StructuralRemovedText[]
  /** P3-F — the undo-journal token for a journaled one-shot write; `null` when the batch recorded none. */
  undoToken: string | null
}

/** The synthetic id a `restore` edit is reported under — it addresses no element (`studioEditSchemas.ts`). */
function restoreEditNodeId(token: string): string {
  return `undo-journal:${token}`
}

/** The `restore` edit that puts back the write behind `token`. */
export function restoreEdit(token: string): StructuralEditPayload {
  return { kind: 'restore', nodeId: restoreEditNodeId(token), token }
}

/**
 * The inverse edits for this gesture, or `null` when it has none that the
 * writeback protocol can express.
 *
 * `null` is also the answer when the write reported nothing to address — a
 * codemod that wrote but could not confirm the new position reports no id at
 * all (`createdJsxLocation.ts`: a wrong id is worse than no id), and an undo
 * that guessed one would delete an element the user never made.
 */
export function resolveStructuralInverse(
  template: StructuralInverseTemplate,
  outcome: StructuralWriteOutcome,
): StructuralEditPayload[] | null {
  switch (template.kind) {
    case 'unsupported':
      return null
    case 'known':
      return template.inverse.map((edit) => ({ ...edit }))
    case 'delete-created': {
      if (outcome.createdNodeIds.length === 0) return null
      return outcome.createdNodeIds.map((nodeId) => ({ kind: 'delete', nodeId }))
    }
    case 'ungroup-created': {
      if (outcome.createdNodeIds.length === 0) return null
      return outcome.createdNodeIds.map((nodeId) => ({ kind: 'ungroup', nodeId }))
    }
    case 'group-relocated': {
      const [first, ...rest] = outcome.relocatedNodeIds
      if (first === undefined) return null
      // A container that held ONE child is re-created by `wrap`, and one that
      // held several by `group` — the same split `writeGroupToSource` makes on
      // the way out, so the undo writes through the codemod the gesture's own
      // forward direction would have used.
      return [
        rest.length === 0
          ? { kind: 'wrap', nodeId: first, ...template.container }
          : { kind: 'group', nodeId: first, siblingNodeIds: rest, ...template.container },
      ]
    }
    case 'transplant-back': {
      const [moved] = outcome.relocatedNodeIds
      if (moved === undefined) return null
      // No anchor yet: every sibling BELOW the element the transplant removed
      // shifted up when it left, so an anchor recorded at gesture time would
      // name a line that has moved. `anchorTransplantBack` fills it in from the
      // tree as it is when ⌘Z is pressed. Appending is the honest fallback the
      // wire already gives a missing anchor.
      return [{ kind: 'transplant', nodeId: moved, parentNodeId: template.parentNodeId }]
    }
    case 'restore-journal':
      return outcome.undoToken === null ? null : [restoreEdit(outcome.undoToken)]
    case 'canvas-layer-delete':
      return [{ kind: 'canvas-layer-delete', nodeId: canvasLayerEditNodeId(template.layerId), layerId: template.layerId }]
    case 'canvas-layer-restore-removed': {
      // All or nothing: restoring two of three layers silently drops the third.
      const byNodeId = new Map(outcome.removed.map((r) => [r.nodeId, r] as const))
      const texts = template.layerIds.map((layerId) => byNodeId.get(canvasLayerEditNodeId(layerId))?.text)
      if (texts.some((text) => text === undefined)) return null
      return template.layerIds.map((layerId, i) => ({
        kind: 'canvas-layer-restore',
        nodeId: canvasLayerEditNodeId(layerId),
        layerId,
        text: texts[i]!,
      }))
    }
    case 'canvas-layer-unplace': {
      const [created] = outcome.createdNodeIds
      const [removed] = outcome.removed
      if (created === undefined || removed === undefined) return null
      return [
        { kind: 'delete', nodeId: created },
        { kind: 'canvas-layer-restore', nodeId: canvasLayerEditNodeId(template.layerId), layerId: template.layerId, text: removed.text },
      ]
    }
    case 'canvas-layer-lift-back': {
      const [root] = outcome.createdNodeIds
      if (root === undefined) return null
      return [{ kind: 'canvas-layer-place', nodeId: root, layerId: template.layerId, parentNodeId: template.parentNodeId }]
    }
  }
}

/**
 * The workspace-relative file a `rel:line:col` node id names — everything
 * before the `line:col` tail. `structuralSourceHistory.ts` names the file an
 * unresolved id belongs to with it.
 */
export function fileOfNodeId(nodeId: string): string {
  return nodeId.split(':').slice(0, -2).join(':') || nodeId
}

/**
 * Every field on an edit payload that names a node id.
 *
 * One list, read by both the pre-flight check that refuses an undo whose ids
 * no longer resolve and the reparse re-addressing that keeps them resolving
 * (`historyNodeIdRemap.ts`). Two copies of it would drift the moment a kind
 * gains a second location, and the two failure modes are opposite: a missed
 * field makes the check permissive and the remap incomplete.
 */
const NODE_ID_FIELDS = ['anchorNodeId', 'parentNodeId'] as const

/**
 * True for an edit whose `nodeId` names a LITERAL's position (an import
 * specifier, for `kind: 'asset'`) rather than an element on the board — so
 * "is that id still a node on the board" is the wrong pre-flight question for
 * it. Its own guard is the server's: the literal's fingerprint (P1-A) refuses
 * `element-moved` when that position now holds something else.
 */
export function addressesSourceLiteral(edit: StructuralEditPayload): boolean {
  return edit.kind === 'asset'
}

/**
 * True for a `restore` (P3-F): its `nodeId` is a journal entry's synthetic
 * key, never an element, so "is that id still on the board" does not apply.
 * Its own guard is the server's compare-and-swap: it refuses `restore-stale`
 * unless every file is exactly what the write left.
 */
export function addressesJournalEntry(edit: StructuralEditPayload): boolean {
  return edit.kind === 'restore'
}

/** Every node id one edit payload names, `nodeId` first — the order a reader would look for them. */
export function structuralEditNodeIds(edit: StructuralEditPayload): string[] {
  const ids = [edit.nodeId]
  for (const field of NODE_ID_FIELDS) {
    const value = edit[field]
    if (typeof value === 'string') ids.push(value)
  }
  const siblings = edit.siblingNodeIds
  if (Array.isArray(siblings)) {
    for (const sibling of siblings) if (typeof sibling === 'string') ids.push(sibling)
  }
  return ids
}

/**
 * Rewrite every node id these edits name through `remap` — what a reparse that
 * renumbered the file owes a stored undo.
 *
 * Without it, a structural write anywhere above an older entry's target would
 * leave that entry addressing a line something else has since moved into, and
 * the pre-flight check in `structuralSourceHistory.ts` would either refuse a
 * perfectly good undo or (worse, when the shift PERMUTED addresses rather than
 * vacating them) let it through. `historyNodeIdRemap.ts`'s isomorphic walk is
 * what makes the correspondence available; this is the part of the entry it
 * applies to.
 */
export function remapStructuralEditIds(
  edits: StructuralEditPayload[],
  remap: ReadonlyMap<string, string>,
): StructuralEditPayload[] {
  // The same array reference back when nothing changed, so a reload that
  // renumbered ids elsewhere in the project keeps `remapHistoryEntries`' "real
  // keep, not a copy" property for the entries it did not touch.
  if (!edits.some((edit) => structuralEditNodeIds(edit).some((id) => remap.has(id)))) return edits
  return edits.map((edit) => {
    const next: StructuralEditPayload = { ...edit, nodeId: remap.get(edit.nodeId) ?? edit.nodeId }
    for (const field of NODE_ID_FIELDS) {
      const value = edit[field]
      if (typeof value === 'string') next[field] = remap.get(value) ?? value
    }
    const siblings = edit.siblingNodeIds
    if (Array.isArray(siblings)) {
      next.siblingNodeIds = siblings.map((s) => (typeof s === 'string' ? remap.get(s) ?? s : s))
    }
    return next
  })
}

/** The same, for the templates that name node ids of their own. */
export function remapInverseTemplate(
  template: StructuralInverseTemplate,
  remap: ReadonlyMap<string, string>,
): StructuralInverseTemplate {
  if (template.kind === 'transplant-back' || template.kind === 'canvas-layer-lift-back') {
    return { ...template, parentNodeId: remap.get(template.parentNodeId) ?? template.parentNodeId }
  }
  return template
}

/**
 * Point a resolved `transplant-back` at the sibling it should land before,
 * using the destination parent's CURRENT child list.
 *
 * Called at re-issue time, where the tree is the one the last resync left
 * behind: `children[index]` is whatever now occupies the slot the element was
 * taken out of, so writing before it restores the original order. An index
 * past the end means it was the last child, and appending — the edit as
 * `resolveStructuralInverse` left it — is exactly right.
 *
 * A no-op for every other template, so the caller can pipe every inverse
 * through it.
 */
export function anchorTransplantBack(
  edits: readonly StructuralEditPayload[],
  template: StructuralInverseTemplate,
  parentChildIds: readonly string[],
): StructuralEditPayload[] {
  if (template.kind !== 'transplant-back' && template.kind !== 'canvas-layer-lift-back') return [...edits]
  const anchorNodeId = parentChildIds[template.index]
  if (anchorNodeId === undefined) return [...edits]
  return edits.map((edit) =>
    edit.kind === 'transplant' || edit.kind === 'canvas-layer-place' ? { ...edit, anchorNodeId, position: 'before' } : edit,
  )
}

/** The sentence an `unsupported` inverse carries, or `null` for every template that has a real inverse. */
export function unsupportedInverseMessage(template: StructuralInverseTemplate): string | null {
  return template.kind === 'unsupported' ? template.message : null
}

/**
 * One source-writing structural gesture, as the undo stack holds it.
 *
 * `forward` is replayable as REDO because undoing the gesture restores the
 * file to the bytes `forward` was planned against (see this module's LIFO
 * note). `inverse` is `null` when the gesture has no undo the protocol can
 * express — the entry still exists, so ⌘Z lands on it and says so rather than
 * silently undoing something older.
 */
export interface StructuralSourceGesture {
  /** What the user did, in the words the undo status uses. */
  label: string
  /**
   * Mutable arrays rather than `readonly` ones: a history entry lives inside
   * the Mutative draft the store commits it through, and `Draft<T>` cannot
   * narrow a `readonly` array to a drafted one. Nothing writes through these —
   * the store copies before posting.
   */
  forward: StructuralEditPayload[]
  /**
   * P3-D — `forward` is a SEQUENCE: its edits were written in order, each
   * against the file the previous one left (several copies dropped at one
   * place, a paste of several roots). A redo re-posts it the same way; posted
   * as an ordinary batch the steps would be applied bottom-to-top against ids
   * the earlier steps move.
   */
  sequence?: true
  inverseTemplate: StructuralInverseTemplate
  inverse: StructuralEditPayload[] | null
  /**
   * P5-G — the free-canvas placements this gesture changed. A create, place,
   * lift or delete of a loose layer is one write to source AND one change to
   * `.studio/boards.json`, and one ⌘Z takes back both: undo puts `before`
   * back, redo `after` (`structuralSourceHistory.ts`). Absent for every
   * gesture that touches no loose layer.
   */
  placements?: CanvasLayerPlacementChange[]
}

/**
 * `store-14` — how a ⌘G / wrap says what its own ⌘Z is.
 *
 * The inverse of "put a container around this" is "dissolve that container" —
 * the same `ungroup` write ⌘⇧G performs, which restores the children at their
 * own indentation and takes the wrapper's import with it.
 *
 * That only holds for an INTRINSIC wrapper. `unwrapJsxElement` refuses a
 * COMPONENT tag by name (`has-behaviour`): its own file decides what it
 * renders, so removing the call site is not "ungroup", it is deleting a
 * component usage. A group into a design-system container therefore has no
 * inverse this protocol can write, and says so at ⌘Z rather than posting a
 * write the server would refuse with a sentence about behaviour the user never
 * mentioned.
 */
export function dissolveWrapperTemplate(wrapper: {
  name: string
  importSpecifier?: string
  designSystemImport?: true
}): StructuralInverseTemplate {
  if (wrapper.importSpecifier === undefined && wrapper.designSystemImport === undefined) {
    return { kind: 'ungroup-created' }
  }
  return {
    kind: 'unsupported',
    message: `That group was written as a <${wrapper.name}> component, and Studio only dissolves plain containers — taking it back out would mean deleting a component call site, which is a different change from the one you made. Remove it in code, or use your editor’s undo.`,
  }
}
