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

/**
 * Bumped on a managed `<style>` every time its rules are changed in place
 * (`insertRule` / `deleteRule`, SB-7 — `PortalFrameAdapter.applyOverlay`'s
 * `incremental` mode) instead of by rewriting its text.
 *
 * A text rewrite is a `childList` / `characterData` mutation under `<head>`,
 * and everything that has to know "the page's style changed" watches for that:
 * the frame-fit budget reset, the geometry dirty signal, hover suppression.
 * A CSSOM edit is invisible to a `MutationObserver`, so it announces itself
 * with this attribute instead, and those observers watch for it through
 * {@link STYLE_CHANGE_OBSERVER_OPTIONS}.
 */
export const OVERLAY_REVISION_ATTR = 'data-studio-overlay-rev'

/** What an observer on `<head>` passes to `observe()` to see EVERY change to a page stylesheet: a text rewrite or an in-place rule edit. */
export const STYLE_CHANGE_OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: [OVERLAY_REVISION_ATTR],
}
