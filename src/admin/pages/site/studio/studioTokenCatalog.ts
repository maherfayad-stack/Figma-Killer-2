/**
 * studioTokenCatalog - the editor's client for `GET|POST /admin/api/studio/token-catalog`
 * (CT-1, CT-2): the open project's design tokens as a catalog with modes, kept
 * in a tiny external store, and the one write the inspector makes to it -
 * declaring a new variable.
 *
 * Same "tiny external store" shape as `studioRawCssStores.ts` /
 * `studioTokenStatus.ts`: the picker needs to know when a fresh catalog lands
 * without subscribing to `site` (whose reference changes on every unrelated
 * node edit). The catalog is a server read of the stylesheets the canvas loads,
 * so it can never disagree with what the canvas renders; `ProjectVariablesProvider`
 * refetches whenever the load's raw CSS changes.
 *
 * Writes go to the server planner (`tokenWrite.ts`'s `planTokenEdits`) - the
 * SAME one `studio_set_tokens` uses - and the board is re-synced afterwards
 * (`resyncBoardAfterWrite`), so a stylesheet edit repaints every frame.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { TokenCatalogSchema, type TokenCatalog, type TokenEdit } from '@core/studio-tokens'
import { getStudioTokenState, publishStudioTokenState } from './studioTokenCatalogStore'
import { journaledWriteOutcome } from './journaledUndo'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { studioWriteDir } from './studioWorkspaceDir'

const ROUTE = '/admin/api/studio/token-catalog'

const WriteResponseSchema = Type.Object({
  ok: Type.Literal(true),
  files: Type.Array(Type.Object({ path: Type.String(), hash: Type.String() })),
  inserted: Type.Array(Type.Object({ name: Type.String() })),
  renamed: Type.Array(Type.Object({ name: Type.String(), to: Type.String(), mentions: Type.Integer(), files: Type.Integer(), unfollowed: Type.Array(Type.String()) })),
  removed: Type.Array(Type.Object({ name: Type.String(), declarations: Type.Integer(), movedReaders: Type.Integer(), replacedWith: Type.Optional(Type.String()) })),
  /** The undo-journal entry that puts every file this write changed back; `null` when it could not be journaled. */
  undoToken: Type.Union([Type.String(), Type.Null()]),
})

export type StudioTokenWriteResult = Static<typeof WriteResponseSchema>

/**
 * Re-reads the catalog. Never throws: a project whose styles cannot be read
 * simply has no variables to offer, which is a real answer, and the picker's
 * "no affordance when there is nothing to offer" rule handles it.
 *
 * `usage: true` (the Variables panel) also scans where each token is read and
 * reads the values a JavaScript theme defines (CT-6); a plain refresh keeps the
 * last of both rather than dropping the panel's counts and rows.
 */
export function refreshStudioTokenCatalog(options: { usage?: boolean } = {}): Promise<TokenCatalog | null> {
  const wantsUsage = options.usage === true
  // Two surfaces (the inspector's pickers, the board's mode chips) ask in the
  // same commit when the CSS changes: one request answers both. The window is
  // the current task only - a later call (the re-read after a write) must see
  // the disk as it is then, never an answer that was already in flight.
  const pending = sameTaskRefresh.get(wantsUsage)
  if (pending) return pending
  const request = readStudioTokenCatalog(wantsUsage)
  sameTaskRefresh.set(wantsUsage, request)
  queueMicrotask(() => sameTaskRefresh.delete(wantsUsage))
  return request
}

const sameTaskRefresh = new Map<boolean, Promise<TokenCatalog | null>>()

async function readStudioTokenCatalog(wantsUsage: boolean): Promise<TokenCatalog | null> {
  const dir = studioWriteDir() ?? undefined
  try {
    const fresh = await apiRequest(ROUTE, {
      query: { dir, ...(wantsUsage ? { usage: '1' } : {}) },
      schema: TokenCatalogSchema,
    })
    const usage = wantsUsage
      ? new Map(fresh.tokens.flatMap((token) => (token.usage ? [[token.name, token.usage] as const] : [])))
      : getStudioTokenState().usage
    // A plain refresh (the picker's) does not read the JavaScript themes; keep the ones the panel last read.
    const previous = getStudioTokenState().catalog
    const catalog = fresh.jsTheme || !previous?.jsTheme ? fresh : { ...fresh, jsTheme: previous.jsTheme }
    publishStudioTokenState({ catalog, usage })
    return catalog
  } catch (err) {
    console.error('[studioTokenCatalog] could not read the token catalog:', err)
    return getStudioTokenState().catalog
  }
}

/**
 * Applies token edits through the server planner, as ONE write with ONE undo
 * entry labelled `undoLabel` (the server journals every file the write changed;
 * `journaledUndo.ts` turns its token into the entry's inverse). Throws the
 * server's refusal - its message already carries the remedy - for the caller
 * to show next to the control; on success re-syncs the board and refreshes the
 * catalog (and the usage counts, when the panel had asked for them).
 */
export async function applyStudioTokenEdits(edits: readonly TokenEdit[], undoLabel: string): Promise<StudioTokenWriteResult> {
  const dir = studioWriteDir() ?? undefined
  const result = await apiRequest(ROUTE, {
    method: 'POST',
    body: { dir, edits },
    schema: WriteResponseSchema,
  })
  await resyncBoardAfterWrite(result.files.map((file) => file.path), {
    structuralOutcome: journaledWriteOutcome(undoLabel, [], result.undoToken ?? undefined),
  })
  await refreshStudioTokenCatalog({ usage: getStudioTokenState().usage !== null })
  return result
}

/** Declares `name: value` as a new variable in a project stylesheet; resolves to the declared name. */
export async function createStudioVariable(request: { name: string; value: string }): Promise<string> {
  const result = await applyStudioTokenEdits([{ op: 'insert', name: request.name, value: request.value }], `Create ${request.name}`)
  return result.inserted[0]?.name ?? request.name
}
