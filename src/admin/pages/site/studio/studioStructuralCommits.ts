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
 * `commitStructural` at the bottom is the shared body, and its doc comment is
 * the authoritative account of the reload gate — read that before changing when
 * a commit reloads. What a landed write does to the board is
 * `studioBoardResync.ts`'s call, not this module's.
 *
 * Two neighbours own the halves that used to live here:
 *  - `structuralCommitQueue.ts` — only one of these is on the wire at a time,
 *    and a gesture that arrives meanwhile is QUEUED rather than refused
 *    (`store-14`, replacing `store-11`'s "Still writing your last change").
 *  - `structuralUndoPlan.ts` — what each gesture's ⌘Z is, expressed in the edit
 *    kinds the writeback protocol already has.
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import { settleOrRollbackOptimistic, type OptimisticPreviewHandle } from '@site/store/slices/site/structuralOptimism'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import type { PendingStructuralHistory } from './pendingStructuralOutcome'
import { beginStructuralCommit, endStructuralCommit } from './structuralCommitQueue'
import {
  dissolveWrapperTemplate,
  resolveStructuralInverse,
  structuralEditNodeIds,
  type StructuralEditPayload,
  type StructuralInverseTemplate,
  type StructuralWriteOutcome,
} from './structuralUndoPlan'
import { resyncBoardAfterWrite } from './studioBoardResync'
import type { InsertPropValue } from './studioSaveRequests'
import { isUnreachableWriteFailure, postEditsRetryingUnreachable } from './structuralWriteRetry'
import { captureIdentities, type IdentityCapture } from './sourceIdentity'
import { elementMovedNodeIds, replanAfterElementMoved, warnElementMoved } from './elementMovedRecovery'

/**
 * What a structural commit does beyond posting: what it says when it lands,
 * and what it means for the undo stack.
 */
interface StructuralCommitOptions {
  /**
   * Passed only by commits with no optimistic canvas change to stand in for
   * the result — an insert shows nothing at all until the reload, so silence
   * would be indistinguishable from a no-op. A move or a delete has already
   * updated the tree, so it stays quiet on success.
   */
  success?: { title: string; body: string }
  /**
   * `store-14` — this gesture's ⌘Z, as a template the write's own answer fills
   * in (`structuralUndoPlan.ts`). Omitted by `move`/`reparent`, whose undo
   * already rides the tree-mutation stack (`structuralHistory.ts`), and by
   * `delete`, which uses `fill` below instead — its own tree mutation already
   * pushed an entry, and TAGGED it with this same template, before the commit
   * that reveals the answer even started.
   */
  undo?: { label: string; template: StructuralInverseTemplate }
  /**
   * `store-15` — set only by `delete`. Its tree mutation (and history entry)
   * already ran, synchronously, BEFORE this commit — `deleteNodesAction.ts`
   * tagged it with the gesture's `label`/`forward`/`inverseTemplate` already
   * filled in. This asks the resync to fill in just `inverse`, the one field
   * that answer could not know yet, on that SAME entry.
   */
  fill?: boolean
  /**
   * Set when this commit IS an undo or a redo re-issuing a stored entry. The
   * stack bookkeeping happened in `undoRedoActions.ts`; this only asks the
   * resync to re-resolve that entry's inverse against the ids the re-issue
   * reported.
   */
  reissue?: 'undo' | 'redo'
  optimistic?: OptimisticPreviewHandle // `perf-10` — local preview, settled/rolled back in `commitStructuralBody`.
  /**
   * ERR-6 — what a move/delete already did to the tree, or what an undo/redo
   * already did to the stack, taken back if this write does not land
   * (`structuralCommitRollback.ts`). Settled or rolled back exactly once.
   */
  rollback?: StructuralCommitRollback
  replanned?: true // P1-A — this post IS the one silent re-plan after `element-moved`; a second one warns instead.
}

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
 */
export async function commitStudioMove(
  nodeId: string,
  anchorNodeId: string,
  position: 'before' | 'after',
  rollback?: StructuralCommitRollback,
): Promise<void> {
  await commitStructural([{ kind: 'move', nodeId, anchorNodeId, position }], 'Move refused', rollback ? { rollback } : {})
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
 * The success toast is pushed here for the same reason the duplicate's is:
 * until the write lands there is nothing on screen to report.
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
  /** What the toast says the element landed in — the destination page's own title. */
  destinationLabel: string
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
      success: {
        title: transplant.copy ? 'Copied into another frame' : 'Moved into another frame',
        body: `Written to ${transplant.destinationLabel}.`,
      },
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
 * ordinary parsed node with a real `rel:line:col`. That is also why the success
 * toast is pushed here — until the write lands there is nothing on screen to
 * report.
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
      success: {
        title: nodeIds.length === 1 ? 'Duplicated' : `Duplicated ${nodeIds.length} elements`,
        body: 'Written to your project source.',
      },
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
      success: { title: `Wrapped in <${wrap.name}>`, body: 'Written to your project source.' },
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
 * spells out — which is also why the success toast is pushed here.
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
      success: { title: `Grouped ${group.nodeIds.length} elements`, body: 'Written to your project source.' },
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
    success: { title: 'Ungrouped', body: 'Written to your project source.' },
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
 * parsed node with a real `rel:line:col`. That is why the success toast is
 * pushed HERE rather than by the inserter: until the write lands there is
 * nothing to report, and the inserter has no way to know whether it did.
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
  /** Literal text written as the element's only child, e.g. `<p>Heading</p>`. */
  children?: string
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
      },
    ],
    'Add refused',
    {
      success: { title: `Added ${insert.name}`, body: 'Written to your project source.' },
      undo: { label: `Add ${insert.name}`, template: { kind: 'delete-created' } },
      ...(insert.optimistic ? { optimistic: insert.optimistic } : {}),
    },
  )
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
 * The status toast is the gesture's own name, not the edit kinds behind it:
 * "Undone — Group" reads as one step, which is what a ⌘Z is.
 */
export async function commitStudioStructuralReissue(
  edits: readonly StructuralEditPayload[],
  direction: 'undo' | 'redo',
  label: string,
  rollback: StructuralCommitRollback,
): Promise<void> {
  await commitStructural(edits, direction === 'undo' ? 'Undo refused' : 'Redo refused', {
    success: { title: direction === 'undo' ? 'Undone' : 'Redone', body: `${label} — written to your project source.` },
    reissue: direction,
    rollback,
  })
}

/**
 * Shared body of the structural commits: flush any pending debounced save,
 * post, report what the source refused, and re-sync the board with disk when
 * (and only when) a write actually landed.
 *
 * `STUDIO-FIGMA-PARITY-PLAN.md` 0.2 (audit E2) — two fixes, both applied here:
 *
 *   1. Reload only when a write landed (trap #5, the same `written > 0` gate
 *      `fsCodemodAdapter.saveSite` uses). It used to fire from a `finally` on
 *      every outcome, and reloading an unchanged disk replaced the user's
 *      optimistic edit with the pre-edit source. A move/delete that did NOT
 *      land is taken back instead, through `options.rollback` (ERR-6,
 *      `structuralCommitRollback.ts`).
 *   2. Before posting, flush and AWAIT any edit still inside the autosave
 *      debounce, so a value edit made moments before this gesture is written
 *      (and its diff baseline advanced) before a re-parse could discard it
 *      or aim it at now-stale ids. A flush failure is logged and the commit
 *      proceeds — the save chip already surfaces that failure.
 *
 * Track C5 changed only what a "reload" does once the gate above says one
 * should happen (`studioBoardResync.ts`); every gate here is unchanged.
 *
 * P1-A: every commit posts the identity of each id it names, captured when the
 * gesture was made, and an `element-moved` refusal is re-planned once, silently.
 *
 * ERR-6: a write that gets no answer is retried on a short ladder first
 * (`structuralWriteRetry.ts`). A write that does not land in the end — refused
 * outright, re-plan exhausted, or still unreachable — settles nothing: its
 * `rollback` takes back what the gesture already did, and the user sees ONE
 * toast for it however many edits the batch held.
 */
async function commitStructural(
  edits: readonly StructuralEditPayload[],
  refusalTitle: string,
  options: StructuralCommitOptions = {},
): Promise<void> {
  // Held for the whole body, including the resync at the bottom — see
  // `structuralCommitQueue.ts` for why the window has to extend past the POST
  // itself, and what happens to a gesture that arrives inside it.
  // P1-A — who every id names, captured at the gesture's own moment: before the
  // flush below, or a commit ahead in the queue, can renumber the file.
  const identities = captureIdentities(edits.flatMap((edit) => structuralEditNodeIds(edit)))
  beginStructuralCommit()
  try {
    await commitStructuralBody(edits, refusalTitle, options, identities)
  } finally {
    endStructuralCommit()
  }
}

async function commitStructuralBody(
  edits: readonly StructuralEditPayload[],
  refusalTitle: string,
  options: StructuralCommitOptions,
  identities: IdentityCapture,
): Promise<void> {
  try {
    await flushEditorSave()
  } catch (err) {
    console.error('[studioSaveRequests] pre-structural-edit save flush failed:', err)
  }

  try {
    const result = await postEditsRetryingUnreachable(edits, identities)
    // `element-moved` is never toasted here — it is recovered from below.
    const moved = elementMovedNodeIds(result.refusals)
    const refusals = (result.refusals ?? []).filter((refusal) => !moved.has(refusal.nodeId))
    // A skip with no refusal means the location decoded to nothing writable at
    // all — the id was stale against disk.
    const unexplained = result.skipped - (result.refusals ?? []).length
    const willReload = result.written > 0
    // P1-A — an `element-moved` miss is re-planned below, and the re-plan owns
    // the rollback when nothing else landed; every other outcome is known now.
    const replanning = moved.size > 0 && !options.replanned && !willReload
    settleOrRollbackOptimistic(options.optimistic, willReload ? 'settle' : 'rollback') // `perf-10`
    if (willReload) options.rollback?.settle()
    else if (!replanning) options.rollback?.rollback('refused')
    // ERR-6 — one gesture, one toast: the first reason, however many edits the
    // batch held. A partial refusal still says so; the resync shows the rest.
    const [firstRefusal] = refusals
    if (firstRefusal) {
      const more = refusals.length > 1 ? ` (${refusals.length - 1} more like this.)` : ''
      pushToast({ kind: 'error', title: refusalTitle, body: `${firstRefusal.message}${more}` })
    } else if (unexplained > 0) {
      pushToast({
        kind: 'error',
        title: refusalTitle,
        body: willReload
          ? 'The code no longer has an element at the position the canvas was showing. The board has been reloaded from the files on disk.'
          : 'The code no longer has an element at the position the canvas was showing.',
      })
    }
    if (options.success && result.written > 0) {
      pushToast({
        kind: 'success',
        title: options.success.title,
        body: options.success.body,
        location: 'module-inserter',
      })
    }
    // trap #5 — reload only when a write actually landed (`rollback` above
    // takes a refused one back). Track C5: `resyncBoardAfterWrite` is narrow
    // when it can prove it. `store-13`/`store-14`: what this write CREATED and
    // MOVED rides the resync itself (ERR-10, `pendingStructuralOutcome.ts`),
    // applied by the re-read this write triggers and no other; the await
    // covers a full reload too, so the queue re-plans against these ids.
    if (willReload) {
      const outcome: StructuralWriteOutcome = {
        createdNodeIds: result.createdNodeIds ?? [],
        relocatedNodeIds: result.relocatedNodeIds ?? [],
        removed: result.removed ?? [],
        prunedImports: result.prunedImports ?? [],
      }
      await resyncBoardAfterWrite(result.touchedFiles ?? [], {
        structuralOutcome: {
          selectNodeIds: [...outcome.createdNodeIds, ...outcome.relocatedNodeIds],
          history: resolvePendingHistory(edits, options, outcome),
        },
      })
    }
    // P1-A — the file changed under the board. Re-read it and re-plan ONCE,
    // silently (`elementMovedRecovery.ts`); only a second miss says anything.
    // The re-plan inherits `rollback` only when this pass settled nothing.
    if (moved.size > 0) {
      const movedEdits = edits.filter((edit) => moved.has(edit.nodeId))
      const replan = options.replanned ? null : await replanAfterElementMoved(movedEdits, identities, result.touchedFiles ?? [])
      const carried = replanning ? options.rollback : undefined
      if (replan) {
        await commitStructuralBody(replan.edits, refusalTitle, { ...options, optimistic: undefined, rollback: carried, replanned: true }, replan.identities)
      } else {
        carried?.rollback('refused')
        warnElementMoved(moved)
      }
    }
  } catch (err) {
    // Fire-and-forget from the store's mutation guard, so this is the only
    // place the failure can be reported. No response was ever obtained, so
    // there is no `written` count to check — the safe assumption after a
    // failed request is "disk is unchanged," which means no reload either
    // (see this function's doc for why an unconditional reload here was the
    // bug, not the fix) — and the gesture is taken back (ERR-6). Both calls
    // are no-ops if the write had already settled before something later
    // (the resync) threw.
    settleOrRollbackOptimistic(options.optimistic, 'rollback') // `perf-10`
    options.rollback?.rollback(isUnreachableWriteFailure(err) ? 'unreachable' : 'refused')
    console.error('[studioSaveRequests] structural edit failed:', err)
    pushToast({
      kind: 'error',
      title: refusalTitle,
      body: getErrorMessage(err, 'The change could not be written to the project source.'),
    })
  }
}

/**
 * What this landed write means for the undo stack: a new entry, a FILL of the
 * entry `delete`'s own tree mutation already tagged, a refresh of the one an
 * undo/redo just moved, or nothing at all for the gestures (`move`/`reparent`)
 * whose undo lives entirely on the tree-mutation stack.
 */
function resolvePendingHistory(
  edits: readonly StructuralEditPayload[],
  options: StructuralCommitOptions,
  outcome: StructuralWriteOutcome,
): PendingStructuralHistory | null {
  if (options.reissue) return { kind: 'refresh', direction: options.reissue, outcome }
  if (options.fill) return { kind: 'fill', outcome }
  if (!options.undo) return null
  return {
    kind: 'push',
    gesture: {
      label: options.undo.label,
      // Copied, not aliased: the entry outlives this call, and the array it
      // holds has to be a plain mutable one the store's Mutative draft can
      // carry (see `StructuralSourceGesture`).
      forward: [...edits],
      inverseTemplate: options.undo.template,
      inverse: resolveStructuralInverse(options.undo.template, outcome),
    },
  }
}

