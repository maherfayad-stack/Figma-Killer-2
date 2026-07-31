/**
 * canvasCssLayers — the two named cascade layers shared between the canvas
 * iframe's vendor and author CSS injectors, and the explicit ordering
 * declaration that pins their relative priority.
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
 * Layer order is established by the FIRST time either name is mentioned
 * ANYWHERE in the document (source order across every `<style>` tag) — not by
 * which injector's `useEffect` happens to run first. Every stylesheet that
 * opens a `@layer vendor {…}` or `@layer user-authored {…}` block therefore
 * repeats `CANVAS_CSS_LAYER_ORDER` first: a bare `@layer vendor,
 * user-authored;` pre-declaration. Whichever `<style>` tag actually lands in
 * the iframe's `<head>` first is the one that fixes the order for the whole
 * document, and that isn't guaranteed to always be the same one (independent
 * components, independent mount effects) — so every side declares it, and
 * only the first declaration actually does anything.
 *
 * `EditorChromeInjector` stays unlayered and outranks both buckets — chrome
 * must never be overridden by author OR vendor CSS. `CanvasAnimationInjector`
 * / `CanvasScrollUnrollInjector` stay unlayered + `!important` — `!important`
 * declarations always beat non-`!important` ones regardless of layer, so the
 * freeze/unroll rules keep winning against vendor AND user-authored CSS.
 */

/** Read-only package CSS — `ProjectCssInjector`. Lower priority than `USER_AUTHORED_LAYER`. */
export const VENDOR_LAYER = 'vendor'

/** The editable class registry + user stylesheets — `ClassStyleInjector`, `UserStylesheetInjector`. */
export const USER_AUTHORED_LAYER = 'user-authored'

/**
 * A bare `@layer` pre-declaration pinning `vendor` below `user-authored` in
 * the cascade, regardless of which stylesheet's rule body is actually
 * encountered first. See this module's doc for why every vendor/user-authored
 * stylesheet repeats this exact statement.
 */
export const CANVAS_CSS_LAYER_ORDER = `@layer ${VENDOR_LAYER}, ${USER_AUTHORED_LAYER};`
