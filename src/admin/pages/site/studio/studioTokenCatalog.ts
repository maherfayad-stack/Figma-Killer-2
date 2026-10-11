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
import { Type } from '@core/utils/typeboxHelpers'
import { TokenCatalogSchema, type TokenCatalog, type TokenEdit } from '@core/studio-tokens'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { studioWriteDir } from './studioWorkspaceDir'

const ROUTE = '/admin/api/studio/token-catalog'

const WriteResponseSchema = Type.Object({
  ok: Type.Literal(true),
  files: Type.Array(Type.Object({ path: Type.String(), hash: Type.String() })),
  inserted: Type.Array(Type.Object({ name: Type.String() })),
})

let catalog: TokenCatalog | null = null
const listeners = new Set<() => void>()

export function getStudioTokenCatalog(): TokenCatalog | null {
  return catalog
}

export function subscribeStudioTokenCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(next: TokenCatalog | null): void {
  catalog = next
  for (const listener of listeners) listener()
}

/**
 * Re-reads the catalog. Never throws: a project whose styles cannot be read
 * simply has no variables to offer, which is a real answer, and the picker's
 * "no affordance when there is nothing to offer" rule handles it.
 */
export async function refreshStudioTokenCatalog(options: { usage?: boolean } = {}): Promise<TokenCatalog | null> {
  const dir = studioWriteDir() ?? undefined
  try {
    const fresh = await apiRequest(ROUTE, {
      query: { dir, ...(options.usage ? { usage: '1' } : {}) },
      schema: TokenCatalogSchema,
    })
    publish(fresh)
    return fresh
  } catch (err) {
    console.error('[studioTokenCatalog] could not read the token catalog:', err)
    return catalog
  }
}

/**
 * Applies token edits through the server planner. Throws the server's refusal
 * (its message already carries the remedy) for the caller to show next to the
 * control; on success re-syncs the board and refreshes the catalog.
 */
export async function applyStudioTokenEdits(edits: readonly TokenEdit[]): Promise<readonly string[]> {
  const dir = studioWriteDir() ?? undefined
  const result = await apiRequest(ROUTE, {
    method: 'POST',
    body: { dir, edits },
    schema: WriteResponseSchema,
  })
  await resyncBoardAfterWrite(result.files.map((file) => file.path))
  await refreshStudioTokenCatalog()
  return result.inserted.map((entry) => entry.name)
}

/** Declares `name: value` as a new variable in a project stylesheet; resolves to the declared name. */
export async function createStudioVariable(request: { name: string; value: string }): Promise<string> {
  const [name] = await applyStudioTokenEdits([{ op: 'insert', name: request.name, value: request.value }])
  return name ?? request.name
}
