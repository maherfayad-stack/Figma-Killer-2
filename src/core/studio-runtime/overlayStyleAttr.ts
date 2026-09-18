/**
 * overlayStyleAttr — the ONE marker attribute every `applyOverlay`-managed
 * `<style>` element carries, shared by both `FrameDocumentAdapter`
 * implementations: `runtime.ts`'s own `applyOverlay` (the in-frame,
 * cross-origin bridge half) and `PortalFrameAdapter.applyOverlay`
 * (`src/admin/pages/site/canvas/frameAdapter/`, same-origin portal half). See
 * `STATE.md`'s `live-05` entry.
 *
 * Both adapters give a managed overlay's `<style>` element a PREFIXED
 * physical DOM `id` (to avoid colliding with any unrelated id already in the
 * document) and store the caller's real logical id — `mc-classes`,
 * `mc-vendor`, `studio-editor-chrome`, … — in this attribute instead. Any
 * consumer that needs to recognize "a style element `applyOverlay` created,
 * by its logical id" (e.g. `CanvasHoverSuppressionInjector`'s page-content
 * allowlist) MUST check this attribute, not the physical `id`.
 *
 * A standalone, zero-dependency module (not folded into `runtime.ts` or
 * `PortalFrameAdapter.ts`) so it can be imported from BOTH the in-frame
 * runtime bundle and the admin app without pulling either one's other
 * dependencies along — matching this directory's "shared, no admin/store
 * imports" module category (see `index.ts`'s own doc).
 */
export const OVERLAY_ID_ATTR = 'data-studio-overlay-id'
