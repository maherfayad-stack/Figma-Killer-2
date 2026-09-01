# Canvas internals

What you must know before touching the canvas. Full version:
[`docs/features/canvas-iframe-per-frame.md`](../features/canvas-iframe-per-frame.md).

---

## The rule that explains everything

**The canvas DOM must be the DOM React renders.**

No wrapper `<div>`s between authored elements. No scoping. No selector
rewriting. If you add a box, the user's CSS quietly means something different in
the editor than in their app — and the failure is *silent*, which is why this is
enforced by design rather than by a lint rule.

That is why:
- each frame is a real `<iframe>` with its own `<html><body>`,
- modules spread editor props (`data-node-id`, handlers) onto **their own root
  element**,
- the design-system host is `display: contents` (no box),
- inlined components **replace** their call site,
- `nodeVisualRect` exists — a box-less element measures as zeros, so selection
  falls back to the union of its children.

---

## Frame anatomy

```
IframeFrameSurface                       (the primitive)
  <iframe srcDoc="<!doctype html>…">
    head ← EditorChromeInjector          unlayered  — editor chrome only
    head ← ProjectCssInjector            @layer vendor — read-only package CSS (WS-2.3)
    head ← AuthoredCssInjector           @layer user-authored — project's own CSS, RAW (board-27)
    head ← ClassStyleInjector            @layer reset — publisher reset (LOWEST, CMS pages only)
                                         @layer user-authored — class registry OVERLAY
    head ← UserStylesheetInjector        @layer user-authored — user stylesheets
    head ← CanvasAnimationInjector       !important — design frames only
    head ← CanvasScrollUnrollInjector    !important — design frames only, toggleable
    body ← createPortal(<NodeRenderer/>)
    body ← RuntimeScriptInjector         only when "Run scripts" is on
```

**Cascade order matters and is deliberate.** Unlayered always beats `@layer`d
regardless of specificity, so user CSS can never override editor chrome.
The order is **`reset` → `vendor` → `user-authored`**, pinned by a bare
`@layer reset, vendor, user-authored;` pre-declaration every canvas injector
opens with.

`@layer vendor` (`ProjectCssInjector` — `@alm-design/design-system`'s bundled
CSS plus the open project's own bare-specifier package CSS, e.g. `import
'@acme/ui/dist/style.css'`) is deliberately ordered BELOW `@layer
user-authored` so the user's own edits win over a package default.

**`@layer reset` is below BOTH, and that is load-bearing.** The publisher reset
is written entirely in `:where(...)`, i.e. at zero specificity, precisely so
anything overrides it — but that only works while it shares a layer with the
rules it must lose to. It used to be bundled into `@layer user-authored`, one
layer above `vendor`, and layer order beats specificity outright: `:where(*) {
padding: 0 }` beat `.btn { padding: 12px 22px }`, so **every design-system
component on the board rendered as unstyled text**. A reset is the
lowest-priority thing in a document, so it gets the lowest layer. See
`src/admin/pages/site/canvas/canvasCssLayers.ts` and
`docs/features/canvas-iframe-per-frame.md`'s "Vendor vs. user-authored
ordering". Vendor CSS is read-only: never parsed into a `StyleRule`, never in
the editable class registry. The animation injector needs `!important`
because `!important` declarations always beat non-`!important` ones
regardless of layer — it has to beat both `@layer vendor` and `@layer
user-authored` selectors that are more specific than `*`.

**A Studio project's own CSS renders from TWO sources, deliberately not one
(`board-27`).** `server/handlers/studioCss.ts` parses every stylesheet
through happy-dom's CSSOM to build `site.styleRules` — and happy-dom silently
DROPS any declaration it cannot parse (`color-mix()`, `Canvas`/`CanvasText`
system colours, slash-alpha `rgb(0 0 0 / .2)` all measured). Rendering the
canvas exclusively from that registry meant the canvas quietly disagreed with
a real browser. `AuthoredCssInjector` fixes this by injecting the SAME
stylesheets' RAW text (`StudioStyles.authoredCss`) completely unparsed —
same pattern `UserStylesheetInjector` already used for CMS stylesheets, same
`@layer user-authored` bucket vendor CSS is exempt from entirely (it's
already raw, `mc-vendor`, which is the proof this works). `ClassStyleInjector`
still regenerates `mc-classes` from the registry, but only for rules that
NEED it — `canvasClassCss.ts`'s `styleRuleNeedsCanvasOverlay` keeps an
editor-authored rule (no `sc-` id prefix) or a session-edited imported rule
(`updatedAt > 0`) in the overlay, and lets everything else render from the
raw text alone. `AuthoredCssInjector` always `insertBefore(head.firstChild)`s
itself (like `ProjectCssInjector`), so `mc-authored` precedes `mc-classes` in
source order regardless of mount timing — inside one `@layer`, cascade
priority is source order, so a live session edit still wins over the raw,
on-disk snapshot for the same selector. Known gap: deleting an imported
`ambient` rule removes it from the registry but not from the raw snapshot
until the next reload — see `AuthoredCssInjector`'s own doc.

**The reset itself is CMS-only.** It's the right baseline for a CMS-authored
page (module engine, no stylesheet of its own) but wrong for a Studio-parsed
page — a real project's own `.tsx`, where "the repository is the document"
means the project's own CSS (or the genuine absence of one) is the whole
truth. A reset there makes an unstyled `<ul>`/heading/table/link look BETTER
than a real browser would render it, exactly in the "did I actually style
this" case someone is most likely checking. `ClassStyleInjector` never emits
the `@layer reset { … }` block's contents — Studio is the only editor mode,
so this is unconditional. See `docs/features/canvas-iframe-per-frame.md`'s
"The publisher reset is CMS-only".

**A design frame must be a still, whole screen — two injectors, both design-
frame-only, both `!isLive` in `IframeFrameSurface`, neither ever reaches the
publisher.** `CanvasAnimationInjector` freezes CSS animations (freeze-point
`'end'`/`'start'` — see its docblock), kills transitions and smooth scroll,
pauses `<video>`/`<audio>` (mount + `MutationObserver` for later inserts), and
patches `matchMedia` for `prefers-reduced-motion` (JS reads only — it cannot
retarget the browser's native CSS `@media` evaluation, and it cannot freeze
animated GIF/WebP/APNG, JS-driven animation, or `<canvas>`/WebGL — say so,
don't fake it). `CanvasScrollUnrollInjector` turns an app shell's internal
`overflow: auto` scroll regions into content-sized blocks: a blanket
stylesheet handles the common flex-region case, and a bounded (one settle per
`MutationObserver` batch, never per pointermove), tag-then-style JS pass
handles `position: fixed` chrome (→ `position: absolute`, tagged
`data-studio-unroll="fixed"`) and explicit clipping heights (→ `height: auto`
floored at the measured original, tagged
`data-studio-unroll="explicit-height"`) — but only when the element's own
AUTHORED `overflow-y` was something other than the CSS default `visible`
(`board-27f`): a fixed-size flex icon frame around an intrinsically larger,
un-scaled child (an SVG icon bigger than its box) reports a real, positive
`scrollHeight - clientHeight` deficit in an ordinary browser even though
nothing is clipped — `overflow-y: visible` never hid anything, so there is
nothing to "unroll." See `classifyUnrollElement` in `canvasScrollUnroll.ts`
for the exact gate. It **never writes `body`'s or
`html`'s `height`** — see "Height, and the feedback loop" below for why that
specific boundary is load-bearing.

`EditorChromeInjector` uses stable `data-*` selectors, never hashed CSS Module
class names (those only exist in the parent document). It forwards admin tokens
as **chrome-namespaced** aliases (`--chrome-font-sans`, `--chrome-text-*`,
`--chrome-space-*`) so it can't clobber the site's own tokens.

---

## Interaction modes

| | design (`interaction='canvas'`) | live (`interaction='live'`) |
|---|---|---|
| Height | grows to content | 100% |
| Scroll | none (canvas pans) | native |
| Wheel | forwarded to parent pan/zoom | not forwarded |
| Pointer | forwarded for space-pan / drags | not forwarded |
| Keyboard | cloned onto parent `document`; `Tab` blocked | not forwarded |
| Chrome CSS | applied | not applied |

Both modes are **fully editable**. Neither is a read-only preview.

---

## Preview axes (WS-10) — direction, dark mode, and locale

The board previews a project along a `PreviewAxes` triple
(`src/core/studio-board/previewAxes.ts`): `direction` (`'ltr'|'rtl'`),
`colorScheme` (`'light'|'dark'`), and `locale` (a project's own dictionary
key). `direction`/`colorScheme` are **render-time**: no re-parse, no frame
remount. `locale` is genuinely different — it is **parse-time** (see
"Locale (WS-10 §4.2/Phase 3)" below) — the one axis that changes *which
nodes exist*, not just an attribute on them.

**Applied via an attribute effect, never `srcDoc`/a React `key`.**
`IframeFrameSurface.tsx` reads `previewAxes` from the store and the
project's `ColorSchemeCapability` probe result from an external store
(`previewAxesCapability.ts`), and a plain `useEffect` calls
`applyPreviewAxesToFrameDocument` (`previewAxesFrameEffect.ts`) on the
ALREADY-MOUNTED `iframeDoc.documentElement`:
- `dir` — the load-bearing mechanism. Trap #1 applies: no wrapper `<div
  dir="rtl">`, the attribute lands on the document element the frame already
  has.
- `lang` — `'ar'` when `rtl` (Phase 1 has no real per-project locale to
  reach for yet — see `previewAxesFrameEffect.ts`'s doc), cleared on `ltr`.
- `data-studio-scheme` + inline `color-scheme` — always set, regardless of
  the project's detected mechanism. This is the attribute
  `darkSchemeCssTransform.ts`'s rewritten CSS matches against.
- `data-theme` (`VENDOR_THEME_ATTR`) — always set, to `light` or `dark`,
  **never removed**. This is the convention design systems shipped as vendor
  CSS gate on, and absence is NOT neutral: `@alm-design/design-system`, which
  `ProjectCssInjector.tsx` injects into every frame, declares its light tokens
  under `:root:not([data-theme=light])`, so an unset attribute reads as DARK.
  Removing the attribute for "light" previewed light as dark — the same
  broken-in-both-directions shape as the `prefers-color-scheme` bug below.
  (`ProjectCssInjector` used to pin `data-theme="light"` itself, from before
  the board had a dark-mode control; that second writer is gone —
  `previewAxesFrameEffect.ts` owns every root attribute the axes drive.)
- When the probe detected a `'class'`-mechanism project (a `.dark` class or
  `[data-theme="dark"]` attribute), that EXACT selector is also toggled —
  the project's own gate, so its styles respond as they would in the real
  app. A class comes off for light; an ATTRIBUTE is set to `light`, for the
  reason above.

**The frame's PAPER follows the preview, not the admin theme.** An iframe
document that paints no background of its own is transparent, so the embedding
element is what shows through — and a grow-to-content frame leaves a lot of it
uncovered below a short page. `.iframe`/`.viewport` used a fixed `--overlay`
there, which painted every dark-mode preview on white paper: dark content on
top, a white band under it. They now read `--canvas-frame-paper` /
`--canvas-frame-paper-dark`, selected by `data-preview-scheme` on the element
(from the frame's own effective axes — `useResolvedFrameAxes` for
`BreakpointFrame`'s wrapper, which sits outside the portal and cannot read the
context). Those two tokens are deliberately THEME-INDEPENDENT: they stand for
the previewed page's own canvas, not for admin chrome. Verified in Chromium,
not reasoned about.

**`dir` reaches CSS, and only CSS.** A design system whose components resolve
their own direction in JavaScript — ALM's every component calls `useDir(prop)`,
which reads `DesignSystemProvider`'s context and falls back to a built-in
`'ltr'` — cannot see `html[dir]` at all. So the frame also publishes its
effective axes on `FramePreviewAxesContext` (`previewAxesFrameEffect.ts`,
provided by `CanvasFrameContexts.tsx`), and both module-registration paths
(`src/modules/alm/register.tsx`, `studio/registerProjectModules.ts`) pass
`dir` into the package's provider. Before that, both wrapped every component
in the provider with NO props, pinning the JS half of every design-system
component to LTR while its CSS half flipped — half-mirrored RTL screens.
Regression test: `designSystemPreviewDirection.test.tsx`.

Why this matters: wiring either axis through `srcDoc` or a `key` would
remount the frame on every toggle — ~100-140ms per frame (`perf-01`'s
budget) — which a board-wide toggle across every frame cannot pay.
`previewAxesFrameAttributes.test.tsx` asserts the SAME iframe element and
the SAME `contentDocument` survive a toggle.

### Dark mode's two real mechanisms, and the CSS-rewrite one

`prefers-color-scheme` is a real user-preference media feature — it cannot
be forced per-iframe from CSS, in EITHER direction (a light preview on a
dark-OS host would still show dark; a dark preview on a light-OS host would
never activate). So for a `'media'`-mechanism project,
`darkSchemeCssTransform.ts` rewrites `@media (prefers-color-scheme:
dark|light)` into `:where(html[data-studio-scheme='dark|light']) { ... }`
on the INJECTED COPY only (never the file on disk), applied inside
`UserStylesheetInjector.tsx`/`ProjectCssInjector.tsx` before the CSS lands
in the iframe. `:where()` keeps the rewrite specificity-neutral — CSS
nesting gives each inner rule an implicit `:where(...) <selector>`
descendant combinator, matching exactly the same elements the original
(unscoped, inside the media query) selector matched.

**Landmine:** do not round-trip a WHOLE stylesheet through the CSSOM to do
this rewrite. happy-dom's CSS parser does not support `@layer` at all and
silently DROPS every rule inside one — a real hazard for a Tailwind v4
project, which wraps its entire generated CSS in
`@layer theme, base, components, utilities;`. The transform instead uses a
brace/comment/string-aware scanner to find candidate `@media` spans in the
RAW text (so nested at-rules and `@layer` wrappers are never touched), and
validates each candidate in ISOLATION (`@media <prelude> {}`, never the
whole file) through the CSSOM before splicing it in.

### Per-frame axes + `(frameId, nodeId)` (WS-10 Phase 2)

A `BoardFrame` can carry its OWN `axes?: Partial<PreviewAxes>` (`direction`/
`colorScheme` only — see "Locale" below for why `locale` is excluded here),
overriding the board default PER AXIS via `IframeFrameSurface.tsx`'s
`axesOverride` prop → `useApplyPreviewAxes`'s merge. "Duplicate as variant"
(`BoardFramesLayer.tsx`'s context menu) creates a second `BoardFrame` of the
SAME page, its own `id`, positioned beside the source — so an RTL and an LTR
(or light/dark) copy of one screen sit side by side.

**Two frames of one page share every node id** (trap #2 — an id is a source
location AND the one legitimate write target; the two variants parse from
the same file). Before this phase, `selectedNodeId`/`hoveredNodeId` had no
notion of WHICH frame produced a click, so selecting a node in one variant
rang its twin too. Fixed by adding an orthogonal `(frameId, nodeId)`
dimension, not by touching the id grammar:

- `CanvasFrameContext` (`canvas/CanvasContexts.ts`) — ambient per-frame
  identity for `NodeRenderer`, mirroring `CanvasBreakpointContext`. Set by
  `BoardFramesLayer.tsx` around each `<BreakpointFrame frameId={frame.id}>`.
  (The three contexts a MOUNTED frame publishes — its `<iframe>`, its
  `Document`, and its effective `PreviewAxes` — are provided together by
  `CanvasFrameContexts.tsx`, not inline in `IframeFrameSurface`.)
- `selectedNodeFrameId`/`hoveredFrameId` (`selectionSlice.ts`) — the frame a
  selection/hover currently belongs to. `null` means "board-wide" (used
  outside Studio board mode, where frame identity doesn't exist).
- `BreakpointSelectionOverlay.tsx` reads `selectedNodeIds`/`hoveredNodeId`
  scoped to ITS `frameId` — a node selected in a different frame renders as
  if nothing were selected in this one, even though the DOM element with
  that same `data-node-id` exists here too.

This is the general mechanism, not a direction/scheme special case — Phase 4
(locale) extends it rather than replacing it (see below). See `STATE.md`'s
`canvas-08` handoff for the "does selection leak between variants" proof
(`boardFrameVariantSelection.test.tsx`) and the full file list.

**Closed in Phase 4:** inline text-edit sessions (`activeInlineEdit`) are now
ALSO keyed by `frameId`, not just `(nodeId, breakpointId)` — every board
frame shares one synthetic breakpoint id (`'studio'`), so without this a
"duplicate as variant" sibling would show the SAME contentEditable session
live in both frames. `inlineEditSlice.ts`'s `ActiveInlineEdit.frameId` is the
fix; see the Locale section below for why this session also needed a SECOND,
new field (`localeOverride`) once a session can belong to a frame reading a
different tree entirely.

### Locale (WS-10 §4.2/Phase 3 + §4.4/Phase 4 — both shipped)

`locale` selects `preferredKey`, which Tier B.4 uses to pick a dictionary
BRANCH during evaluation (`staticEvalCore.ts:440`'s `evaluateElementAccess`)
— a different PARSE, producing different nodes and different `textOrigin`s.
This is why it cannot be an attribute effect like the other two axes.

**Phase 3 (board-global):** `server/handlers/studio/localeProbe.ts` detects a
project's own locale dictionary (purely syntactic — see that module's doc
for the three detection rules); `PreviewAxesControls.tsx`'s locale `Select`
is populated from it (no more hand-typed JSON key). Choosing one calls
`savePreviewAxes(dir, { locale })` (persists to `.studio/meta.json`'s
`previewAxes.locale`) then `requestCmsSiteReload()` — a REAL re-parse of the
whole project. `studioPageLoad.ts`'s `configHash` already includes
`preferredKey`, so this correctly busts the on-disk parse cache, and
switching back to a previously-used locale is cache-free. The `Select`
disables itself for the duration (`isReparsing`) so a second click can't
queue a second reload mid-flight.

**Phase 4 (per-frame locale variants, side-by-side):** unlike
`direction`/`colorScheme`, a frame's own `locale` needs a DIFFERENT parsed
tree, not just an attribute. The Phase 2 `(frameId, nodeId)` re-keying
answers "which frame does this selection/hover belong to" for a SHARED
tree — it does NOT answer "which tree does this frame render." `site.pages`
(`src/core/page-tree/siteDocument.ts`) is untouched — still `Page[]`, one
entry per `pageId`, load-bearing for the publisher and the CMS half of this
fork. The Phase 4 answer is a PARALLEL map, not a reshape:

- `server/handlers/studioPageLoad.ts`'s `loadStudioPageInLocale(dir, pageId,
  locale)` — parses ONE route under an explicit `preferredKey` override
  (reusing `parseStandardRouteEntry`/`parseAppRouterRouteEntry`, the same
  logic every route already runs), never the whole project. New route:
  `GET /admin/api/studio/localized-page` (`server/handlers/studio/
  localizedPage.ts`).
- `src/admin/pages/site/store/slices/localizedPageSlice.ts` — the client-side
  half of the map: `localizedPages: Record<'${pageId}::${locale}', Page>`,
  fetched on demand (`ensureLocalizedPage`, called from `BoardFramesLayer.tsx`
  when a frame's `axes.locale` differs from the board default), never for a
  frame whose locale didn't change.
- `selectCanvasPageFor(s, pageId, frameId)` (`store.ts`) — the ONE function
  every node-data read in `NodeRenderer` already goes through. Its `frameId`
  param (added for this) looks up the frame's `axes.locale`; when it differs
  from the board default, reads `localizedPages` instead of `site.pages`,
  falling back to the default tree while the fetch is in flight (never
  blank). This is the WHOLE render-side mechanism — no other call site
  changed, and a frame whose locale didn't change never re-renders from this
  at all (no fetch, same iframe, no remount).
- `inlineEditSlice.ts`'s `ActiveInlineEdit` gained `localeOverride:
  {pageId, locale} | null`, resolved once at `startInlineEdit` time. A
  session with a `localeOverride` mutates `localizedPageSlice.ts`'s tree via
  `updateLocalizedNodeText` — a genuinely separate, undo-EXEMPT mutation
  (never `updateNodeProps`/`mutateActiveTree`, which would silently edit the
  WRONG tree since both share the node id — trap #2). This is what makes
  editing text in the Arabic frame write to the `ar` branch's own
  `textOrigin`, not the `en` one's — proven at the unit level in
  `server/handlers/__tests__/localizedPage.test.ts` (two locale parses of one
  page: SAME node id, DIFFERENT `textOrigin`) and
  `src/__tests__/editor-store/inlineEditSlice.test.ts` (the session routes to
  `localizedPages`, never `site.pages`).

The node id grammar itself does NOT change — trap #2 holds precisely the
same way it does for the render-time axes; only the RENDER SOURCE per frame,
and (for text) the WRITE target, are new.

**Locale-variant text edits are now SAVED to disk.**
`src/admin/pages/site/studio/localizedPageWriteback.ts` is the save-path
module (mirroring `styleRuleWriteback.ts`'s "one module per edit kind"
precedent): a baseline keyed `(pageId, locale, nodeId)` — NOT folded into
`fsCodemodAdapter.ts`'s own `loadedValues` (keyed by bare `nodeId`, which a
locale-variant node SHARES with the default tree's node — trap #2 again;
sharing a baseline would let one locale's diff silently win over the
other's). `watchLocalizedPagesForBaseline()` (called once from `loadSite()`,
idempotent) subscribes to the store and seeds a `(pageId, locale)` key's
baseline the INSTANT it is first fetched — before a user could possibly
have edited it, since the canvas can't render a node to double-click until
the fetch that supplies it has already landed. `fsCodemodAdapter.ts`'s
`saveSite` calls `collectLocalizedTextEdits`/`commitLocalizedTextBaseline`
alongside the existing CSS write-back call, emitting `kind: 'literal'`
edits aimed at each node's OWN `textOrigin` — the same edit shape and the
same server-side codemod (`applyStudioEdit`) the default tree's
`textOrigin`-backed edits already use, so no server change was needed.
Proven end to end (real `fsCodemodAdapter.saveSite()`, not just the
isolated collector) in
`src/admin/pages/site/studio/__tests__/localizedPageWriteback.test.ts`:
editing the SAME node id in the `en` default tree and the `ar` variant tree
in one session produces TWO `kind: 'literal'` edits with TWO DIFFERENT
`nodeId` strings (each `${rel}:${line}:${col}`), never one write colliding
with the other.

`undo()` does NOT cover a locale-variant text edit — `inlineEditSlice.ts`'s
locale-variant session path never calls `updateNodeProps`/`mutateActiveTree`,
so Mutative's patch history never sees it (same "not in the undo stack"
precedent `boardSlice.ts`'s frame drags already set). Stated explicitly
rather than half-wired — see `localizedPageWriteback.ts`'s own doc.

**Known, deliberate scope boundaries (not gaps by accident):**
- **Non-text prop/style edits (Properties panel) are NOT locale-variant-aware
  — a real, named silent-wrong-target RISK, not just an omission.** Selecting
  a node for the panel resolves through the board-DEFAULT tree regardless of
  which frame you clicked in (`selectSelectedNode`/`selectActiveCanvasPage`,
  unchanged) — a user who selects a node inside the Arabic frame and edits
  its colour in the panel is silently editing the ENGLISH frame's copy of
  that node (both frames share `classIds`, so the change is visible in
  BOTH frames, not just the one the user thought they were editing). NOT
  mitigated in the UI this task — a live "you're editing the default frame's
  copy" badge in the panel needs `selectedNodeFrameId` (`selectionSlice.ts`,
  already tracked) threaded into `PropertiesPanelBody.tsx`, which is a real
  UI change, not a doc fix, and was judged not cheap enough to add
  opportunistically alongside the save-path work. Disclosed instead in
  `docs/features/studio-import.md`'s limitations table — the user-facing
  doc, not only this internal one. Flagged as the follow-up worth doing
  before this feature ships to real users, not merely a note for the next
  agent.
- A `.map()` array whose LENGTH differs by locale (not just its items' text)
  would give the locale variant a different expanded-node count than the
  default tree for that subtree — not observed on the real eSIM corpus,
  flagged rather than assumed away (see `loadStudioPageInLocale`'s own doc).

## Height, and the feedback loop

Design frames grow to content. `vh`/`vmin`/`vmax` size against the iframe
element's height → writing a new height feeds the unit → content grows → observer
fires again.

Guards, all in `useIframeFrameAutoHeight.ts` / `IframeFrameSurface.tsx`:
- measure inside `requestAnimationFrame`,
- cap consecutive self-driven resizes at 60, reset on a foreign DOM mutation,
- ignore `documentElement.scrollHeight` when it only reports the stale viewport
  floor (so a shorter page can shrink),
- `html`/`body` forced to `height: auto` with a `min-height` of
  `CANVAS_VIEWPORT_HEIGHT` (800px) — **not** `100vh`, which would reintroduce
  the loop.

**And the opposite need:** an imported app shell is `html,body,#root{height:100%}`
with a `flex:1` scroll region. A percentage height only resolves against a
**definite** parent. So the frame *pins* `body.style.height` to the measured
frame height (floored at 800), and **unpins to `auto` before each measurement**
so a shrinking page can still shrink.

If you touch height logic, you must not break either direction. Test both.

**`CanvasScrollUnrollInjector` shares this boundary and must never cross it.**
Unrolling makes content taller, so the frame has to grow — the existing
unpin-before-measure logic already handles that direction, and the unroll
injector composes with it by only ever growing content *inside* body (never
touching `body`/`html`'s own `height`), which makes `body.scrollHeight` report
the larger number the auto-height hook already watches. An earlier draft of
the unroll stylesheet forced `body, html { height: auto !important }` —
`!important` beats a plain inline style regardless of origin, so that would
have overridden the pin outright and collapsed every `height: 100%` chain.
Regression coverage: `src/__tests__/canvas/canvasScrollUnrollPinInteraction.test.tsx`.

### A board frame hugs its content until the author sets a height

`.frameBody` has two states, chosen by `hasManualHeight`
(`BoardFrame.height !== undefined`):

- **hugging** (`data-frame-auto-height`) — `height: auto`, floored by
  `min-height: --frame-h` so a frame whose iframe has not measured yet does not
  flash to near-zero. This is the default and the state a new frame is in.
- **fixed** — the configured device box, `overflow: hidden`.

**`overflow` is `hidden`, never `auto`.** A frame is an artboard, and an
artboard clips. A scrollbar inside a frame on an infinite canvas is a second,
nested scroll surface competing with the canvas's own pan — you cannot tell
which one a wheel gesture will move — and the bar itself is browser chrome
painted over the design under review.

Three rules keep the two states honest:

1. **Only a handle that moves a horizontal edge (`n`/`s`/a corner) sets a
   height.** Dragging `e`/`w` used to commit the *resolved fallback* height as
   though the author had chosen it, silently ending hug-to-content on a frame
   the author had only made wider. `changesHeight` in `BoardFrameView` gates
   this.
2. **A vertical drag on a hugging frame anchors on the MEASURED box**, not on
   the `height` prop — that prop is the fallback default, not what is on
   screen, so anchoring on it snapped the frame to the default the instant the
   pointer moved.
3. **`resizeFrame(board, id, width, undefined)` deletes the stored height**,
   returning the frame to hugging. It is deleted, not set to `undefined`:
   `boards.json` is JSON, and a stored `null` would not round-trip as absent.

The author gets back to hugging by double-clicking the frame's bottom (`s`)
resize handle, or via **Fit height to content** in the frame's context menu —
which is the discoverable and keyboard-reachable path, since the handles live
in an `aria-hidden` container.

---

## Dragging something onto the canvas

One gesture, three callers: the notch's element primitives, the module inserter
dialog, and the media explorer. They share `useCanvasInsertionDrag`
(`canvas/useCanvasInsertionDrag.ts`) — each used to carry its own copy of the
same ~60 lines, and the copies had already drifted.

The seam is deliberate: **the hook owns the gesture and the geometry, the
caller owns what gets inserted.** That is the only part that genuinely
differs — the dialog drops modules, saved layouts and Visual Components through
its own dispatch; the other two drop one known module — and folding it in would
have meant a union type every caller then re-narrowed. The caller supplies
`onDrop(ghost, location)` and returns whether anything landed; a `true` promotes
the dropped-on frame to the active breakpoint.

**Pointer events, not HTML5 drag-and-drop.** The drop target is inside an
`<iframe>`: a native `dragover` never reaches the parent document from a
cross-document child, and the drag image cannot be painted outside the source
document either. `markCanvasPointerRelay` tells the iframe layer to forward the
pointer stream back up, which is what makes a drop *into* a frame observable at
all. See "Events across the iframe boundary" below.

The preview rect and its label come from `resolveCanvasPointerInsertionDrop` —
the same resolver a click-to-insert goes through, so "where the ghost says it
will land" and "where it lands" are one computation rather than two that agree
by luck.

Two traps worth keeping:

- **Resolve the drop BEFORE tearing down.** The relay has to still be armed for
  the release point to hit-test against a frame's iframe.
- **Suppress the click that ends a drag.** The same pointerup fires a click on
  the button the drag started from, which would insert a second copy at the
  default location. `shouldSuppressClick()` covers exactly one tick.

`CanvasInsertionDragOverlay` draws the shared preview (a rect, or a 2px line for
a before/after drop) and a cursor-following ghost, portaled to `document.body`
so it can paint over an iframe. Its ghost takes children: the notch shows a
label, the media explorer keeps its own thumbnail card.

---

## Events across the iframe boundary

React synthetic events bubble through the **fiber** tree, so React handlers work
normally. **Native** listeners on the parent `window`/`document` never see iframe
events. Four cases are bridged explicitly:

1. **Wheel** — re-dispatched on the iframe element so pan/zoom works.
2. **Pointer** — forwarded during space-pan and active reorder drags.
3. **Keyboard** — a cloned `keydown` is dispatched on the **parent `document`**
   (not the iframe element — that would double-fire the canvas-root handler that
   already gets it via fiber bubbling). `Tab` is blocked, never forwarded.
4. **Overlay dismiss** — `ContextMenu` attaches dismiss listeners to every
   same-origin document via `collectSameOriginDocuments`. Cross-realm
   `instanceof Node` fails, so use `isNode` (`src/ui/lib/sameOriginDocuments.ts`).

**A canvas shortcut that must work from anywhere cannot be a React `onKeyDown`.**
`useCanvasKeyboardShortcuts` is a React handler on the canvas div, so it only
fires while a canvas descendant holds DOM focus — and selecting a node
auto-opens the Properties panel, so one click into it takes focus out of the
canvas for the rest of the session. Two shortcut families are therefore
document-level and scoped by *intent* instead: `board.selectAllFrames`
(`CanvasRoot.tsx`, `board-02`) and the whole Enter/Escape selection ladder
(`useCanvasSelectionKeyboard.ts`, `select-01`) — step into an instance, step
out of one, clear the node + frame selection, leave VC mode. Adding a shortcut
that a user would expect to work "wherever I am" belongs there, not in the
React handler.

**During an inline edit both keyboard paths must stand down.**
`useCanvasKeyboardShortcuts` bails on `activeInlineEdit`, and
`IframeFrameSurface.onKeyDown` returns early without forwarding — otherwise
Cmd+Z runs the store `undo()` while the contentEditable DOM keeps the text, and
store and DOM diverge.

---

## Inline text editing

The **element itself** becomes the editor — `contentEditable="plaintext-only"`,
no overlay, no mirrored typography.

Critical: **React must not own the content.** React 19 re-applies
`dangerouslySetInnerHTML` on *every* commit, and live-commit fires one commit per
keystroke — so a React-owned content prop overwrites typing and collapses the
caret. The canvas seeds content **imperatively once** via
`seedInlineEditableContent`, and React leaves that DOM alone for the session.

Module contract: `ModuleDefinition.inlineTextEdit?: { prop, multiline? }`.
Declared by `base.text`, `base.button`, `base.link`. Values store `\n`, render
`<br>` on both the canvas and publish paths.

---

## Selection and geometry

- `canvasDomGeometry.ts` — cross-iframe measurement, `nodeVisualRect`
  (child-union fallback for box-less nodes), `panToCenterBreakpointFrame`.
- `canvasSelectionOverlayPositioning.ts` — places rings/toolbar/inspector.
  Keeps an `appliedOverlayPlacements` WeakMap so the write phase no-ops when
  nothing moved (same-value style writes are not free).
- Overlay chrome currently lives in the **parent document**, positioned from
  measurements of elements inside a **transformed iframe**. Its position is
  `elementRect × zoom + iframeOffset + panOffset` — so any stale term shows as
  displacement, multiplied by zoom. **This is the known "menu far from the
  element" defect**; WS-5.1 of the V2 plan moves rings inside the iframe.

---

## Perf — the known hot spots

| Cost | Where | Fix (V2 WS-5) |
|---|---|---|
| O(pages × nodes) scan in a store selector, runs on **every** store change | `PropertiesPanelBody.tsx` (`sharedTextOriginCount`), `InPlaceInspector.tsx` (`findNodeById`) | precomputed indexes in the site slice |
| Overlay coordinate conversion across zoom | `canvasSelectionOverlayPositioning.ts` | render rings inside the iframe |
| Frames mount all iframes once the doc is in the store | `CanvasTransformLayer.tsx` | virtualize iframe mounting; frozen poster for offscreen frames |
| React re-render per pointermove during pan | `useCanvas.ts` | write `transform` to a ref, commit on pointerup |

`frameVirtualization.ts` already exists and is used by `BoardFramesLayer`:
`isFrameOnScreen(frameRect, viewportState, marginPx)` — pure board→screen math,
one extra screen of margin so panning doesn't pop frames. **Its own board→screen
formula deliberately omits `CanvasTransformLayer`'s 80px `top`/`left` offset**
(harmless there — a 600px culling margin absorbs it) — do not copy it for
anything that needs to be pixel-exact (a ruler tick, a measurement HUD); see
`CanvasRulers/rulerGeometry.ts` for the corrected formula and why.

**Never** add a full-site scan inside a `useEditorStore(selector)` callback.

`useCanvas()` returns `transformRef: RefObject<CanvasTransform>` — the LIVE
transform, mutated in place every rAF tick during a gesture, up to 100ms
AHEAD of the store's own debounced `zoom`/`panX`/`panY`. This is a published,
shared contract (`CanvasViewportActionsContext` carries it too, for consumers
that aren't direct children of `CanvasRoot`): anything that must track
pan/zoom live — `CanvasRulers`, D2's drag/drop, a future measurement HUD —
reads this ref, never the store selector, during an active gesture. See
`docs/features/canvas-rulers-and-guides.md`.

---

## Testing the canvas

- Canvas DOM is inside iframes: `document.querySelector('[data-node-id]')`
  returns `null`. Use `src/admin/pages/site/canvas/__tests__/iframeCanvasQuery.ts`.
- `src/__tests__/setup.ts` patches `HTMLIFrameElement.prototype.contentDocument`
  so iframe realms get the parent's built-ins. Test-env only.
- happy-dom needs `GlobalWindow` (not `Window`) for CSS parsing — only
  `GlobalWindow` puts JS built-ins on the window object.

---

## Agent screenshots

`AgentSnapshotFrame` renders one offscreen frame at a configured width through
the same iframe/injector/tree path as the editor, waits on a revisioned
readiness tracker (preview rows, loop data, media, fonts, React settling, image
embedding), captures, and unmounts. It never changes the visible canvas state,
never runs authored runtime scripts, and sits **offscreen** rather than
`display:none` so it has real layout geometry.
