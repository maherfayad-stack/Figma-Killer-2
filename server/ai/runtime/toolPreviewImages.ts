/**
 * The images a SERVER-run tool returned (a headless `studio_screenshot`),
 * forwarded to the panel on the `toolResult` event so it can show what the
 * agent looked at — and the variants card its thumbnails (AI-28).
 *
 * A browser-bridged tool's images never need this: the browser produced them
 * and already holds them (`streamEvents.ts` stashes them on the tool row). A
 * server tool's images existed only on the server, so the panel showed a
 * screenshot tool with nothing under it.
 *
 * Bounded, because the wire is NDJSON to a browser tab: at most
 * {@link MAX_WIRE_PREVIEW_IMAGES} per result, and an image whose base64 is
 * over {@link MAX_WIRE_PREVIEW_IMAGE_CHARS} is left out rather than sent. They
 * are display-only and session-only — never persisted (the persister keeps
 * `ok`/`error` alone), so a reloaded conversation shows no thumbnails, which
 * is the same rule every tool image already follows.
 */
import type { AiToolImage } from '@core/ai'

export const MAX_WIRE_PREVIEW_IMAGES = 4
/** ~1.8 MB of PNG — a full-page capture at 1× fits, a 2× capture of a very long page does not. */
export const MAX_WIRE_PREVIEW_IMAGE_CHARS = 2_500_000

/** Raster types an `<img>` shows as-is — the panel's schema accepts exactly these. */
const WIRE_IMAGE_TYPE_RE = /^image\/(png|jpeg|webp|gif)$/

export function wirePreviewImages(images: readonly AiToolImage[] | undefined): { previewImages?: AiToolImage[] } {
  const kept = (images ?? [])
    .filter((image) => WIRE_IMAGE_TYPE_RE.test(image.mimeType) && image.data.length <= MAX_WIRE_PREVIEW_IMAGE_CHARS)
    .slice(0, MAX_WIRE_PREVIEW_IMAGES)
    .map((image) => ({ mimeType: image.mimeType, data: image.data }))
  return kept.length > 0 ? { previewImages: kept } : {}
}
