/**
 * studioStructuralCommits — the one-shot commits behind a STRUCTURAL gesture on
 * a studio-imported board: move, reparent, duplicate, wrap, group, ungroup,
 * delete and insert.
 *
 * Split out of `studioSaveRequests.ts` (W4-1, at the module-size gate's own
 * prompting) because these six are one thing and the rest of that module is
 * another. A structural commit changes WHERE markup is, so it always shifts the
 * `line:col` of every node below it, and it always ends in the same three-step
 * dance: flush whatever the autosave debounce is still holding, post the batch,
 * and re-sync the board with disk — but only when a write actually landed. The
 * asset/detach/swap/slot commits next door post one edit and read one answer;
 * they share this module's wire shape, not its reload contract.
 *
 * `commitStructural` (`studioStructuralCommitEngine.ts`) is the shared body,
 * and its doc comment is the authoritative account of the reload gate — read
 * that before changing when a commit reloads. What a landed write does to the
 * board is `studioBoardResync.ts`'s call, not this module's.
 *
 * Two neighbours own the halves that used to live here:
 *  - `structuralCommitQueue.ts` — only one of these is on the wire at a time,
 *    and a gesture that arrives meanwhile is QUEUED rather than refused
 *    (`store-14`, replacing `store-11`'s "Still writing your last change").
 *  - `structuralUndoPlan.ts` — what each gesture's ⌘Z is, expressed in the edit
 *    kinds the writeback protocol already has.
 */
import type { OptimisticPreviewHandle } from '@site/store/slices/site/structuralOptimism'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import { dissolveWrapperTemplate, type StructuralEditPayload } from './structuralUndoPlan'
import type { InsertPropValue, SlotJsxNode } from './studioSaveRequests'
import { commitStructural } from './studioStructuralCommitEngine'

/**
 * `struct-01` — a sibling reorder, committed to the user's `.tsx` the moment
 * the drag ends.
 *
 * A one-shot commit rather than a `saveSite` diff, for the reason every other
 * one-shot commit in this module is one and then a sharper one: `saveSite`
 * walks node VALUES and has no notion of parent, order, or child list at all,
 * which is exactly why a structural edit used to vanish silently. There is
 * also nothing to debounce — a drag ends once.
 *
 * `anchorNodeId` is the sibling the moved element is written against, not an
 * index: see `MoveEditSchema` in `server/handlers/studioWriteback.ts` for why
 * an index computed on the canvas does not name a position in the source.
 *
 * The store has already refused everything it can decide from the node ids
 * (`refuseStructuralEdit`); what can still come back is the residue only the
 * AST can answer — these two are not really siblings in the code, their
 * formatting will not admit a byte-exact move. Those arrive as refusals, and
 * because the store applied the move optimistically, the board is then showing
 * something the file does not say. Reloading is what makes it honest again,
 * which is why a successful write resyncs and a refused one is taken back
 * through `rollback` (ERR-6).
 *
 * No `undo` template: a move mutates the tree, so it already has a history
 * entry that `structuralHistory.ts` re-issues in either direction.
 *
 * Several moves in one request only when they are INDEPENDENT — P2-C2's
 * `moveSiblings`, whose `planSiblingSteps` guarantees no move's region
 * overlaps another's. `applyStudioEditBatch` then applies them bottom-to-top,
 * so no write shifts a pending one's line, exactly as for a multi-delete.
 */
export async function commitStudioMoves(
  moves: readonly { nodeId: string; anchorNodeId: string; position: 'before' | 'after' }[],
  rollback?: StructuralCommitRollback,
): Promise<void> {
  if (moves.length === 0) return
  await commitStructural(
    moves.map(({ nodeId, anchorNodeId, position }) => ({ kind: 'move', nodeId, anchorNodeId, position })),
    'Move refused',
    rollback ? { rollback } : {},
  )
}

/**
 * W4-1 — a move into a DIFFERENT parent, in the same file.
 *
 * A separate kind from `move` rather than an optional field on it, because the
 * two are different writes: a reorder is a pure byte splice between siblings,
 * while a reparent re-hangs the subtree at the destination's indentation and
 * has to answer a question a reorder never asks — whether the values the markup
 * reads are in scope where it lands (`moveJsxElement`'s `out-of-scope`
 * refusal). The wire shape says which one is meant instead of leaving the
 * server to infer it from a missing field.
 *
 * `anchorNodeId` is optional here, unlike `move`: with no addressable child in
 * the destination, appending as its last child is still an honest position —
 * the same reading `insert` gives a missing anchor.
 */
export async function commitStudioReparent(reparent: {
  nodeId: string
  parentNodeId: string
  anchorNodeId: string | null
  position: 'before' | 'after'
  rollback?: StructuralCommitRollback
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'reparent',
        nodeId: reparent.nodeId,
        parentNodeId: reparent.parentNodeId,
        ...(reparent.anchorNodeId ? { anchorNodeId: reparent.anchorNodeId, position: reparent.position } : {}),
      },
    ],
    'Move refused',
    reparent.rollback ? { rollback: reparent.rollback } : {},
  )
}

/**
 * D2 G3 — an element leaving the file it is written in and landing in a
 * container in another one: the commit behind a drag that crossed a frame
 * boundary.
 *
 * ONE edit, not a delete plus an insert. Two edits would be two writes the
 * batch could land half of, and the second one has no markup to insert —
 * the element's own source text only exists in the file the first one just
 * removed it from. `transplantJsxElement` reads both ends, refuses before
 * writing either, and writes both.
 *
 * Nothing is moved on the canvas first, for `commitStudioDuplicate`'s reason
 * one step further: the element's id IS its `rel:line:col`, so the node that
 * appears in the destination frame is a DIFFERENT node from the one that left
 * the origin frame, and no optimistic tree edit could mint it. The resync
 * covers both files (the batch reports both as touched), so the two frames
 * update together.
 *
 * `origin` is where the element came from, which is the whole of this
 * gesture's undo: a MOVE is taken back by transplanting it home, and a COPY by
 * deleting what it made.
 */
export async function commitStudioTransplant(transplant: {
  nodeId: string
  parentNodeId: string
  anchorNodeId: string | null
  position: 'before' | 'after'
  copy: boolean
  /** Where it was written before this gesture: the container it left, and which of that container's children it was. */
  origin: { parentNodeId: string; index: number }
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'transplant',
        nodeId: transplant.nodeId,
        parentNodeId: transplant.parentNodeId,
        ...(transplant.anchorNodeId
          ? { anchorNodeId: transplant.anchorNodeId, position: transplant.position }
          : {}),
        ...(transplant.copy ? { copy: true } : {}),
      },
    ],
    'Cannot move this between frames',
    {
      undo: {
        label: transplant.copy ? 'Copy into another frame' : 'Move into another frame',
        template: transplant.copy
          ? { kind: 'delete-created' }
          : { kind: 'transplant-back', parentNodeId: transplant.origin.parentNodeId, index: transplant.origin.index },
      },
    },
  )
}

/**
 * W4-1 — copying elements in the user's `.tsx`.
 *
 * Nothing is minted on the canvas first, for the reason `commitStudioInsert`
 * spells out: a node created in the editor carries a nanoid id that could never
 * be written back. `duplicateJsxElement` writes the element's own source text in
 * again as its next sibling, and the reload below brings the copy in as an
 * ordinary parsed node with a real `rel:line:col`.
 *
 * Several ids in one request on purpose: `applyStudioEditBatch` orders a batch
 * bottom-to-top, so a copy written lower in the file cannot move the line of one
 * still pending above it.
 */
export async function commitStudioDuplicate(
  nodeIds: readonly string[],
  /**
   * K2 — Alt+drag. Where the copy lands, when it is not beside the original:
   * the container, and optionally the existing child to write it next to
   * (`null` appends, which is a real position). Omitted entirely for ⌘D and
   * the toolbar button, which copy in place.
   *
   * Single-node only by construction: the Alt+drag session resolves ONE drop
   * target, and a multi-selection Alt-dragged to one place would need N copies
   * ordered against each other inside a container whose child list is shifting
   * under them. `planSourceDuplicateTo` refuses that as `multi-select` rather
   * than copying the first and pretending.
   */
  destination?: {
    parentNodeId: string
    anchorNodeId: string | null
    position: 'before' | 'after'
  },
  optimistic?: OptimisticPreviewHandle, // `perf-10` — see `StructuralCommitOptions.optimistic`.
): Promise<void> {
  if (nodeIds.length === 0) return
  await commitStructural(
    nodeIds.map((nodeId) => ({
      kind: 'duplicate',
      nodeId,
      ...(destination
        ? {
            parentNodeId: destination.parentNodeId,
            ...(destination.anchorNodeId
              ? { anchorNodeId: destination.anchorNodeId, position: destination.position }
              : {}),
          }
        : {}),
    })),
    'Duplicate refused',
    {
      undo: { label: 'Duplicate', template: { kind: 'delete-created' } },
      ...(optimistic ? { optimistic } : {}),
    },
  )
}

/**
 * W4-1 — wrapping one element in a new container written into the user's
 * `.tsx`.
 *
 * `name`/`importSpecifier`/`designSystemImport` spell the wrapper the way
 * `commitStudioInsert` spells a new element: an intrinsic tag (`div`) needs no
 * import and omits both; a package component names its specifier; a built-in
 * design-system component names only the SYSTEM, and the server computes the
 * relative path (see `commitStudioInsert`).
 */
export async function commitStudioWrap(wrap: {
  nodeId: string
  name: string
  importSpecifier?: string
  designSystemImport?: true
  optimistic?: OptimisticPreviewHandle
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'wrap',
        nodeId: wrap.nodeId,
        name: wrap.name,
        ...(wrap.importSpecifier === undefined ? {} : { importSpecifier: wrap.importSpecifier }),
        ...(wrap.designSystemImport === undefined ? {} : { designSystemImport: wrap.designSystemImport }),
      },
    ],
    'Wrap refused',
    {
      undo: { label: `Wrap in <${wrap.name}>`, template: dissolveWrapperTemplate(wrap) },
      ...(wrap.optimistic ? { optimistic: wrap.optimistic } : {}),
    },
  )
}

/**
 * K3 — ONE container written around a run of siblings in the user's `.tsx`
 * (⌘G on a multi-selection).
 *
 * `nodeIds` is the run in SOURCE order. The first is the edit's `nodeId` — the
 * position the save route sorts and path-guards on, and the topmost byte this
 * write changes — and the rest ride as `siblingNodeIds` through the identical
 * decoder. The server re-derives the run from the AST and refuses if anything
 * unnamed sits between the ends, so this request cannot widen its own span.
 *
 * ⌘G on ONE element never reaches here: `writeGroupToSource` commits that as
 * the existing single-element `wrap`, which is the same write that shipped in
 * W4-1.
 *
 * Nothing is minted on the canvas first, for the reason `commitStudioInsert`
 * spells out.
 */
export async function commitStudioGroup(group: {
  nodeIds: readonly string[]
  name: string
  importSpecifier?: string
  designSystemImport?: true
  optimistic?: OptimisticPreviewHandle
}): Promise<void> {
  const [nodeId, ...siblingNodeIds] = group.nodeIds
  if (nodeId === undefined || siblingNodeIds.length === 0) return
  await commitStructural(
    [
      {
        kind: 'group',
        nodeId,
        siblingNodeIds,
        name: group.name,
        ...(group.importSpecifier === undefined ? {} : { importSpecifier: group.importSpecifier }),
        ...(group.designSystemImport === undefined ? {} : { designSystemImport: group.designSystemImport }),
      },
    ],
    'Group refused',
    {
      undo: { label: 'Group', template: dissolveWrapperTemplate(group) },
      ...(group.optimistic ? { optimistic: group.optimistic } : {}),
    },
  )
}

/**
 * K3 — a container dissolved in the user's `.tsx` (⌘⇧G): its children take its
 * place and the container's own bytes go.
 *
 * The board is NOT mutated first. Unlike a delete — which removes a subtree the
 * canvas can take back — an ungroup re-parents every child, and the ids those
 * children get afterwards are the `line:col`s the write produces. The commit's
 * own resync is what brings them in.
 *
 * `container` is how the dissolved wrapper was spelled, which is what its undo
 * writes back around the released children. `null` means the wrapper carried
 * something a re-group would not restore (a `className`, a `style`, an `id`) —
 * the undo then refuses by name rather than writing back a container that has
 * lost half of itself. Closing that needs `props` on the `wrap`/`group` edit,
 * which is the wrap codemod's own surface.
 */
export async function commitStudioUngroup(
  nodeId: string,
  container: { name: string; importSpecifier?: string; designSystemImport?: true } | null,
): Promise<void> {
  await commitStructural([{ kind: 'ungroup', nodeId }], 'Ungroup refused', {
    undo: {
      label: 'Ungroup',
      template: container
        ? { kind: 'group-relocated', container }
        : {
            kind: 'unsupported',
            message:
              'That container carried styling of its own (a class, an inline style or an id), and Studio can only write a plain container back around its children — undoing it here would silently drop what it carried. Use your editor’s undo or `git` to bring it back.',
          },
    },
  })
}

/**
 * `struct-01` — removing one or more elements from the user's `.tsx`.
 *
 * Several ids in one request on purpose: `applyStudioEditBatch` orders a batch
 * bottom-to-top, so removing a lower element cannot move a higher one's line,
 * which makes a multi-select delete a single honest transaction rather than N
 * racing ones.
 *
 * `fill: true`, never `undo` — see `StructuralCommitOptions.fill`.
 * `deleteNodesAction.ts` already pushed AND tagged the entry
 * (`label`/`forward`/`inverseTemplate`, decided from the pre-delete tree —
 * the only moment the deleted elements' positions are known); this commit's
 * job is only to reveal what it discarded, `inverse`'s reason to wait.
 */
export async function commitStudioDelete(nodeIds: readonly string[], rollback?: StructuralCommitRollback): Promise<void> {
  if (nodeIds.length === 0) return
  await commitStructural(nodeIds.map((nodeId) => ({ kind: 'delete', nodeId })), 'Delete refused', {
    fill: true,
    ...(rollback ? { rollback } : {}),
  })
}

/**
 * Adding a new element to the user's `.tsx` — the write behind picking a
 * design-system component out of the canvas inserter.
 *
 * Nothing is minted on the canvas first. A node created in the editor carries a
 * nanoid id that could never be written back, which is exactly why `insert`
 * used to be refused outright; instead the SOURCE grows the element (plus the
 * `import` that names it) and the reload below brings it in as an ordinary
 * parsed node with a real `rel:line:col`.
 */
export async function commitStudioInsert(insert: {
  parentNodeId: string
  anchorNodeId: string | null
  position: 'before' | 'after'
  name: string
  /**
   * Omit for an INTRINSIC element (`<div>`, `<p>`) — those need no import, and
   * `insertJsxElement` reads the field's absence as exactly that. Present for a
   * package component, which is imported from this specifier.
   */
  importSpecifier?: string
  /**
   * DS-3 — the component comes from Studio's built-in design system, which a
   * project reaches through its own `design-system/` folder. There is no
   * specifier to send: it is RELATIVE to the file being written, and only the
   * server knows where that file sits. It computes it
   * (`designSystemImportSpecifier`) after decoding the node id.
   */
  designSystemImport?: true
  props: Record<string, InsertPropValue>
  /**
   * Literal text written as the element's only child (`<p>Heading</p>`), or
   * child ELEMENTS (P5-D: a drawn `<svg>`'s `<path>`) — `InsertEditSchema`
   * already takes both; the server validates every nested tag.
   */
  children?: string | readonly SlotJsxNode[]
  /**
   * P5-B (IMG-2) — more intrinsic elements written right AFTER this one, in
   * order, in the SAME write (`InsertEditSchema.siblings`): three dropped
   * images are one insert, one resync and one undo step, whose inverse deletes
   * all three (`delete-created` reads every created id).
   */
  siblings?: readonly { name: string; props: Record<string, InsertPropValue> }[]
  /** What ⌘Z names this step. Defaults to `Add <name>`. */
  undoLabel?: string
  optimistic?: OptimisticPreviewHandle
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'insert',
        nodeId: insert.parentNodeId,
        ...(insert.anchorNodeId ? { anchorNodeId: insert.anchorNodeId, position: insert.position } : {}),
        name: insert.name,
        // Spread conditionally, never passed as `undefined`: the codemod
        // branches on `importSpecifier === undefined` to choose intrinsic vs
        // component, and the wire schema has it optional for the same reason.
        ...(insert.importSpecifier === undefined ? {} : { importSpecifier: insert.importSpecifier }),
        ...(insert.designSystemImport === undefined ? {} : { designSystemImport: insert.designSystemImport }),
        ...(insert.children === undefined ? {} : { children: insert.children }),
        props: insert.props,
        ...(insert.siblings && insert.siblings.length > 0 ? { siblings: insert.siblings.map((node) => ({ ...node })) } : {}),
      },
    ],
    'Add refused',
    {
      undo: { label: insert.undoLabel ?? `Add ${insert.name}`, template: { kind: 'delete-created' } },
      ...(insert.optimistic ? { optimistic: insert.optimistic } : {}),
    },
  )
}

/**
 * P5-B (IMG-3) — an image dropped onto an IMPORT-BOUND `<img src={hero}>`:
 * the import is repointed at the newly landed file (`kind: 'asset'`,
 * `setImportSpecifier`), never the JSX, so the binding survives.
 *
 * Through the structural commit rather than `saveStudioAssetEdit` for one
 * reason: undo. The inverse is known now — point the import back at the file
 * it named before — so the gesture records it (`known`) and ⌘Z posts it
 * through the same route. `originNodeId` is `PageNode.assetOrigin`'s own
 * `rel:line:col` (the import's specifier literal), as for every asset edit.
 */
export async function commitStudioAssetReplace(originNodeId: string, assetPath: string, previousAssetPath: string): Promise<void> {
  await commitStructural([{ kind: 'asset', nodeId: originNodeId, assetPath }], 'Replace image refused', {
    undo: {
      label: 'Replace image',
      template: { kind: 'known', inverse: [{ kind: 'asset', nodeId: originNodeId, assetPath: previousAssetPath }] },
    },
  })
}

/**
 * `store-14` — one direction of a stored structural gesture, re-issued as a
 * real write.
 *
 * The edits are the ones the history entry is holding, already validated
 * against the live tree by `structuralSourceHistory.ts`; this is only the
 * posting half. `reissue` makes the resync re-resolve the entry's inverse
 * against what THIS write reported, so the next step in the same direction
 * addresses the elements that exist now rather than the ones that did.
 *
 * Silent when it lands, like every structural commit: the board changing back
 * IS the answer to a ⌘Z.
 */
export async function commitStudioStructuralReissue(
  edits: readonly StructuralEditPayload[],
  direction: 'undo' | 'redo',
  label: string,
  rollback: StructuralCommitRollback,
): Promise<void> {
  await commitStructural(edits, direction === 'undo' ? `Could not undo ${label}` : `Could not redo ${label}`, {
    reissue: direction,
    rollback,
  })
}
