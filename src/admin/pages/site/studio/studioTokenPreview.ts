/**
 * studioTokenPreview - the one token value being previewed on the board while
 * the Variables panel is typed into (CT-3).
 *
 * A tiny external store, like `studioTokenCatalog.ts`: every frame's
 * `TokenPreviewInjector` subscribes to it, and the panel writes it on each
 * keystroke without touching the editor store (whose changes would re-render
 * the whole board). It holds ONE preview: the value of one declaration under
 * one gate. Nothing here is persisted or written to source; clearing it (blur,
 * Escape, after the commit lands) removes the overlay and the canvas shows
 * what is on disk again.
 */
import type { TokenPreview } from '../canvas/tokenPreviewCss'

let current: TokenPreview | null = null
const listeners = new Set<() => void>()

export function getStudioTokenPreview(): TokenPreview | null {
  return current
}

export function subscribeStudioTokenPreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Show `preview` on every frame, or clear it with `null`. */
export function setStudioTokenPreview(preview: TokenPreview | null): void {
  if (current === preview) return
  current = preview
  for (const listener of listeners) listener()
}
