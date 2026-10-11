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
import { decodeSourceNodeId } from '@core/page-tree'
import type { OptimisticPreviewHandle } from '@site/store/slices/site/structuralOptimism'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import { commitStructural, type StructuralCommitOptions } from './studioStructuralCommitEngine'
import { announceCarried } from './transplantCarryNotice'
import {
  type StructuralEditPayload,
  type StructuralInverseTemplate,
  type StructuralWriteOutcome,
} from './structuralUndoPlan'
import type { InsertPropValue, SlotJsxNode, StudioSaveResponse } from './studioSaveRequests'

/** Where one Alt-dragged or pasted COPY is written: inside which container, beside which existing child. */
export interface SourceDuplicateToCommit {
  /** The element being copied. */
  nodeId: string
  /** The container the copy lands in — a real source node, never the synthetic page root. */
  parentNodeId: string
  /** The existing child the copy is written next to, or `null` to append as the last child. */
  anchorNodeId: string | null
  position: 'before' | 'after'
  /**
   * ERR-16 — the container is written in ANOTHER file than the element, so the
   * copy is a `transplant` with `copy: true`: it carries the imports the markup
   * needs there, and refuses by name when a local it reads cannot travel.
   */
  crossFile?: true
  /**
   * The container has no children yet, so the copy may expand a self-closing
   * `<X />` — and deleting the copy does not put that back. The copy's undo is
   * then the undo journal's `restore` (as `SourceInsertCommit.parentIsEmpty`).
   */
  parentIsEmpty?: true
}

/**
 * P3-D — ONE gesture written as several edits applied IN ORDER, each against
 * the file the previous ones left, all or nothing: a multi-selection drag, the
 * arrow-key step of a selection, a non-adjacent group ("bring them together,
 * then wrap"), several copies dropped at one place. The server's
 * `studioEditSequence.ts` re-addresses every step and restores every file when
 * any step is refused, so the board's one rollback (and one toast) is the
 * whole story — the same contract as a single write.
 *
 * `undo`/`rollback`/`optimistic`/`select` mean what they mean for every other
 * commit (`StructuralCommitOptions`).
 */
export async function commitStudioSequence(
  edits: readonly StructuralEditPayload[],
  refusalTitle: string,
  options: Pick<StructuralCommitOptions, 'undo' | 'fill' | 'rollback' | 'optimistic' | 'select' | 'onAnswer' | 'onLanded'> = {},
): Promise<void> {
  if (edits.length === 0) return
  await commitStructural(edits, refusalTitle, { ...options, sequence: true })
}

/**
 * `struct-01` / W4-1 — a reorder (`kind: 'move'`: put this element next to that
 * sibling) or a reparent within the same file (`kind: 'reparent'`: into that
 * container, optionally beside a child), committed to the user's `.tsx` the
 * moment the drag ends. `moveEditOf` builds the edit from the planner's commit.
 *
 * A one-shot commit rather than a `saveSite` diff, for the reason every other
 * one-shot commit in this module is one and then a sharper one: `saveSite`
 * walks node VALUES and has no notion of parent, order, or child list at all,
 * which is exactly why a structural edit used to vanish silently. There is
 * also nothing to debounce — a drag ends once.
 *
 * `anchorNodeId` is the sibling the moved element is written against, not an
 * index: see `MoveEditSchema` in `server/handlers/studioWriteback.ts` for why
 * an index computed on the canvas does not name a position in the source. A
 * reparent's anchor is optional: appending as the last child is a position.
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
 * `fill: true`, like `commitStudioDelete`: the move's tree mutation already
 * pushed an entry and `nodeActions.ts` tagged it with `restore-journal`; this
 * commit reports the undo-journal token that completes it, so ⌘Z restores the
 * file byte for byte (a blank line or an indentation a move changed included).
 *
 * ONE element. Several are a {@link commitStudioSequence} (P3-D): each move is
 * written against the file the previous one left.
 */
export async function commitStudioMove(edit: StructuralEditPayload, rollback?: StructuralCommitRollback): Promise<void> {
  await commitStructural([edit], 'Move refused', { fill: true, ...(rollback ? { rollback } : {}) })
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
 * The undo is the undo journal's `restore` for a move AND a copy (both files
 * back, byte for byte — an id recorded before the write cannot name the
 * container the element left, because the write pruned the import above it, and
 * a copy may have written state or constants that deleting its markup would
 * leave behind).
 */
export async function commitStudioTransplant(transplant: {
  nodeId: string
  parentNodeId: string
  anchorNodeId: string | null
  position: 'before' | 'after'
  copy: boolean
  /** G-1c - the `.map` row the node is a copy of (`nodeId` is then its template). */
  row?: { array: string; index: number; length: number }
  /** Opens a source file in the code panel - the remedy for a binding that cannot travel. */
  openSource: (origin: { rel: string; line: number; col: number }) => void
}): Promise<void> {
  let carried: StudioSaveResponse['carried']
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
        ...(transplant.row ? { row: transplant.row } : {}),
        // Always the journal's `restore` (G-1): a copy may carry state and constants.
        exactUndo: true as const,
      },
    ],
    'Cannot move this between frames',
    {
      // G-1 - what the write copied beside the markup; told once it has landed.
      onAnswer: (answer) => {
        carried = answer.carried
      },
      onLanded: () => announceCarried(carried),
      // `captured-scope` - the element reads a value that lives in its own
      // screen's code and nothing in the carry can write down (a prop nobody
      // gives a value to, a custom hook's result). The way forward is to show
      // where it is declared.
      refusalRemedy: (refusal) => {
        if (refusal.reason !== 'captured-scope') return null
        const origin = decodeSourceNodeId(refusal.nodeId)
        return origin ? { label: 'Open code', onSelect: () => transplant.openSource(origin) } : null
      },
      // Both are the undo journal's `restore` (G-1): a copy can write state,
      // constants and imports beside the markup, which deleting what it made
      // would leave behind.
      undo: {
        label: transplant.copy || transplant.row ? 'Copy into another frame' : 'Move into another frame',
        template: { kind: 'restore-journal' },
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
 * still pending above it. In place only (⌘D, the toolbar button); a copy that
 * lands somewhere else is {@link commitStudioDuplicateTo}.
 */
export async function commitStudioDuplicate(
  nodeIds: readonly string[],
  optimistic?: OptimisticPreviewHandle, // `perf-10` — see `StructuralCommitOptions.optimistic`.
): Promise<void> {
  if (nodeIds.length === 0) return
  await commitStructural(nodeIds.map((nodeId) => ({ kind: 'duplicate', nodeId })), 'Duplicate refused', {
    undo: { label: 'Duplicate', template: { kind: 'delete-created' } },
    ...(optimistic ? { optimistic } : {}),
  })
}

/**
 * K2 / ⌘V — copies written INTO a container rather than beside their
 * originals (Alt+drag, a paste). Each names the container and, optionally, the
 * existing child to write it next to (`null` appends, which is a real
 * position). A copy into a container in ANOTHER file (`crossFile`, ERR-16) is
 * a `transplant` with `copy: true`, which carries the imports it needs there.
 *
 * Several copies (ERR-7) are one SEQUENCE: they land as a run at one place, so
 * each is written against the file the one before it left, in the order
 * `planSourceDuplicateTo` returned them. One write, one entry, and its undo
 * deletes every copy (the journal's `restore` when any of them crossed into
 * another file).
 */
export async function commitStudioDuplicateTo(
  copies: readonly SourceDuplicateToCommit[],
): Promise<void> {
  const edits: StructuralEditPayload[] = copies.map((copy) => ({
    kind: copy.crossFile ? 'transplant' : 'duplicate',
    nodeId: copy.nodeId,
    parentNodeId: copy.parentNodeId,
    ...(copy.anchorNodeId ? { anchorNodeId: copy.anchorNodeId, position: copy.position } : {}),
    ...(copy.crossFile ? { copy: true } : {}),
    ...(copy.parentIsEmpty || copy.crossFile ? { exactUndo: true } : {}),
  }))
  // A copy into another file (G-1) may write state, constants and imports beside
  // its markup, and one into a childless container may expand `<X />`: deleting
  // what it made would leave those behind, so its undo is the journal's `restore`.
  const crossFile = copies.some((copy) => copy.crossFile)
  const exact = crossFile || copies.some((copy) => copy.parentIsEmpty)
  let carried: StudioSaveResponse['carried']
  const options = {
    undo: { label: 'Duplicate', template: exact ? { kind: 'restore-journal' as const } : { kind: 'delete-created' as const } },
    onAnswer: (answer: StudioSaveResponse) => {
      carried = answer.carried
    },
    onLanded: () => announceCarried(carried),
  }
  if (edits.length > 1) await commitStudioSequence(edits, 'Duplicate refused', options)
  else if (edits.length === 1) await commitStructural(edits, 'Duplicate refused', options)
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
      undo: { label: `Wrap in <${wrap.name}>`, template: { kind: 'restore-journal' } },
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
  /**
   * PA-6 — Frame selection: the container is sized and placed, and each member
   * (in `nodeIds` order) gets the patch that keeps it where it was. A frame
   * around ONE element is a run of one; a plain group of one is `wrap`.
   */
  frame?: { wrapperStyle: Record<string, string>; memberStyles: Record<string, string | number | null>[] }
}): Promise<void> {
  const [nodeId, ...siblingNodeIds] = group.nodeIds
  if (nodeId === undefined || (siblingNodeIds.length === 0 && !group.frame)) return
  await commitStructural(
    [
      {
        kind: 'group',
        nodeId,
        siblingNodeIds,
        name: group.name,
        ...(group.importSpecifier === undefined ? {} : { importSpecifier: group.importSpecifier }),
        ...(group.designSystemImport === undefined ? {} : { designSystemImport: group.designSystemImport }),
        ...(group.frame ? { frame: group.frame } : {}),
      },
    ],
    group.frame ? 'Frame refused' : 'Group refused',
    {
      // A frame rewrote the members too, and a gathering group or a component container has no plain inverse: the journal's pre-image.
      undo: { label: group.frame ? 'Frame selection' : 'Group', template: { kind: 'restore-journal' } },
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
 * Its undo is the undo journal's `restore` (G-7), like a group's and a wrap's:
 * a container that carried a class, an inline style, an id or behaviour (which
 * an ungroup keeps, emptied) cannot be written back around its children by a
 * plain re-group, and the journal's pre-image brings every byte back whatever
 * the container was.
 */
export async function commitStudioUngroup(nodeId: string): Promise<void> {
  await commitStructural([{ kind: 'ungroup', nodeId }], 'Ungroup refused', {
    undo: { label: 'Ungroup', template: { kind: 'restore-journal' } },
  })
}

/**
 * P5-C (DET-5) — the user's Detach: one call site, or a multi-selection
 * written as ONE `sequence` (each detach against the file the previous one
 * left, all or nothing). Resolves with the server's answer — its refusals and
 * `detachDetails`, which `detachInstances` presents itself (`quiet`) — or
 * `null` when no answer came back (already reported).
 *
 * Selects what the write created: the markup that replaced each call site.
 * ⌘Z is the undo journal's `restore` — one entry for the whole gesture.
 */
export async function commitStudioDetach(
  edits: readonly StructuralEditPayload[],
  label: string,
): Promise<StudioSaveResponse | null> {
  let answer: StudioSaveResponse | null = null
  await commitStructural(edits, 'Detach refused', {
    undo: { label, template: { kind: 'restore-journal' } },
    select: 'created',
    quiet: true,
    ...(edits.length > 1 ? { sequence: true as const } : {}),
    onAnswer: (received) => {
      answer = received
    },
  })
  return answer
}

/**
 * P3-D (OD-7) — detach ONE call site so that a structural gesture on the
 * markup inside a shared component applies to this instance only. Resolves
 * with what the write reported once the board has re-read it, or `null` when
 * it did not land — refused quietly, because the caller answers a refusal
 * with the one dialog the gesture would have shown anyway.
 *
 * Its undo is the undo journal's `restore` (P3-F): the page exactly as it was
 * before the detach, call site and import together.
 */
export async function commitStudioDetachForInstance(detach: {
  callSiteNodeId: string
  label: string
}): Promise<StructuralWriteOutcome | null> {
  let landed: StructuralWriteOutcome | null = null
  await commitStructural([{ kind: 'detach', nodeId: detach.callSiteNodeId }], 'Detach refused', {
    undo: {
      label: detach.label,
      template: { kind: 'restore-journal' },
    },
    onLanded: (outcome) => {
      landed = outcome
    },
    quiet: true,
  })
  return landed
}

/**
 * G-9 (OD-24) — "Unroll list": a `.map` over an array literal written out as
 * the elements it rendered. Resolves with what the write made once the board
 * has re-read it (`createdNodeIds` are the written rows, in array order), or
 * `null` when it did not land — the refusal has already been shown, as the
 * warning toast every refused structural write gets.
 *
 * Its undo is the undo journal's `restore` (P3-F): the rows replace the
 * `.map` and drop its `key`, which no edit kind can write back.
 */
export async function commitStudioUnrollList(unroll: { edit: StructuralEditPayload; label: string }): Promise<StructuralWriteOutcome | null> {
  let landed: StructuralWriteOutcome | null = null
  await commitStructural([unroll.edit], 'Unroll list refused', {
    undo: { label: unroll.label, template: { kind: 'restore-journal' } },
    select: 'created',
    onLanded: (outcome) => {
      landed = outcome
    },
  })
  return landed
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
  /**
   * The container had no children (`SourceInsertCommit.parentIsEmpty`): the
   * write may expand a self-closing `<X />`, so its ⌘Z is the undo journal's
   * `restore` — the file as it was, byte for byte — instead of a `delete`.
   */
  parentIsEmpty?: boolean
  name: string
  /**
   * Omit for an INTRINSIC element (`<div>`, `<p>`) — those need no import, and
   * `insertJsxElement` reads the field's absence as exactly that. Present for a
   * package component, which is imported from this specifier.
   */
  importSpecifier?: string
  /** `'default'` when `name` is the default export of `importSpecifier`; omitted for a named export. */
  importStyle?: 'default'
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
   * The element's content: literal text (`<p>Heading</p>`), or a nested
   * subtree written in the SAME splice (`InsertEditSchema.children`) — P5-A's
   * pasted SVG, P5-D's drawn `<svg><path/></svg>`.
   */
  children?: string | readonly SlotJsxNode[]
  /**
   * P5-B (IMG-2) — more intrinsic elements written right AFTER this one, in
   * order, in the SAME write (`InsertEditSchema.siblings`): three dropped
   * images are one insert, one resync and one undo step, whose inverse deletes
   * all three (`delete-created` reads every created id).
   */
  siblings?: readonly { name: string; props?: Record<string, InsertPropValue>; children?: string | readonly SlotJsxNode[] }[]
  /**
   * G-10 - this insert is a pasted HTML fragment: `css` is the text of the
   * `<style>` blocks that came with it. The server writes the elements AND the
   * styles (into the page's own stylesheet, else inline) as one journaled step,
   * so its ⌘Z is always the journal's `restore`.
   */
  pastedHtml?: { css?: string }
  /** Told the server's answer (the paste reads where its styles went), and again once the board has re-read the write. */
  onAnswer?: (answer: StudioSaveResponse) => void
  onLanded?: StructuralCommitOptions['onLanded']
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
        ...(insert.parentIsEmpty ? { exactUndo: true } : {}),
        ...(insert.pastedHtml ? { pastedHtml: insert.pastedHtml } : {}),
        // Spread conditionally, never passed as `undefined`: the codemod
        // branches on `importSpecifier === undefined` to choose intrinsic vs
        // component, and the wire schema has it optional for the same reason.
        ...(insert.importSpecifier === undefined ? {} : { importSpecifier: insert.importSpecifier }),
        ...(insert.importStyle === undefined ? {} : { importStyle: insert.importStyle }),
        ...(insert.designSystemImport === undefined ? {} : { designSystemImport: insert.designSystemImport }),
        ...(insert.children === undefined ? {} : { children: insert.children }),
        props: insert.props,
        ...(insert.siblings && insert.siblings.length > 0 ? { siblings: insert.siblings.map((node) => ({ ...node })) } : {}),
      },
    ],
    'Add refused',
    {
      undo: {
        label: insert.undoLabel ?? `Add ${insert.name}`,
        template:
          insert.parentIsEmpty || insert.pastedHtml
            ? { kind: 'restore-journal' }
            : insert.designSystemImport
              ? { kind: 'restore-journal-else-delete-created' }
              : { kind: 'delete-created' },
      },
      ...(insert.optimistic ? { optimistic: insert.optimistic } : {}),
      ...(insert.onAnswer ? { onAnswer: insert.onAnswer } : {}),
      ...(insert.onLanded ? { onLanded: insert.onLanded } : {}),
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
 * OD-8 — a `.map` row's reorder, delete, duplicate or paste, written to the
 * ARRAY LITERAL the `.map` iterates: one `list-item` edit, one write, one
 * undo entry (`template` — known up front for everything but a delete, whose
 * inverse needs the bytes the write reports).
 *
 * Nothing is mutated on the canvas first: a row's id is its index, so the
 * board's own re-read is what gives every row its new place. `onLanded` runs
 * once it has (`listRowSourceWrites.ts` selects the moved/copied rows and
 * records the rows' remap there).
 */
export async function commitStudioListItem(
  edit: StructuralEditPayload,
  refusalTitle: string,
  undo: { label: string; template: StructuralInverseTemplate },
  onLanded?: (outcome: StructuralWriteOutcome) => void,
): Promise<void> {
  await commitStructural([edit], refusalTitle, { undo, select: 'created', ...(onLanded ? { onLanded } : {}) })
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
  /** P3-D — post `edits` as an ordered sequence (a redo of a sequence gesture). */
  sequence?: true,
): Promise<void> {
  await commitStructural(edits, direction === 'undo' ? `Could not undo ${label}` : `Could not redo ${label}`, {
    reissue: direction,
    rollback,
    ...(sequence ? { sequence } : {}),
  })
}
