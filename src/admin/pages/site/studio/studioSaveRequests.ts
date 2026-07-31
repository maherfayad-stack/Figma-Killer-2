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
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

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
})

export type StudioSaveResponse = Static<typeof StudioSaveResponseSchema>

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
})
export type CreatedStudioPage = Static<typeof StudioCreatePageResponseSchema>

/**
 * Creates a new page (`pages/<Component>.tsx` with a starter component) in the
 * active project and resolves to its `{ pageId, title }`. Targets the SAME
 * `dir` every other studio call uses, so the file lands in the project the
 * canvas is currently showing. `name` is optional — omit it and the server
 * auto-names the page `Page`, `Page2`, …. Throws `ApiError` on failure (e.g. a
 * name collision → 409) so the caller can toast the message. The caller
 * reloads the workspace afterwards (`requestCmsSiteReload`) to render it.
 */
export function createStudioPage(name?: string): Promise<CreatedStudioPage> {
  const overrideDir = getStudioWorkspaceDir()
  const body: { name?: string; dir?: string } = {}
  if (name) body.name = name
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
  importSpecifier: string
  props: Record<string, string | number | boolean>
}): Promise<void> {
  await commitStructural(
    [
      {
        kind: 'insert',
        nodeId: insert.parentNodeId,
        ...(insert.anchorNodeId ? { anchorNodeId: insert.anchorNodeId, position: insert.position } : {}),
        name: insert.name,
        importSpecifier: insert.importSpecifier,
        props: insert.props,
      },
    ],
    'Add refused',
    { title: `Added ${insert.name}`, body: 'Written to your project source.' },
  )
}

/**
 * Shared body of the structural commits: post, report what the source refused,
 * and re-sync the board with disk whatever happened.
 *
 * `success` is passed only by commits with no optimistic canvas change to
 * stand in for the result — an insert shows nothing at all until the reload, so
 * silence would be indistinguishable from a no-op. A move or a delete has
 * already updated the tree, so it stays quiet on success.
 */
async function commitStructural(
  edits: readonly Record<string, unknown>[],
  refusalTitle: string,
  success?: { title: string; body: string },
): Promise<void> {
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
    if (unexplained > 0) {
      pushToast({
        kind: 'error',
        title: refusalTitle,
        body: 'The code no longer has an element at the position the canvas was showing. The board has been reloaded from the files on disk.',
      })
    }
  } catch (err) {
    // Fire-and-forget from the store's mutation guard, so this is the only
    // place the failure can be reported — and the reload below is what puts
    // the board back in step with the file it failed to change.
    console.error('[studioSaveRequests] structural edit failed:', err)
    pushToast({
      kind: 'error',
      title: refusalTitle,
      body: getErrorMessage(err, 'The change could not be written to the project source.'),
    })
  } finally {
    requestCmsSiteReload()
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
