/**
 * chunkLoadError — ERR-13: tell a lazy chunk that failed to load apart from an
 * ordinary render error, so `LazyChunkBoundary` says "Editor chunk failed to
 * load" only when that is true. Its own module so the boundary file exports
 * components only (Fast Refresh).
 */
import type { ErrorChainEntry } from '@ui/components/ErrorBoundary'

/**
 * The messages browsers and bundlers use for a lazy chunk that could not be
 * fetched or evaluated: Vite/Chromium ("Failed to fetch dynamically imported
 * module"), Safari ("Importing a module script failed"), Firefox ("error
 * loading dynamically imported module"), Vite's CSS preload, and webpack's
 * `ChunkLoadError`.
 */
const CHUNK_LOAD_MESSAGE =
  /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|unable to preload css|loading (css )?chunk [\w-]+ failed/i

/**
 * ERR-13 — whether a caught error is really a chunk that failed to load. Only
 * then is "Editor chunk failed to load" true; an ordinary render error that
 * reaches this boundary is something else, and says so.
 */
export function isChunkLoadError(chain: readonly ErrorChainEntry[]): boolean {
  return chain.some((entry) => entry.name === 'ChunkLoadError' || CHUNK_LOAD_MESSAGE.test(entry.message))
}
