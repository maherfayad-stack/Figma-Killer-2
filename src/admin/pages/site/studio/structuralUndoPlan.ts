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
 * paste, transplant, the `<img>` an OS file drop becomes, and (`store-15`)
 * DELETE — never even reaches the patch stack for its UNDO: `delete` itself
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
 * No `revert` edit kind, and no file snapshot. Every inverse here is something
 * the writeback protocol can already say:
 *
 * | gesture | inverse |
 * |---|---|
 * | insert / duplicate / paste / image drop | `delete` what it created |
 * | wrap / group | `ungroup` the container it created |
 * | ungroup | `group` the children it released, back into the same container |
 * | transplant (move) | `transplant` back to the parent it left |
 * | transplant (copy) | `delete` the copy it created |
 * | delete | `reinsert-source` each element back where it was |
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
  | {
      /**
       * `store-15` — the inverse of a `delete`: one `reinsert-source` edit
       * per deleted node, written back to `parentNodeId` at `index` — both
       * captured from the live tree BEFORE the delete, at gesture time
       * (`captureDeleteOrigin`), the only moment the pre-delete position is
       * still known. `nodeId` is the deleted element's OWN original id,
       * carried only to look up its bytes in the outcome's `removed` list —
       * it names nothing to write to.
       */
      kind: 'reinsert-deleted'
      // A plain mutable array, not `readonly` — a history entry lives inside
      // the Mutative draft the store commits it through, and `Draft<T>`
      // cannot narrow a `readonly` array to a drafted one. Same reasoning as
      // `StructuralSourceGesture.forward`/`.inverse` just below.
      nodes: { nodeId: string; parentNodeId: string; index: number }[]
    }
  | {
      /**
       * P3-D (OD-7) — the inverse of a `detach`: the markup that replaced the
       * call site goes (`delete` of what the detach CREATED — the batch's
       * prune pass takes the imports it added with it), and the call site's
       * own bytes go back where they were (`reinsert-source` at the slot
       * captured before the detach, with the component import the detach's
       * prune pass reported). One batch: the delete is below the parent's own
       * tag, so the batch's bottom-to-top order applies it first.
       */
      kind: 'reinsert-detached'
      /** The call site's id when the detach was made — the key its `removed` bytes are reported under. */
      callSiteNodeId: string
      parentNodeId: string
      index: number
    }
  | { kind: 'unsupported'; message: string }

/** One `delete` edit's own discarded bytes — `StructuralWriteOutcome.removed`'s own shape, keyed by the edit's `nodeId`. */
export interface StructuralRemovedText {
  nodeId: string
  text: string
  wholeLine: boolean
}

/** One file's pruned imports — `StructuralWriteOutcome.prunedImports`'s own shape. */
export interface StructuralPrunedImports {
  /** Workspace-relative POSIX path — the same shape `structuralEditNodeIds` derives a node id's file as. */
  file: string
  declarations: readonly string[]
}

/** What a landed structural write reported about the elements it touched. */
export interface StructuralWriteOutcome {
  createdNodeIds: readonly string[]
  relocatedNodeIds: readonly string[]
  /** `store-15` — every `delete` edit's own discarded bytes. Empty when the batch deleted nothing. */
  removed: readonly StructuralRemovedText[]
  /** `store-15` — every file whose import a `delete`'s prune pass removed. Empty when nothing was pruned. */
  prunedImports: readonly StructuralPrunedImports[]
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
    case 'reinsert-detached': {
      const [inlined] = outcome.createdNodeIds
      const callSite = outcome.removed.find((entry) => entry.nodeId === template.callSiteNodeId)
      if (inlined === undefined || !callSite) return null
      const imports = outcome.prunedImports.find((entry) => entry.file === fileOfNodeId(template.parentNodeId))?.declarations ?? []
      return [
        { kind: 'delete', nodeId: inlined },
        {
          kind: 'reinsert-source',
          nodeId: template.parentNodeId,
          index: template.index,
          text: callSite.text,
          ...(imports.length > 0 ? { imports: [...imports] } : {}),
        },
      ]
    }
    case 'reinsert-deleted': {
      // `null` — not "skip the ones we can" — the moment ANY deleted node's
      // bytes did not come back: an undo that restores three of four elements
      // silently drops the fourth, which is worse than refusing the whole
      // step (`reissueStructuralSourceEdits`'s own "unsupported" sentence).
      const byNodeId = new Map(outcome.removed.map((r) => [r.nodeId, r] as const))
      if (!template.nodes.every((n) => byNodeId.has(n.nodeId))) return null

      // A file's pruned imports are attached to exactly ONE reinsert edit
      // targeting that file — never every one of them, or the import would be
      // written back once per restored sibling. Which one carries it does not
      // matter: `reinsert-source`'s import edit always lands after the file's
      // last import, independent of which child position it rode in on.
      const importsByFile = new Map(outcome.prunedImports.map((p) => [p.file, [...p.declarations]] as const))

      // Ascending index WITHIN one parent, so the server's bottom-to-top
      // ordering (which sorts by the PARENT's own line:col, and preserves
      // array order for ties) applies each parent's siblings back in the
      // order they left: restoring the earlier index first is always safe,
      // because a still-missing later sibling only ever "past the end"s.
      const ordered = [...template.nodes].sort((a, b) => a.index - b.index)

      return ordered.map(({ nodeId, parentNodeId, index }) => {
        const removedText = byNodeId.get(nodeId)!
        const imports = importsByFile.get(fileOfNodeId(parentNodeId))
        if (imports) importsByFile.delete(fileOfNodeId(parentNodeId))
        return {
          kind: 'reinsert-source',
          nodeId: parentNodeId,
          index,
          text: removedText.text,
          ...(imports && imports.length > 0 ? { imports } : {}),
        }
      })
    }
  }
}

/**
 * The workspace-relative file a `rel:line:col` node id names — everything
 * before the `line:col` tail. Exported so `structuralSourceHistory.ts`'s own
 * id-validity check reads the same file a `reinsert-deleted` template's
 * `prunedImports` lookup does, rather than a second, parallel derivation.
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
  if (template.kind === 'transplant-back') {
    return { ...template, parentNodeId: remap.get(template.parentNodeId) ?? template.parentNodeId }
  }
  if (template.kind === 'reinsert-detached') {
    return {
      ...template,
      callSiteNodeId: remap.get(template.callSiteNodeId) ?? template.callSiteNodeId,
      parentNodeId: remap.get(template.parentNodeId) ?? template.parentNodeId,
    }
  }
  if (template.kind === 'reinsert-deleted') {
    // Both ids, not just `parentNodeId`: `nodeId` is the key `resolveStructuralInverse`
    // looks up in the outcome's `removed` list, and that list is keyed by
    // whatever `nodeId` the LATEST `delete` edit (itself remapped alongside
    // `forward`, generically, by `remapStructuralEditIds`) actually carries.
    return {
      ...template,
      nodes: template.nodes.map((n) => ({
        nodeId: remap.get(n.nodeId) ?? n.nodeId,
        parentNodeId: remap.get(n.parentNodeId) ?? n.parentNodeId,
        index: n.index,
      })),
    }
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
  if (template.kind !== 'transplant-back') return [...edits]
  const anchorNodeId = parentChildIds[template.index]
  if (anchorNodeId === undefined) return [...edits]
  return edits.map((edit) =>
    edit.kind === 'transplant' ? { ...edit, anchorNodeId, position: 'before' } : edit,
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
