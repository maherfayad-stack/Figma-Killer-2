/**
 * canvasCssLayers — the three named cascade layers shared between the canvas
 * iframe's reset, vendor and author CSS injectors, and the explicit ordering
 * declaration that pins their relative priority.
 *
 * The order, lowest priority first: **`reset` → `vendor` → `user-authored`.**
 *
 * Why this needs to be explicit
 * ──────────────────────────────
 * `ProjectCssInjector` (vendor package CSS, read-only) must render but LOSE
 * to `ClassStyleInjector`/`UserStylesheetInjector` (`user-authored`, the
 * editable class registry). The naive way to make vendor CSS "lose" —
 * injecting it UNLAYERED, the way the old `AlmDesignSystemCssInjector` did —
 * gets this backwards: unlayered CSS ALWAYS beats `@layer`d CSS regardless of
 * specificity, so an unlayered vendor stylesheet would beat
 * `@layer user-authored` even when the user has explicitly overridden a
 * class. The fix is to put vendor CSS in its OWN named layer, ordered BEFORE
 * `user-authored` — cascade-layer priority is lowest-declared-first,
 * highest-declared-last, so declaring `vendor` first makes it lose to
 * `user-authored` regardless of which selector is more specific.
 *
 * WHY THE RESET IS ITS OWN LAYER, BELOW `vendor`
 * ──────────────────────────────────────────────
 * `PUBLISHER_RESET_CSS` is written entirely in `:where(...)`, i.e. at zero
 * specificity, precisely so that *anything at all* overrides it. That
 * mechanism only works while the reset shares a layer with the rules it must
 * lose to — and it used to be emitted INSIDE `@layer user-authored`, one
 * layer ABOVE `vendor`. Layer order beats specificity outright, so the reset
 * silently annihilated the design system it was ordered above: `:where(*) {
 * margin: 0; padding: 0 }` beat `.btn { padding: 12px 24px }`,
 * `:where(button) { background: none; border: 0 }` beat the button's fill,
 * and `:where(input, button, …) { font: inherit; color: inherit }` beat its
 * type colour. Every `@alm-design`/`pkg.*` component on the board therefore
 * rendered as unstyled text — measured: a real `<Button>` computed to
 * `background: rgba(0,0,0,0)`, `padding: 0px`, `color: rgb(0,0,0)`, keeping
 * only the `border-radius` the reset happens not to mention.
 *
 * A reset is by definition the lowest-priority thing in the document, so it
 * gets the lowest layer. `:where()` still keeps it losing to everything
 * inside its own layer; the layer is what keeps it losing to vendor CSS.
 *
 * Layer order is established by the FIRST time any of the names is mentioned
 * ANYWHERE in the document (source order across every `<style>` tag) — not by
 * which injector's `useEffect` happens to run first. Every stylesheet that
 * opens one of these layer blocks therefore repeats `CANVAS_CSS_LAYER_ORDER`
 * first: a bare `@layer reset, vendor, user-authored;` pre-declaration.
 * Whichever `<style>` tag actually lands in the iframe's `<head>` first is the
 * one that fixes the order for the whole document, and that isn't guaranteed
 * to always be the same one (independent components, independent mount
 * effects) — so every side declares it, and only the first declaration
 * actually does anything.
 *
 * `EditorChromeInjector` stays unlayered and outranks all three buckets —
 * chrome must never be overridden by author OR vendor CSS.
 * `CanvasAnimationInjector` / `CanvasScrollUnrollInjector` stay unlayered +
 * `!important` — `!important` declarations always beat non-`!important` ones
 * regardless of layer, so the freeze/unroll rules keep winning against every
 * layer here.
 */

/**
 * The zero-specificity baseline (`PUBLISHER_RESET_CSS`) — `ClassStyleInjector`.
 * Lowest of the three: a reset must lose to vendor package CSS as well as to
 * the user's own rules. See this module's doc for the defect that proved it.
 */
export const RESET_LAYER = 'reset'

/** Read-only package CSS — `ProjectCssInjector`. Above `RESET_LAYER`, below `USER_AUTHORED_LAYER`. */
export const VENDOR_LAYER = 'vendor'

/** The editable class registry + user stylesheets — `ClassStyleInjector`, `UserStylesheetInjector`. */
export const USER_AUTHORED_LAYER = 'user-authored'

/**
 * A bare `@layer` pre-declaration pinning `reset` below `vendor` below
 * `user-authored` in the cascade, regardless of which stylesheet's rule body
 * is actually encountered first. See this module's doc for why every canvas
 * stylesheet repeats this exact statement.
 */
export const CANVAS_CSS_LAYER_ORDER = `@layer ${RESET_LAYER}, ${VENDOR_LAYER}, ${USER_AUTHORED_LAYER};`
