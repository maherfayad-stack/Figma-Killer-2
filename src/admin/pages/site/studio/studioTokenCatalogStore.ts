/**
 * studioTokenCatalogStore - the editor's in-memory copy of the open project's
 * token catalog, as a tiny external store (CT-1/CT-3). Split from the fetch and
 * write code in `studioTokenCatalog.ts` so a leaf that only READS the catalog -
 * the frame adapters deciding which mode gates to write on a frame's root - can
 * subscribe without importing the board re-sync (and with it the editor store).
 */
import type { TokenCatalog, TokenUsage } from '@core/studio-tokens'

/** What the editor knows about the project's tokens: the catalog, and (once the Variables panel asked) where each is read. */
export interface StudioTokenState {
  readonly catalog: TokenCatalog | null
  readonly usage: ReadonlyMap<string, TokenUsage> | null
}

let state: StudioTokenState = { catalog: null, usage: null }
const listeners = new Set<() => void>()

export function getStudioTokenCatalog(): TokenCatalog | null {
  return state.catalog
}

export function getStudioTokenState(): StudioTokenState {
  return state
}

export function subscribeStudioTokenCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishStudioTokenState(next: StudioTokenState): void {
  state = next
  for (const listener of listeners) listener()
}

