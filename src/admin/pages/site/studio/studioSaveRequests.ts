/**
 * studioSaveRequests — the `POST /admin/api/studio/save` wire contract, plus
 * every ONE-SHOT edit that commits through it directly instead of waiting for
 * `fsCodemodAdapter`'s autosave diff.
 *
 * Extracted from `fsCodemodAdapter.ts`, which had absorbed the client half of
 * several workstreams at once and was carrying its own size-budget grandfather
 * entry as debt (`STATE.md`'s `debt-01`). The split follows that entry's own
 * named plan — "one module per edit kind, leaving the adapter as the
 * dispatcher its name promises". The adapter still owns load/save-diff; this
 * module owns the request shape and the deliberate, non-debounced commits.
 *
 * Why these live together: each one is a discrete, user-confirmed action
 * (replace this image, detach this instance, swap this component) rather than
 * a value the user is continuously typing, so there is nothing to debounce and
 * no diff to compute — they post a single edit and act on the response. They
 * all need the same three things, which is exactly what this module holds: the
 * response schema, the active workspace dir, and the reload-on-success rule.
 */
import type { StyleRule } from '@core/page-tree'
import type { PageKind } from '@core/studio-board'
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { dispatchCmsSitePagesPatch, requestCmsSiteReload } from '@admin/state/adminEvents'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { recordCreatedStylesheet, ruleIdFromCssCreateNodeId } from './styleRuleWriteback'
import { fetchStudioPagesById } from './studioLiveReloadFetch'

/**
 * POST /admin/api/studio/save response. `shifted` is true when a write changed
 * a file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line) — the in-memory `line:col` node ids are then stale against disk
 * and must be re-derived by re-parsing (see the `shifted` branch in
 * `fsCodemodAdapter`'s `saveSite`).
 */
export const StudioSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  written: Type.Number(),
  skipped: Type.Number(),
  shifted: Type.Boolean(),
  /**
   * True when any edit in the batch targeted an inlined node, whose writeback
   * goes to the component's own file and therefore changes EVERY instance of
   * it. The other instances on the board still show their old values, so the
   * client reloads — same remedy as `shifted`, different cause.
   */
  sharedComponents: Type.Boolean(),
  /**
   * WS-4.4/4.5/6.3 — every `detach`/`swap`/`css` edit in the batch that
   * REFUSED rather than writing, with a specific reason + message
   * (`StudioEditRefusal` on the server). `Type.Optional` (not every server
   * build has this field yet mid-rollout; tolerant like every other response
   * schema here) and defaults to empty when read.
   */
  refusals: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    kind: Type.String(),
    reason: Type.String(),
    message: Type.String(),
  }))),
  /**
   * instance-ui-01 — every `swap` edit in the batch that SUCCEEDED, with
   * what changed on the call site (mirrors `refusals` for the failure case).
   * `Type.Optional`, same tolerant-rollout reasoning as `refusals` above.
   */
  swapDetails: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    removedProps: Type.Array(Type.String()),
    unfilledRequiredProps: Type.Array(Type.String()),
  }))),
  /**
   * `STUDIO-FIGMA-PARITY-PLAN.md` item 0.7 — every edit that skipped with no
   * matching `refusals` entry (`StudioEditUnexplainedSkip` on the server —
   * `server/handlers/studioWriteback.ts`), i.e. exactly the set the
   * `unexplainedSkips` toast in `fsCodemodAdapter.ts` currently reports only
   * as a bare count. `Type.Optional`, same tolerant-rollout reasoning as
   * `refusals`/`swapDetails` above — an older server build simply omits it,
   * and the client falls back to `result.skipped - refusals.length`.
   */
  unexplainedSkips: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    kind: Type.String(),
  }))),
  /**
   * Track B1 — every `css`/`create` edit in the batch that SUCCEEDED, with
   * the workspace-relative stylesheet path the server actually invented
   * (mirrors `swapDetails` for the "new file" case). `Type.Optional`, same
   * tolerant-rollout reasoning as `refusals`/`swapDetails` above. See
   * `notifyCreatedStylesheets` for how a caller turns this into both the
   * user-visible "which file was created" surfacing and the write-back map
   * update that makes the rule editable on its next edit without a reload.
   */
  createdStylesheets: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    file: Type.String(),
  }))),
  /**
   * Track C5 (reload surgery) — every workspace-ROOT-relative file this
   * batch actually wrote to (`StudioEditBatchResult.touchedFiles`, server-
   * side). `Type.Optional`, same tolerant-rollout reasoning as the fields
   * above. `commitStructural` feeds this straight into `POST
   * /admin/api/studio/reload-scope` to decide whether a targeted per-page
   * reload is safe — see that route's own doc for the full contract. An
   * absent/empty value simply means "nothing to narrow", never an error.
   */
  touchedFiles: Type.Optional(Type.Array(Type.String())),
})

export type StudioSaveResponse = Static<typeof StudioSaveResponseSchema>

/**
 * Track B1's create branch, the user-visible half: turns
 * `StudioSaveResponse.createdStylesheets` into (1) a toast naming the
 * specific file Studio just created and which class it belongs to — "a
 * created file is a bigger surprise than a chosen one, so it must be
 * visible and attributable" — and (2) the `styleRuleWriteback.ts` write-back
 * map update that makes the SAME rule writable through the ordinary `set`
 * path on its very next edit, with no reload. A no-op when the field is
 * absent/empty (an older server build, or a save with no `create` edits).
 *
 * Called once per save response that may carry edits from
 * `collectStyleRuleEdits`: `fsCodemodAdapter.ts`'s `saveSite` invokes it as
 * `notifyCreatedStylesheets(result, site.styleRules)`, right alongside its
 * existing `unexplainedSkips`/`shifted` handling.
 */
export function notifyCreatedStylesheets(
  result: StudioSaveResponse,
  styleRules: Record<string, StyleRule>,
): void {
  for (const created of result.createdStylesheets ?? []) {
    const ruleId = ruleIdFromCssCreateNodeId(created.nodeId)
    if (!ruleId) continue
    const rule = styleRules[ruleId]
    recordCreatedStylesheet(ruleId, created.file, rule?.selector ?? '')
    pushToast({
      kind: 'success',
      title: 'Stylesheet created',
      body: rule
        ? `Studio created ${created.file} and wired it into your page for “${rule.name}”.`
        : `Studio created ${created.file} and wired it into your page.`,
    })
  }
}

/**
 * Remembered from the last load so every save can tell the server which
 * folder to write. Module state rather than a store slice for the same reason
 * `componentSources` is: it is ephemeral, server-derived, per-load state, not
 * part of the persisted `SiteDocument` shape.
 */
let loadedDir: string | null = null

export function setStudioLoadedDir(dir: string | null): void {
  loadedDir = dir
}

/**
 * The dir every studio write targets: the explicitly-selected project when
 * there is one, otherwise whatever the last load reported. Every call in this
 * module resolves it the same way so a one-shot commit can never land in a
 * different project than the canvas is showing.
 */
export function studioWriteDir(): string | null {
  return getStudioWorkspaceDir() ?? loadedDir
}

/** POST /admin/api/studio/page response — the newly scaffolded page. */
const StudioCreatePageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  relPath: Type.String(),
  /** Kebab id derived from the file path — the value a board frame references. */
  pageId: Type.String(),
  title: Type.String(),
  /**
   * WS-13 step 4 — the scaffolded root element's node id, read by the server
   * actually parsing the file it just wrote (never constructed). Absent only
   * on an unexpected parse failure; the browser doesn't need it (the reload
   * re-parses the whole workspace and the canvas selects by clicking), but an
   * MCP/agent caller (`studio_create_page`, WS-12 §3) needs it to address the
   * new screen's root before any reload.
   */
  rootNodeId: Type.Optional(Type.String()),
})
export type CreatedStudioPage = Static<typeof StudioCreatePageResponseSchema>

/**
 * Creates a new page (a canonical starter component, WS-13 step 4) in the
 * active project and resolves to its `{ pageId, title, rootNodeId }` — the
 * server has already placed it on the board (D5 §11.3), so there is nothing
 * else for the caller to do besides reload. Targets the SAME `dir` every
 * other studio call uses, so the file lands in the project the canvas is
 * currently showing.
 *
 * `name` is optional — omit it and the server auto-names the page from its
 * kind (`Page`, `Page2`, … for a screen; `Sheet`, `Sheet2`, … for a bottom
 * sheet). `kind` is optional too and defaults, server-side, to an ordinary
 * screen.
 *
 * Throws `ApiError` on failure (e.g. a name collision → 409) so the caller can
 * toast the message. The caller reloads the workspace afterwards
 * (`requestCmsSiteReload`) to render it.
 */
export function createStudioPage(
  name?: string,
  kind?: PageKind,
  boardId?: string,
): Promise<CreatedStudioPage> {
  const overrideDir = getStudioWorkspaceDir()
  const body: { name?: string; dir?: string; kind?: PageKind; boardId?: string } = {}
  if (name) body.name = name
  if (kind) body.kind = kind
  // The server places the frame (D5 §11.3); without this it placed it on the
  // FIRST board regardless of which one the author had open.
  if (boardId) body.boardId = boardId
  if (overrideDir) body.dir = overrideDir
  return apiRequest('/admin/api/studio/page', {
    method: 'POST',
    body,
    schema: StudioCreatePageResponseSchema,
  })
}

/** Post one edit to `/save` and return the parsed response. The shared body of every one-shot commit below. */
function postOneEdit(edit: Record<string, unknown>): Promise<StudioSaveResponse> {
  return postEdits([edit])
}

/** Post a batch of edits to `/save`. The save route orders them bottom-to-top before applying. */
function postEdits(edits: readonly Record<string, unknown>[]): Promise<StudioSaveResponse> {
  return apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: studioWriteDir(), edits },
    schema: StudioSaveResponseSchema,
  })
}

/** POST /admin/api/studio/reload-scope response — see `server/handlers/studio/reloadScope.ts`'s doc for the full contract. */
const StudioReloadScopeResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), narrow: Type.Literal(true), pageIds: Type.Array(Type.String()) }),
  Type.Object({ ok: Type.Literal(true), narrow: Type.Literal(false) }),
])

/**
 * Track C5 — resync the board after a STRUCTURAL write (`commitStructural`,
 * below) without a full-workspace reparse when it is safe to skip one.
 *
 * Asks `/reload-scope` whether `touchedFiles` is narrow-safe; when it is,
 * fetches exactly those pages through the SAME `?pageIds=` filtered load the
 * MCP live-reload bridge already uses (`fetchStudioPagesById` —
 * store-agnostic, and it advances `loadedValuesBaseline.ts`'s save-diff
 * baseline for the reloaded pages, same as that bridge needs) and dispatches
 * them as a store patch. Falls back to the existing full `requestCmsSiteReload()`
 * whenever the scope check says "not safe", or whenever ANY step here throws
 * — a narrow reload is an optimization, never the only path to a correct
 * board: any failure here must still leave the board honest.
 */
async function reloadStructuralScope(touchedFiles: readonly string[]): Promise<void> {
  // Nothing to ask about — a batch that landed a write always decodes at
  // least one location (see `applyStudioEditBatch`), so this is defensive,
  // not a real path; skip the round trip rather than ask a question with no
  // honest answer.
  if (touchedFiles.length === 0) {
    requestCmsSiteReload()
    return
  }
  try {
    const scope = await apiRequest('/admin/api/studio/reload-scope', {
      method: 'POST',
      body: { dir: studioWriteDir(), files: touchedFiles },
      schema: StudioReloadScopeResponseSchema,
    })
    if (scope.narrow && scope.pageIds.length > 0) {
      const { pages, missingPageIds } = await fetchStudioPagesById(scope.pageIds)
      dispatchCmsSitePagesPatch({ pages, removedPageIds: missingPageIds })
      return
    }
  } catch (err) {
    console.error('[studioSaveRequests] reload-scope check failed, widening to a full reload:', err)
  }
  requestCmsSiteReload()
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
  props: Record<string, string | number | boolean>
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
 * `reloadStructuralScope`'s own doc for the full targeted-reload contract;
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
    // Track C5 (reload surgery) — `reloadStructuralScope` tries a targeted
    // per-page resync first (see its own doc) and only falls back to the
    // full `requestCmsSiteReload()` this used to call unconditionally when
    // that isn't provably safe. Every OTHER behaviour on this line is
    // unchanged: still gated on `willReload`, still the thing that (per
    // (1) above) leaves a refused move/delete visually diverged until a
    // later reload happens to resync it.
    if (willReload) await reloadStructuralScope(result.touchedFiles ?? [])
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

/**
 * Commits ONE `kind: 'asset'` edit immediately — WS-8.3's "replace this
 * image" action — instead of letting the ordinary optimistic prop-diff loop
 * in `saveSite` pick it up:
 *
 *   - An image swap is a discrete, deliberate commit (pick a file, confirm),
 *     not a value the user is continuously typing — nothing to debounce.
 *   - The edit's target is `PageNode.assetOrigin` (the import declaration),
 *     never the node's own `src` prop — writing it as an ordinary prop diff
 *     would need `updateNodeProps`'s codeProps guard to special-case this one
 *     prop, which the store slices do not currently know how to do.
 *   - The save route ALWAYS reports an asset edit as shared
 *     (`isSharedSourceNodeId`'s `kind === 'asset'` branch) because the import
 *     it rewrites can back more than one node — so this always reloads on a
 *     successful write, the same remedy `saveSite` uses for `shifted`/
 *     `sharedComponents`, without waiting for the next autosave tick.
 *
 * `nodeId` is the ORIGIN's own `rel:line:col` (`PageNode.assetOrigin`), not
 * the editing node's id — same convention the `literal` edit kind uses for
 * resolved text. `assetPath` is the new file's workspace-relative POSIX path.
 */
export async function saveStudioAssetEdit(nodeId: string, assetPath: string): Promise<void> {
  const result = await postOneEdit({ kind: 'asset', nodeId, assetPath })

  if (result.skipped > 0) {
    pushToast({
      kind: 'error',
      title: 'Image was not saved to source',
      body: 'The import naming this image could not be rewritten — it may no longer exist at the location the canvas last saw.',
    })
    return
  }
  if (result.written > 0) requestCmsSiteReload()
}

/**
 * instance-ui-01 — the outcome of a single `detach`/`swap` edit, as reported
 * to the Properties panel. Mirrors the server's `StudioEditRefusal` /
 * `StudioEditSwapDetail` shapes (`server/handlers/studioWriteback.ts`)
 * one-for-one, without importing them — same "browser/server agree on the
 * wire shape, not the type" split every other schema here follows.
 */
export type InstanceCodemodResult =
  | { ok: true; swapDetail?: { removedProps: string[]; unfilledRequiredProps: string[] } }
  | { ok: false; reason: string; message: string }

/**
 * WS-4.4 — the Properties panel's Detach action. Detach is a deliberate,
 * one-shot structural rewrite (replace the call site with its own inlined
 * JSX), not a value the diff loop's "what did the user type" model fits.
 *
 * A refusal (`uses-hooks`, `maps-over-props`, …) is a NAMED, expected
 * outcome — returned to the caller rather than just toasted, so the panel
 * can offer the `extractInstanceCopy` escape hatch inline for the specific
 * reasons that warrant it. `detach` always shifts lines and is always
 * reported `sharedComponents` by the server, so a successful write always
 * reloads the board — the detached node's OWN id is about to become stale.
 */
export async function detachInstance(nodeId: string): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({ kind: 'detach', nodeId })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  return { ok: true }
}

/**
 * WS-4.5 — the Properties panel's Swap action. On success, `swapDetail` names
 * the props the new component dropped and the required props it still needs —
 * the codemod's own numbers, never re-derived here.
 */
export async function swapInstance(
  nodeId: string,
  target: { newComponentName: string; newComponentSource: 'local' | 'package'; newComponentFile: string },
): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({ kind: 'swap', nodeId, ...target })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  const swapDetail = (result.swapDetails ?? []).find((detail) => detail.nodeId === nodeId)
  return { ok: true, swapDetail }
}

/**
 * One element written into a slot — the browser's mirror of
 * `studioSlotWriteback.ts`'s `SlotJsxNodeSchema`, which is what actually
 * validates it on arrival (and is itself `insertJsxElement`'s own
 * `InsertJsxNode`). Declared here rather than imported from
 * `@core/ast-codemods` because that module pulls in ts-morph, which must
 * never reach the browser bundle — the same posture `registerProjectModules.ts`
 * takes for `ICON_PROP_SVG_KEY`.
 *
 * A component fill names its `importSpecifier`; an inline SVG icon
 * (`svgToJsxNode.ts`) is a tree of intrinsic tags and names none.
 */
export interface SlotJsxNode {
  name: string
  importSpecifier?: string
  props?: Record<string, string | number | boolean>
  children?: string | SlotJsxNode[]
}

/**
 * E2.5 — the Properties panel's slot "Add"/"Add another" action:
 * `insert-slot` (E2.4, `insertJsxIntoSlotProp`). `nodeId` is the CALL SITE's
 * own (plain, un-prefixed) id — the slot being filled is one of ITS
 * attributes, never the `studio.slot` container's own id (which is locked
 * structurally and would wrongly refuse `code-placed` — see E2.4's own
 * handoff, "wall #3"). `propName` is the raw slot name (`'header'`), never
 * `callSiteProps:`-prefixed.
 *
 * Always reloads on a successful write (`shifted` is unconditionally `true`
 * for this kind, same as `detach`/`swap`/`insert`) — the filled node has no
 * honest id until the codemod has written it and the board re-parses.
 */
export async function commitStudioInsertSlot(fill: {
  nodeId: string
  propName: string
  node: SlotJsxNode
  /** `'replace'` swaps whatever the slot holds for `node`; omitted adds alongside it. */
  mode?: 'append' | 'replace'
}): Promise<InstanceCodemodResult> {
  const result = await postOneEdit({
    kind: 'insert-slot',
    nodeId: fill.nodeId,
    propName: fill.propName,
    node: fill.node,
    ...(fill.mode ? { mode: fill.mode } : {}),
  })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  return { ok: true }
}

/** POST /admin/api/studio/extract-component response — see that route's module doc. */
const ExtractComponentResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), newFile: Type.String(), newComponentName: Type.String() }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), message: Type.String() }),
])

/**
 * WS-4.4's detach-refusal escape hatch — the Properties panel's "Card uses
 * useState — duplicate it as Card2.tsx and edit that instead?" offer.
 * Duplicates the instance's own component under a fresh name and repoints
 * THIS call site at the copy; always reloads on success (a brand-new file
 * plus a rewritten import is exactly the shape of edit that invalidates
 * in-memory node ids downstream of it).
 */
export async function extractInstanceCopy(nodeId: string): Promise<InstanceCodemodResult & { newFile?: string; newComponentName?: string }> {
  const result = await apiRequest('/admin/api/studio/extract-component', {
    method: 'POST',
    body: { dir: studioWriteDir(), nodeId },
    schema: ExtractComponentResponseSchema,
  })
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
  requestCmsSiteReload()
  return { ok: true, newFile: result.newFile, newComponentName: result.newComponentName }
}
