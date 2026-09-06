/**
 * studioStructuralCommits — the one-shot commits behind a STRUCTURAL gesture on
 * a studio-imported board: move, reparent, duplicate, wrap, delete and insert.
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
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { postEdits, type InsertPropValue } from './studioSaveRequests'

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
 * which is why it happens on EVERY outcome: a successful write shifted every
 * `line:col` id below it, and a refused one has to be taken back.
 */
export async function commitStudioMove(
  nodeId: string,
  anchorNodeId: string,
  position: 'before' | 'after',
): Promise<void> {
  await commitStructural([{ kind: 'move', nodeId, anchorNodeId, position }], 'Move refused')
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
export async function commitStudioDuplicate(nodeIds: readonly string[]): Promise<void> {
  if (nodeIds.length === 0) return
  await commitStructural(
    nodeIds.map((nodeId) => ({ kind: 'duplicate', nodeId })),
    'Duplicate refused',
    {
      title: nodeIds.length === 1 ? 'Duplicated' : `Duplicated ${nodeIds.length} elements`,
      body: 'Written to your project source.',
    },
  )
}

/**
 * W4-1 — wrapping one element in a new container written into the user's
 * `.tsx`.
 *
 * `name`/`importSpecifier` spell the wrapper the way `commitStudioInsert` spells
 * a new element: an intrinsic tag (`div`) needs no import and omits the
 * specifier; a design-system container names where it comes from and the codemod
 * writes that import alongside.
 */
export async function commitStudioWrap(wrap: {
  nodeId: string
  name: string
  importSpecifier?: string
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'wrap',
        nodeId: wrap.nodeId,
        name: wrap.name,
        ...(wrap.importSpecifier === undefined ? {} : { importSpecifier: wrap.importSpecifier }),
      },
    ],
    'Wrap refused',
    { title: `Wrapped in <${wrap.name}>`, body: 'Written to your project source.' },
  )
}

/**
 * `struct-01` — removing one or more elements from the user's `.tsx`.
 *
 * Several ids in one request on purpose: `applyStudioEditBatch` orders a batch
 * bottom-to-top, so removing a lower element cannot move a higher one's line,
 * which makes a multi-select delete a single honest transaction rather than N
 * racing ones.
 */
export async function commitStudioDelete(nodeIds: readonly string[]): Promise<void> {
  if (nodeIds.length === 0) return
  await commitStructural(nodeIds.map((nodeId) => ({ kind: 'delete', nodeId })), 'Delete refused')
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
   * component, which is imported from this specifier.
   */
  importSpecifier?: string
  props: Record<string, InsertPropValue>
  /** Literal text written as the element's only child, e.g. `<p>Heading</p>`. */
  children?: string
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
        ...(insert.children === undefined ? {} : { children: insert.children }),
        props: insert.props,
      },
    ],
    'Add refused',
    { title: `Added ${insert.name}`, body: 'Written to your project source.' },
  )
}

/**
 * Shared body of the structural commits: flush any pending debounced save,
 * post, report what the source refused, and re-sync the board with disk when
 * (and only when) a write actually landed.
 *
 * `success` is passed only by commits with no optimistic canvas change to
 * stand in for the result — an insert shows nothing at all until the reload, so
 * silence would be indistinguishable from a no-op. A move or a delete has
 * already updated the tree, so it stays quiet on success.
 *
 * `STUDIO-FIGMA-PARITY-PLAN.md` 0.2 (audit E2) — two fixes, both applied here:
 *
 *   1. The reload used to fire unconditionally from a `finally` block, on
 *      EVERY outcome including a pure refusal/skip where nothing reached
 *      disk. `loadSite()` wipes the whole undo stack and clears
 *      `hasUnsavedChanges` unconditionally — so a user who typed five
 *      headings, then dragged one layer in the tree, lost Ctrl+Z for all
 *      five headings, and any edit still inside its 2s autosave debounce at
 *      that moment was silently discarded. Trap #5 ("reload only when a
 *      write landed") already applies to `fsCodemodAdapter.saveSite`'s own
 *      reload gate (`result.written > 0`) — this now matches it. (Since
 *      `historyPreservation.ts` landed alongside this, most reloads no
 *      longer wipe history at all when they DO fire — see `loadSite`'s own
 *      doc — so this gate mainly matters for the "nothing to resync" case:
 *      reloading when disk is unchanged would replace the user's optimistic
 *      move/delete/insert with the pre-edit source, undoing it silently.
 *      KNOWN LIMITATION, not fixed here: a REFUSED move/delete (the
 *      "residue only the AST can answer" case — see `commitStudioMove`'s own
 *      doc) already applied its optimistic tree mutation before the refusal
 *      came back; with no reload to correct it, the board can show a
 *      move/delete that never actually reached the source until some LATER,
 *      unrelated reload happens to resync it. Building a targeted revert of
 *      just that transaction (rather than either "reload everything" or
 *      "leave it diverged") is `STUDIO-FIGMA-PARITY-PLAN.md`'s already-
 *      identified follow-up (audit finding E3), deferred deliberately: doing
 *      it here risks the exact same Ctrl+Z-vs-in-flight-POST race E3 already
 *      catalogs as needing its own guard.
 *   2. Before posting, flush any edit still inside the autosave debounce and
 *      AWAIT it, so a prop/text/style edit made moments before this
 *      structural gesture is durably written (and, per 0.1's fix, its own
 *      save-diff baseline advanced) before a later reload's re-parse could
 *      either discard it outright or — worse — target it at now-stale ids.
 *      A flush failure must not block the structural edit the user actually
 *      asked for; it's logged and the commit proceeds regardless (the
 *      autosave loop's own error state already surfaces that failure via the
 *      toolbar's save indicator).
 *
 * `STUDIO-FIGMA-PARITY-PLAN.md` Track C5 (reload surgery, Band 2, built on
 * top of 0.2 above) — the ONE thing that changed since: "reload" on a landed
 * write no longer means "reparse the whole workspace" by default. See
 * `studioBoardResync.ts`'s `resyncBoardAfterWrite` for the full contract;
 * every gate described in items 1/2 above (still gated on `written > 0`,
 * still flushes first, still leaves a refused move/delete visually diverged
 * until a later reload) is UNCHANGED — C5 only changes what a "reload" does
 * once the gate says one should happen.
 */
async function commitStructural(
  edits: readonly Record<string, unknown>[],
  refusalTitle: string,
  success?: { title: string; body: string },
): Promise<void> {
  try {
    await flushEditorSave()
  } catch (err) {
    console.error('[studioSaveRequests] pre-structural-edit save flush failed:', err)
  }

  try {
    const result = await postEdits(edits)
    for (const refusal of result.refusals ?? []) {
      pushToast({ kind: 'error', title: refusalTitle, body: refusal.message })
    }
    if (success && result.written > 0) {
      pushToast({ kind: 'success', title: success.title, body: success.body, location: 'module-inserter' })
    }
    // A skip with no refusal means the location decoded to nothing writable at
    // all — the id was stale against disk. Same remedy, but say so rather than
    // letting the change quietly reappear after the reload with no explanation.
    const unexplained = result.skipped - (result.refusals ?? []).length
    const willReload = result.written > 0
    if (unexplained > 0) {
      pushToast({
        kind: 'error',
        title: refusalTitle,
        body: willReload
          ? 'The code no longer has an element at the position the canvas was showing. The board has been reloaded from the files on disk.'
          : 'The code no longer has an element at the position the canvas was showing.',
      })
    }
    // trap #5 — reload only when a write actually landed. Nothing reaching
    // disk means there is nothing to resync FROM; reloading anyway would
    // replace whatever the canvas is currently (optimistically) showing with
    // the unchanged, pre-edit source.
    //
    // Track C5 (reload surgery) — `resyncBoardAfterWrite` tries a targeted
    // per-page resync first (see its own doc) and only falls back to the
    // full `requestCmsSiteReload()` this used to call unconditionally when
    // that isn't provably safe. Every OTHER behaviour on this line is
    // unchanged: still gated on `willReload`, still the thing that (per
    // (1) above) leaves a refused move/delete visually diverged until a
    // later reload happens to resync it.
    if (willReload) await resyncBoardAfterWrite(result.touchedFiles ?? [])
  } catch (err) {
    // Fire-and-forget from the store's mutation guard, so this is the only
    // place the failure can be reported. No response was ever obtained, so
    // there is no `written` count to check — the safe assumption after a
    // failed request is "disk is unchanged," which means no reload either
    // (see this function's doc for why an unconditional reload here was the
    // bug, not the fix).
    console.error('[studioSaveRequests] structural edit failed:', err)
    pushToast({
      kind: 'error',
      title: refusalTitle,
      body: getErrorMessage(err, 'The change could not be written to the project source.'),
    })
  }
}
