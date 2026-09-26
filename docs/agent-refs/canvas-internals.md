# Canvas internals
> **Purpose:** how the canvas works: iframes, injectors, overlays, geometry, events, bridge frames, perf · **Read when:** touching the canvas, a frame, an overlay or pointer handling · **Trust:** current · **Owner:** canvas-engineer · **Verified:** not yet

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

`@layer vendor` (`ProjectCssInjector` — the built-in design system's bundled
CSS, from Studio's own `vendor/alm-design-system/dist/`, plus the open
project's own bare-specifier package CSS, e.g. `import
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
nothing to "unroll." See `classifyUnrollElement` in `@core/studio-runtime`'s `scrollUnrollRules.ts`
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
| Keyboard | keydown cloned onto parent `document` (`Tab` cancelled in the frame, then forwarded); keyup ends holds | not forwarded |
| Chrome CSS | applied | not applied |
| Authored form controls | suppressed (a press selects the node) | left alone (focus, type, pick) |
| The component's own `onClick` | swallowed — the canvas owns the click | runs, alongside the canvas's own activation |
| The page's own `:hover` | rewritten so it cannot match | real |
| Scrollbars | n/a (frames grow to content) | hidden inside a device mockup |

Both modes are **fully editable**. Neither is a read-only preview.

The frame publishes its own mode as **`CanvasInteractionContext`**, which is how
`NodeRenderer` knows which column of that table it is rendering into. Before it
existed only the DOCUMENT-level suppression (`useCanvasFormControlSuppression`)
was live-aware; the node-level handlers applied the design rule to both, so a
live frame blurred every field the moment it was focused and nothing in it could
be typed into.

**One press is one activation.** A suppressed control activates its node on
`pointerdown` — the press has to be cancelled before the browser focuses a field
or opens a picker — so the `click` ending that same gesture must not activate it
again. `NodeRenderer`'s latch is armed by the press and cleared by the click,
and any press it does NOT suppress clears it too (a gesture that never became a
click must not swallow the next one). This looked harmless for as long as
activation only meant "select this node"; it became a visible bug the moment the
prototype player made a click mean "follow this link", because every link
authored on a button pushed its target twice.

**Hover is a MATCH, not a property**, which is why suppressing it is a selector
rewrite (`@core/studio-runtime`'s `hoverSuppressionRules.ts`, applied by `CanvasHoverSuppressionInjector`) and
not an injected rule: `.btn:hover { background: X }` names an arbitrary
declaration block, and no blanket override can undo an arbitrary declaration.
`:hover` is swapped for a class token nothing wears — a CLASS specifically, so
specificity is preserved and `:not(:hover)` stays honest. An ALLOWLIST of the
four page-content stylesheets, never a denylist, so the editor's own chrome
keeps its real hover affordances. The forced-state preview
(`mc-classes-force-state`) is untouched and is still how you see a hover state:
it paints a `:hover` rule's declarations onto the selected node keyed by node
id, with no `:hover` in the selector at all.

**Arriving in live view arms the prototype player and the site's runtime
scripts; leaving disarms the player.** Live mode is one real-size frame of the
app, which is where following a prototype link means anything — the board shows
every screen at once and a click there is a selection. `playMode` left set when
you leave was a trap with no way out: `CanvasModeToggle` only draws the Play
button in live view, so the board silently routed every click to the player,
with no ring, no selection and no visible control to turn it back off, and a
page reload was the only cure. `runScripts` stays where it is on the way out —
it is orthogonal by design and applies to both views.

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
  CSS gate on, and absence is NOT neutral: the built-in design system, which
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
- `selectedNodeFrameId` (`selectionSlice.ts`) and `canvasHover.ts`'s
  `frameId` — the frame a selection/hover currently belongs to. `null` means
  "board-wide" (used outside Studio board mode, where frame identity doesn't
  exist).
- `BreakpointSelectionOverlay.tsx` reads the selection and the hover
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

**Selection chrome inside a live frame is content to `scrollHeight` (canvas-23).**
A live frame's rings, handles and W×H badge live in the runtime's overlay root
INSIDE `<body>`, so anything of theirs that hangs past the body's bottom edge
counts in `body.scrollHeight` — which is exactly the number `runtime.ts`
reports as `frame:resize`. The badge hangs ~24px under the element, so a resize
at the very bottom of a hugging live frame, plus ANY app mutation mid-drag
(the frame-fit reset re-measures), grew the frame by the badge — and the S handles alone (4px) grew it on any
report while a bottom element was selected. The runtime now hides its overlay
root for the `scrollHeight` read (same task, no paint), and freezes its height
reports for the length of a resize (`resizeHandles.ts`' `onGestureChange`, the
live twin of a portal frame's `beginCanvasGesture`), reporting once after the
release. Anything the runtime draws must live in the overlay root, or it
counts as content. Regression coverage: `liveFrameParity.test.ts`,
`tests/e2e/live-frame-parity.e2e.ts`.

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

## Dragging an element BETWEEN frames (D2 G3)

A drag that leaves the frame it started in and lands in another one is a move
whose two ends are in two different FILES. Three modules make that work, and
each of them exists because the same-frame drag's assumptions stop holding at
the frame boundary:

- **`canvasDropSurfaceRegistry.ts`** — every mounted design frame publishes
  itself (viewport, iframe, page id, its own drag layer) while
  `BreakpointSelectionOverlay` is mounted. Registration IS the viewport test:
  only a frame `frameVirtualization.ts` (plus the mount pool) decided to mount
  has an overlay at all, so there is no second on-screen check. It is
  module-scoped, **never a store selector** — a drag reads it on every
  animation frame.
- **`canvasDragBoard.ts`** — every registered frame's client rect, measured
  ONCE per gesture and refreshed on exactly two signals: the LIVE transform
  moved (auto-pan slides the board under a still pointer) or the registry
  version changed (auto-panning to the edge mounts frames that did not exist
  when the drag started). A frame's CANDIDATES are measured lazily, the first
  time the pointer enters it.
- **`canvasDragFrame.ts`** — one animation frame of the gesture, including the
  branch that resolves and paints in another frame.

Three things are load-bearing and easy to get wrong:

1. **Chrome is painted in the frame the pointer is OVER.** `.viewport` is
   `overflow: hidden`, so a cross-frame drop line drawn into the origin frame's
   layer is drawn where nobody can see it. `session.paintedLayer` clears the
   frame being left before the new one is written.
2. **Resolution happens in the DESTINATION frame's own space**, against that
   frame's own candidate index — so nothing needs converting between frames.
3. **A cross-frame drop resolves as an INSERT, not a move.** The dragged
   element is not in that tree, so a move resolver's cycle and self-drop guards
   have nothing to check. The verdict comes from
   `previewStructuralTransplant`, painted as the same refusal chip a same-frame
   refusal already shows, while the pointer is still down.

**`pageId`, never `frameId`, decides whether a drop is cross-frame.** Two frames
can render the same page (a "duplicate as variant" sibling, WS-10 Phase 2), and
a drop between those two is an ordinary same-file reparent that must keep going
through `moveNodes`.

**Released over no frame at all** (the empty board of a Studio board), the drag
is a LIFT (P5-G): the element leaves its page and becomes a loose layer on the
free canvas, keeping the grab offset (`BoardCanvasLayer/canvasLayerLift.ts`,
`canvasDragCommit.ts`'s lift branch; ⌥ lifts a copy). See
[`free-canvas.md`](../features/free-canvas.md).

The write is one `transplant` edit (`transplantJsxElement`), not a delete plus
an insert: two edits are two writes the batch could land half of, and the second
has no markup to insert — the element's source text only exists in the file the
first one just removed it from. Alt held copies instead of moving. Nothing is
moved on the canvas first, because the node that appears in the destination
frame is a DIFFERENT node from the one that left (its id is the `rel:line:col`
the write produces); the commit's resync covers both files, which the batch
reports as touched.

**A cross-frame COPY is gated differently from a cross-frame MOVE, and the
difference is a remedy.** Two of `refusePlacement`'s four reasons exist because
the write would change markup OTHER call sites share: `shared-component` ("the
change would apply to every place that component is used") and `route-chrome`
("every page below the layout renders it"). Both sentences are true of a move,
which cuts the element out of the component's or the layout's own file, and
FALSE of a copy, which leaves those bytes alone and writes one new element into
the destination page's own file. So `previewStructuralTransplant` lets a copy
past those two (`copyEscapesOriginRefusal`) and keeps refusing the two that are
about the markup itself — `list-row` (no source range to read) and `code-placed`
(a spread, a slot fill, an SVG built in code).

That is what makes **"Duplicate into frame instead"** honest. When a move
refuses, `planSourceTransplant` re-asks the SAME function with `copy: true`; the
`duplicate-into-frame` action is appended only if that comes back `ok`, so the
button can never lead back to the sentence it was offered under. Its handler is
a closure over the whole destination (page, container, index), which nothing can
rebuild from a node id once the drag session is gone — so unlike
`position-parent-relative` it travels on `StructuralRefusalDialogState`, and
`RefusalDialog` hands it down to `ConstraintActionButtons`. Pressing it calls
the same `transplantNodes` the drag called, so the copy rides the same
concurrency guard, the same gate and the same single "Copied into another frame"
toast an Alt-drag would have landed. Whether the markup can actually travel is
still the AST's answer at save time (`captured-scope` / `unexported-binding`, by
name).

---

## Dropping a file from the operating system (D2 G15)

**`.svg` files are written inline (P5-D SVG-5).** When every dropped file is an
SVG and the drop is a plain insert, the plan says `inlineSvg` and each file goes
through `canvasSvgInsert.ts`'s `insertSvgAtTarget` — the paste's own write
(sanitised, `svgToJsxNode`, one subtree insert), an `<img>` only when too large
to inline. ⌥ keeps the `<img>`, and so does a ⌘ (absolute) drop. On the empty
board each becomes a loose layer whose root IS the `<svg>`. Assets → Icons uses
the same insert: a click lands after the selection, a drag at the drop line;
"Copy SVG" is on the icon's context menu.

`useCanvasFileDrop` (mounted once at `CanvasRoot`, not per frame) plus
`canvasFileDrop.ts` (the decision) plus a relay in
`useIframeEventForwarding.ts`.

**Native HTML5 drag-and-drop, by necessity.** A file that originates outside
the browser is only ever delivered through `DataTransfer.files`; there is no
pointer-event form of this gesture. Both the hook and the relay are on
`single-drag-mechanism.test.ts`'s allowlist for that reason, and the DECISION
half (`canvasFileDrop.ts`) touches no DnD API at all, so it is not.

- `dragover` **must** be cancelled or `drop` is never delivered — and is
  cancelled only for a drag carrying files, so an in-page `@dnd-kit` drag is
  untouched.
- The relay re-dispatches both events on the iframe ELEMENT and cancels them
  inside the frame, so the browser does not navigate that frame's document to
  the dropped file.
- **What a drop means** (P5-B) is one function, `resolveCanvasFileDropIntent`,
  asked per frame by the preview and once by the drop:

  | Pointer / keys | Files | Meaning | Write |
  |---|---|---|---|
  | on an `<img>` (deepest node declares `imageEdit`) | 1 | **replace** its source (IMG-3) | literal `src`: `asset-drop` + a `prop` value write (ordinary undo); import-bound: `asset-upload` beside the old file + `kind:'asset'` through `commitStudioAssetReplace` (undo template `known`) |
  | on an `<img>` + ⌥, or anywhere else | N | **insert** every image, in order, at the drop line (IMG-2) | N landings, then ONE `insert` edit whose `siblings` carry images 2..N: one write, one resync, one undo step |
  | + ⌘/Ctrl | N | insert, **absolutely at the pointer** (IMG-9), K6's rule: positioned container only, `insetInlineStart` under RTL, cascaded 24 px per image | same insert, `style={{ position, left/inset-inline-start, top }}` |
  | + ⇧ | 1 | the container's **top background layer** (IMG-7) | `asset-drop` + one `setNodeInlineStyles`; refused when a class owns the background |

  **On a Studio board the EMPTY BOARD is the free canvas** (P5-G): every image
  released there becomes its own loose layer (`plan.kind === 'canvas'`), at
  its intrinsic size (the landing route's header read), the first centred on
  the drop point and the rest cascaded 24 px; modifiers do not apply there.
  One structural commit per layer — see [`free-canvas.md`](../features/free-canvas.md).
- Every refusal is decided before the network is touched: on a canvas with
  no free canvas (the CMS editor), the empty board ("Drop the image onto a
  frame"); a drop with no image in it, nothing under
  the pointer that can hold one, ⇧ with several files, an `<img>` whose `src`
  is computed in code, ⌘ into a `position: static` container (K6's one-click
  refusal dialog, not a toast). A mixed drop adds its images and names the
  files it left out. One toast, no write.
- **Size.** Each image is written with `width`/`height` attributes: the
  intrinsic size the landing route read from the header bytes, clamped to the
  drop container's content-box width (`clampImageSize`, one computed-style read
  at drop time). Unknown size writes no attributes. The canvas renders those
  attributes (`ImageEditor`'s `authoredDimension`), so the box it reserves is
  the one the app's browser reserves.
- **The ghost** (IMG-8). `dropImagesIntoPage` activates the dropped-on page,
  paints one optimistic `base.image` per file from its object URL
  (`previewOptimisticInsertRun`) marked `data-studio-uploading`, and writes the
  XHR upload progress into `--studio-upload-progress` on the ghost's own
  element (the painter, `canvasUploadProgress.ts`, is INJECTED into the store
  action — the store never imports frame-document code, or it cycles through
  `store.ts`); `EditorChromeInjector` masks the not-yet-uploaded share. It HOLDS
  the structural queue (`beginStructuralCommit`) from before the upload until
  the commit ends, so no other structural write can resync the page under the
  ghost or renumber the insert's ids. Object URLs are revoked on every outcome.
- **Every studio board frame is a drop surface**, active or not
  (`BreakpointSelectionOverlay` registers it on the structure permission
  alone): a file dragged in from the OS has no pointerdown, so gating on the
  active frame made every drop onto an unclicked frame refuse.
- **The relay carries the held keys** (`altKey`/`shiftKey`/`metaKey`/
  `ctrlKey`) across the iframe boundary — they change what the drop means.
- **Insert image… (IX-img).** `canvasImagePicker.ts` opens a file picker and
  lands the images BESIDE the selection (after it, in its parent; the page
  root with nothing selected) through the same `dropImagesIntoPage`. Command
  `insert.image`; ⇧K is P5-E's to bind.
- **And decided before RELEASE, too.** `canvasFileDragPreview.ts` runs the same
  refusal functions on every `dragover`, through one rAF and zero React
  commits, and paints the answer: over a frame, the element drag's own drop
  line plus a cursor chip naming the format, in that frame's own drag layer;
  over the empty board, "Place on canvas" (a Studio board) or "Drop onto a
  frame" (no free canvas) in `CanvasFileDropHint`, a board-level layer that
  exists because there is no frame layer to use there.
  A `CanvasFileDropRefusal` carries a one-line `headline` for the chip and the
  whole `message` for the toast, so the two cannot drift.
- **The chip names the TYPE, never the file.** Before `drop` the drag data
  store is in the spec's protected mode: `DataTransfer.files` is empty and
  `getAsFile()` returns `null`, so there is no name and no size to show.
  `DroppedFileFacts` is the reduced shape both halves are written against.
- The bytes land through `POST /admin/api/studio/asset-drop` in the project's
  own `public/` — the one directory every framework serves from the site root,
  and therefore the only one that can back a literal `<img src>`. See that
  module's doc for why `src/assets/` cannot. **Unless the page imports its
  images** (P5-B3, IMG-10): an insert names its file (`pageRel`), and a page
  whose image imports outnumber its public literals gets the file beside them
  and `src={ __assetImport }` — see `server.md`.
- **The intake** (P5-B3, `canvasDropIntake.ts`) turns a drop into ONE list of
  `ImageDropSource`s before the plan runs: `Files` first; else ONE link — the
  dragged HTML's `<img src>`, or a `text/uri-list` URL whose path is an image —
  becomes a `url` source the SERVER fetches (`asset-drop-url`, IMG-5, OD-13);
  a `data:image/…` URL is decoded to a `File` in the browser. A link to a page,
  `javascript:`/`file:`/`blob:`, or non-image `data:` is refused with a toast
  and no request. The frame relay therefore relays link drags too (still
  cancelling every drop in the frame first); before release only "a link is
  coming" is knowable, so the chip shows one image of unknown type. A URL
  dropped onto an import-bound `<img>` refuses (the fetch route takes no
  directory); onto a literal one it replaces.
- **Assets → Images** (P5-B3, IMG-6, `ImagesSection.tsx`): every project image
  as a card, dragged with the SAME pointer gesture every Assets card uses
  (`useCanvasInsertionDrag` — no HTML5 DnD, `single-drag-mechanism` unchanged)
  or clicked to land beside the selection. Both go through
  `insertImageSources` → `dropImagesIntoPage` with a `project` source, which is
  referenced, never uploaded: a build-safe file is written as its literal
  `src`, any other as an import. The footer (`UnusedImagesFooter`) offers
  "Delete unused…" for ledger images nothing references (IMG-11), always
  behind a confirmation.
- **A portal frame loads that `src` through the asset route (P5-B2).** The
  frame is `about:srcdoc` on the ADMIN origin, so `/x.png` would load from
  Studio's server and show broken (the `width`/`height` box hid it).
  `canvasProjectAssetUrl.ts` rewrites site-root URLs to
  `/admin/api/studio/asset?dir=…&url=/x.png` at render time, at exactly two
  sinks: `NodeRenderer` (props `src`/`srcSet`/`poster` and the inline style,
  every module at once) and `canvasFrameCss.ts` (the one canvas-only CSS pass
  every project-CSS injector runs: asset URLs → viewport pin → dark scheme).
  The store keeps `/x.png` — an image replace reads `props.src` to tell a
  literal from an import. Left alone: absolute, `data:`, `blob:` (ghosts),
  relative, the scope's own route, and `/uploads/` (the admin's CMS media,
  whose responsive variants are already loadable). **A project stylesheet's
  RELATIVE `url(./bg.png)`** (P5-B3) is pinned server-side, when the sheet is
  read, to a `studio-asset:<workspace-rel>` sentinel
  (`relativeCssUrlsToAssetSentinels`, `studioCss.ts`'s `authoredCss` only),
  which `projectAssetUrl` turns into the route's `path=` lookup. The capture page sets a
  token scope instead (`setCaptureProjectAssetScope`). Bridge frames never
  render through here and need nothing: the project's dev server answers.

---

## Events across the iframe boundary

React synthetic events bubble through the **fiber** tree, so React handlers work
normally. **Native** listeners on the parent `window`/`document` never see iframe
events. Six cases are bridged explicitly:

1. **Wheel** — re-dispatched on the iframe element so pan/zoom works.
2. **Pointer** — forwarded during space-pan and active reorder drags. The one
   pointer event that is deliberately NOT forwarded is the `pointerdown` that
   STARTS a body drag: a reorder drag that begins on an element inside a frame
   is opened by `useCanvasReorderDrag`'s own native capture listener on that
   frame's `contentDocument`, which then translates the iframe-local point into
   parent client coordinates itself (`iframeLocalPointToParentClientPoint`).
   Only the moves that follow ride the relay. See `docs/reference/canvas-dnd.md`.
3. **Keyboard** — one relay for both frame kinds, `canvasFrameKeyRelay.ts`
   (P2-B). A portal frame hears its native events; a Tier 2 bridge frame's
   runtime posts them as `key` / `blur` messages (`keyForwarding.ts`, design
   mode only, never while the user types into the frame). A `keydown` becomes a
   clone on the **parent `document`** (not the iframe element — that would
   double-fire the canvas-root handler that already gets it via fiber
   bubbling). `Tab` is cancelled inside the frame, so it cannot walk the
   authored page's links, and then **forwarded** like any key: the `node` rung
   reads it as "next sibling". A `keyup` is NOT cloned — it goes straight into
   the dispatcher's release broadcast (`dispatchEditorKeyUp`), because a cloned
   keyup would also reach the Alt ladder and Alt-measure, which already listen
   in every frame document. A frame's window losing focus is relayed too (see
   "Focus loss" below).
4. **OS file drag/drop** (D2 G15, `canvasFrameDragRelay.ts`) — **every**
   `dragover`/`drop` in a design frame's document is cancelled there, because
   the browser's default is to navigate the document that received it and that
   tears the portal's React root out. A dropped LINK is as destructive as a
   dropped file, so the cancel is unconditional (`sec-17`); only the
   **file-carrying** ones are then re-dispatched on the iframe element for
   `useCanvasFileDrop`. Design frames only — a live (Tier 2) frame's document
   belongs to the running app. An in-page `@dnd-kit` drag is pointer-based and
   untouched.
5. **Overlay dismiss** — `ContextMenu` attaches dismiss listeners to every
   same-origin document via `collectSameOriginDocuments`. Cross-realm
   `instanceof Node` fails, so use `isNode` (`src/ui/lib/sameOriginDocuments.ts`).
6. **Clipboard** (P5-A, `canvasClipboardBridge.ts`) — `copy` / `cut` /
   `paste` are heard in the editor's document (`useCanvasClipboardBridge`)
   AND each portal frame's (`useIframeEventForwarding`); nowhere else
   (gated by `keybindings-single-dispatcher.test.ts`). The keyboard clone of
   ⌘V on the parent document raises **no** paste event — only the original,
   in the frame, does — so this is its own bridge, not a ride on (3).
   **⌘C / ⌘X / ⌘V must never `preventDefault` their keydown**: cancelling the
   keydown cancels the clipboard event, and `ClipboardEvent.clipboardData` is
   the only prompt-free way to read an image or SVG off the OS clipboard. The
   `node` rung only ARMS the paste (`armCanvasPaste`); the spotlight's capture
   listener leaves the three chords alone (`COMPONENT_OWNED_SHORTCUTS`).
   Copies (any path — the slice's `clipboardEntry` changing) write a Studio
   MARKER (`copiedAt`) onto the OS clipboard, so a paste can tell "the layers
   I copied" from "a newer image". What ⌘V then means is one decision
   (`canvasClipboardData.ts`'s `decideCanvasPaste`): matching marker → layers
   (P3-D's source paste), SVG → sanitised subtree insert (or an `<img>` when
   too large), image → the file drop's own insert, nothing readable → layers.
   **When no event comes** (Safari outside an editable target; a Tier 2
   bridge frame, whose events are cross-origin) a timer armed at keydown —
   which a real event, raised in the same task, always beats — reads
   `navigator.clipboard.read()` / writes with `navigator.clipboard.write()`.
   Pastes into a text field, a key-owning overlay, or an inline edit are left
   to the browser. **Only a real keystroke may read the OS clipboard**
   (review #270): the fallback is armed only when `isUserGestureKeyEvent`
   says so — a trusted keydown, or a relay whose ORIGINAL native event was
   trusted (`relayFrameKeyDown(…, { userGesture })`). A Tier 2 frame's `key`
   message is forgeable by the project's code, so it never arms the read and
   its ⌘V pastes the copied layers only; a script-dispatched `paste` event
   (`!isTrusted`) is ignored.

**A drag must survive a release it never hears (ERR-12).** A `pointerup` over
a frame goes to that frame's document, so any drag listening on the parent can
lose it. Every canvas drag — element resize (both hosts), reorder, insertion,
ruler guides (move and create), prototype links, comment pins, the board
marquee — runs under `guardDragSession` (`@core/studio-runtime`): a
`pointermove` with the button up finishes the drag at its last point, and a
real window focus loss cancels it. A parent-document drag also holds pointer
capture AND arms the cross-iframe relay (`markCanvasPointerRelay`), which is
what the guide drags lacked. The guard's `blur` is only a hint: focus moving
INTO a frame blurs the parent window, so the check waits one task and asks the
top document's `hasFocus()`. It is separate from P2-B's window-blur reset of
the pan/Alt latches.

### One keyboard dispatcher, six scopes (`K1`)

**A canvas shortcut that must work from anywhere cannot be a React `onKeyDown`.**
A handler on the canvas div only fires while a canvas descendant holds DOM
focus — and selecting a node auto-opens the Properties panel, so one click into
it takes focus out of the canvas for the rest of the session. That defect was
reported twice (`board-02` for ⌘A, `select-01` for Escape). The same limit
applies to `shortcutDispatch.ts`'s generic palette dispatcher, whose
`isLayerShortcutSurface` asks the same focus question.

The answer used to be "add another `document` listener", and the editor ended up
with nine of them, each re-implementing the same guards, with precedence decided
by **mount order**. There is now exactly one:

- **`useEditorKeyDispatcher`** (`canvas/useEditorKeyDispatcher.ts`) owns THE
  `keydown`/`keyup` listener pair on the parent `document`, bubble phase.
  Mounted once, in `SitePage` — above the lazy editor body, so it outlives every
  remount below it.
- **`editorKeyDispatcher.ts`** holds the scope registry and the precedence
  ladder, highest first:
  `inline-edit > vector-edit > prototype-link > annotation > node > board > global`.
  Each active scope gets first refusal; `handle` returning `true` means CLAIMED
  and stops dispatch, `false` falls through to the next rung. That fall-through
  is what lets `T`/`F`/`C` (board) still fire with a node selected while Delete
  (node) does not reach the board.
- Every former hook is now a scope handler registering through
  `useEditorKeyScope(id, isActive, handle, handleKeyUp?)` and owns **no
  listener of its own**: `usePrototypeLinkKeyboard` (prototype-link),
  `useBoardAnnotationKeyboard` (annotation), `useCanvasSelectionKeyboard` +
  `useCanvasNodeShortcuts` + `useCanvasNodeArrowKeys` (node), `useBoardSelectAllShortcut` /
  `useCopyAsPngShortcut` / `useBoardFrameNudge` / `useCanvasToolShortcuts`
  (board), `useEditorHistoryShortcuts` (global).
- Shared guards live in `canvas/editorKeyGuards.ts` (`isTextInputTarget`,
  `isInsideKeyOwningOverlay`) — the overlay selector used to be copy-pasted into
  four files under two names.
- `useCanvas` registers the `global`-rung viewport scope
  (`hooks/useCanvasViewportKeys.ts`, P2-B / IX-15): + / = / − / _ zoom, ⌘0 and
  ⇧0 zoom to 100%, ⇧1 fit, ⇧2 fit the selection, Space held to pan. They were a
  React `onKeyDown` on the canvas div (dead after one click into a panel) and
  two raw `document` listeners. The canvas div binds no key handler at all now,
  and `@use-gesture`'s own arrow-key drag is off (`drag.keys: false`).
- `keybindings-single-dispatcher.test.ts` gates it: exactly one
  `addEventListener('keydown'` under `canvas/` **and `hooks/`** (widened in
  P2-B), plus a justified allowlist for the iframe bridge, `usePersistence`'s
  window-level ⌘S, and the gesture-local Escape listeners (a resize drag, a
  comment-pin drag, an armed comment tool, a link pick, the Alt-hold ladder).
  A hook that hands back a `handleKeyDown` for someone else to bind fails it
  too.

The rules the ladder replaced prose with:

- **Focus loss releases every key (ERR-11).** `handleKeyUp(null)` is the
  release broadcast with no event: "every key is up". The dispatcher sends it on
  window `blur` — but only when focus actually LEFT the editor
  (`releaseEditorKeysIfFocusLeft` checks `document.hasFocus()` on the next
  task; a click into a frame is not a release) — and on the document going
  hidden. Frames relay their own window's blur. Space-pan lowers BOTH keyboard
  sources on any release (`releaseCanvasKeyboardPan`), because a press and its
  release can land in different documents; every Space keydown re-asserts its
  source, so over-clearing self-heals. The hand tool's latch is never touched.
- **What counts as typing (ERR-21).** `isTextInputTarget` is a text-entry
  `<input>` or `<textarea>` that is not read-only, or a contentEditable. The
  `Select` trigger (a read-only combobox input), checkboxes and ranges are not,
  so Delete / ⌘D / ⌘C reach the selection with one of them focused. Space keeps
  the wider `isSpaceOwningControlTarget` (any form control), because Space
  activates a checkbox. Duck-typed on `tagName`, so it also works on a target
  from a frame's realm.
- **Tab is canvas-scoped; ⌘A is not (IX-3, IX-4).** Every `node`-rung key is
  scoped by intent except Tab / ⇧Tab, which cycle siblings only while focus is
  on the canvas, a frame, or nowhere (`isCanvasKeyboardSurface`) — inside a
  panel Tab walks the fields. ⌘A with a node selected selects its siblings,
  again climbs a level, and at the root hands over to the board's "all
  frames"; it is claimed whenever a node is selected, so the browser never
  selects the chrome's text.
- **V is home (IX-11)** — the move tool, and it disarms the comment tool too.
- **Escape is "deselect", not "select parent"** — traversal took Figma's own
  Enter/⇧Enter, because re-pointing Escape re-opens the bug `select-01` fixed.
- **Enter (P5-E, IX-7):** on ONE text layer it opens the inline edit, the
  double-click path (`canvasTextEditStart.ts` — portal frames only, because a
  live frame's text edit is started by its runtime and a session opened from
  here would arm the `inline-edit` rung over nothing editable); on anything
  else it selects EVERY child of the selection (`selectChildNodes`). ⇧Enter
  selects the parent of every selected layer. With a draw tool armed, the
  `node` rung gives Enter up and the `board` rung inserts at the selection.
- **Layer commands (P5-E):** ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V align, ⌘⇧] / ⌘⇧[ front /
  back, ⇧A flex, ⌘⌥C / ⌘⌥V copy / paste style — `useCanvasLayerCommandKeys`
  on the `node` rung, component-owned. Letters with ⌥ are matched on
  `event.code` (⌥A is `'å'` on a Mac). ⌘C / ⌘V reject ⌥ since then: before,
  Ctrl+Alt+V pasted a layer AND a style. The right-click menu and the palette
  run the same functions (`layerCommands.ts`, `layerAlign.ts`).
- **Detach instance (P5-C):** ⌘⌥B / Ctrl+Alt+B (`layers.detachInstance`, the
  same `node` rung) calls the store's ONE `detachInstances` action
  (`store/slices/site/instanceActions.ts`) — the Component section's button,
  the right-click menu ("Detach instance", shown only when every target is an
  instance), the palette and the refusal remedy call it too. It confirms only
  when something is lost (`DetachConfirmDialog`).
- `canvas.moveSelection` is the only bare-arrow binding in the registry and it
  is scoped by **what is selected**, never globally. Three rungs read it:
  notes/docs (`annotation`), the selected layer (`node`,
  `useCanvasNodeArrowKeys`, P2-C / IX-1), frames (`board`). A mixed marquee
  (notes AND frames) nudges the notes, because `annotation` outranks `board`.
  Sibling selection went to Tab / ⇧Tab, not the arrows.
- **Arrows on a layer (IX-1).** An `absolute | fixed` layer nudges its
  offsets 1 px / ⇧ 10 px; any other layer reorders along its parent's axis
  (`reorderStep`: reversed for `*-reverse` and an RTL row; a cross-axis arrow
  does nothing; in a GRID ↑ / ↓ move a whole row — the resolved
  `grid-template-columns` count — and ← / → one cell, P2-C2). The decision
  needs ONE layout read — `measureArrowTargets` asks the frame adapters for
  every selected layer and its ancestor chain in one `measure`, so a live
  frame answers it too. Rules in `canvas/canvasNodeArrowMove.ts`, the gesture
  in `useCanvasNodeArrowKeys.ts`. Canvas-scoped like Tab
  (`isCanvasKeyboardSurface`): in a panel the arrows stay the panel's.
- **A multi-selection moves as one gesture (P2-C2, OD-16).** Any positioned
  member → every positioned member nudges by the same delta (one preview bag
  per layer, `NodeStylesPreview.stylesByNode`; one
  `setNodesInlineStylesPerNode` on release); the flow members of a MIXED
  selection stay put. All flow → `stepSiblings`: `@core/page-tree`'s
  `planSiblingSteps` turns the step into INDEPENDENT single-element moves (a
  run of 2+ is its one neighbour jumping over it; a single layer moves
  itself), written as ONE `/save` sequence (`moveNodesInSequence` →
  `commitStudioSequence`, each step against the file the last one left, P3-D)
  and ONE history entry (`gesture: 'moves'`, undone by re-issuing the
  inverse sequence). A grid-row step of 2+ layers
  and a nested pair are not independent and refuse by name. ⌥↑ / ⌥↓, ⌘[ /
  ⌘] and the palette's Move up / down share `stepSelectionAmongSiblings`.
- **A pointer pick in Layers hands the keyboard to the canvas (OD-15).** A
  click on a Layers row (`event.detail > 0`) calls `returnKeyboardToCanvas`
  (`canvas/canvasKeyboardFocus.ts`), which focuses the canvas root exactly as
  a canvas click would — so the arrows move the layer just picked, Tab cycles
  its siblings, and nothing is stuck (Esc and a canvas click behave as
  before). KEYBOARD entry into the tree (Tab, a keyboard-synthesised click)
  never hands off: there ↑/↓ are the tree's own row navigation
  (`LayerRowList`'s `handleTreeKeyDown`: select and focus the next visible
  row, ⇧ extends the range, nothing is written) and →/← expand and collapse.
  A rename field keeps its caret (P2-B's input guard, and its target is not a
  row).
- **A held arrow is one undo entry and one source write.** A nudge previews
  every repeat through the inspector's scrub channel (`setPreviewNodeStyles`
  + the optimistic style broadcast for live frames), then writes ONE
  inline-style transaction on the arrow's keyup (the dispatcher's release
  broadcast — P2-B routes frame keyups there) and flushes the autosave. A
  focus loss (`handleKeyUp(null)`) commits where the preview was. A reorder is
  one step per PRESS: the repeats are claimed and dropped, because a
  structural write per repeat would queue thirty a second.
- **A nudge writes the offsets the source authored**, not always `left`/`top`
  (`authoredOffsets`: inline over class base styles, `inset` read side by side, so `inset: 124px 0 auto 0` never gains a `bottom`). A
  computed inset on a positioned element is its used px value, so the DOM
  cannot tell `right: 20px` from `left: auto`; writing `left` there
  over-constrains the element. Nothing authored → `left` (`insetInlineStart`
  under RTL) and `top`, the same keys a free move and a resize write — always
  **camelCase**, because they are keys of a JSX `style={{…}}` object. Only a
  CSSOM preview spells them kebab (`cssPropertyName`).
- Delete with a prototype connector AND an element selected removes the
  connector, because `prototype-link` outranks `node`. This used to be a
  capture-phase listener plus `stopPropagation`.

Keys themselves always go in `src/admin/spotlight/keybindings.ts` — never a
hand-rolled listener, never a hand-typed `⌘…` label
(`keybindings-registry-single-source.test.ts` gates both). A binding whose
`commandId` is a real, argument-free spotlight Command needs no handler at all;
the generic dispatcher runs it (that is how ⌘⇧H → `layers.toggleVisibility` and
⌘⇧L → `layers.toggleLock` work). Anything the canvas must own itself goes in
`COMPONENT_OWNED_SHORTCUTS` so it can't double-fire.

The registry spans three files: `keybindings.ts` (the chords the dispatcher
routes), `keybindingViewport.ts` (the view keys `useCanvasViewportKeys` handles)
and `keybindingGestures.ts` (modifier gestures read off pointer or drag events,
whose `match` is constant-false; they are there for the `?` sheet). A key that
Figma and Penpot give different meanings gets a row in the **conflict register**
at the top of `keybindings.ts` (OD-3, `docs/decisions.md`) before it gets a
binding.

### The latched tools (`K4`)

`canvasTool: 'move' | 'hand' | 'scale'` on the canvas slice is what a plain drag
currently means. Two rules keep it from becoming a second input system:

- **The hand tool does not implement panning.** `useCanvasHandTool` mirrors
  `canvasTool === 'hand'` onto the SAME `data-*` flag holding Space already sets
  (`canvasPanInput.ts`, now three sources: `parentDocument`, `iframe`,
  `handTool`). Everything pan-aware already reads
  `isCanvasSpacePanActive(document)` — the drag gate in `useCanvas`, the grab
  cursor, `IframeFrameSurface`'s `pointer-events: none`, `useMarqueeSelection`
  and `useCanvasReorderDrag` — so arming the tool suppresses selection and
  reordering for free. `useCanvas` lost its private `spaceActiveRef` in the
  process: a ref saw one of the three sources.
- **The scale tool is a flag on the existing handles, not new handles.**
  `useElementResizeDrag` reads `canvasTool === 'scale'` from the store at
  `pointerdown` and latches it for the gesture — so pressing `K` mid-drag never
  changes a gesture already under the cursor. ⇧ does the same thing and is NOT
  latched: it and ⌥ (resize from the centre) are read from every pointer move
  and every modifier key change (P2-D, IX-6c). The geometry is pure
  (`@core/studio-runtime`'s `elementResizeRules.ts`): the ratio comes from the
  START border box, a corner follows the larger scale, and a zero-sized element
  (a `display: contents` host) degrades to a free resize instead of dividing by
  zero.

### Snapping, in one place (P5-F)

`@core/studio-runtime`'s `snapRules.ts` `computeSnap` is the ONE snap
resolver: board furniture, element free move, element resize edges (portal
and live) and P5-G's loose layers all ask it.
Per axis the closest of three candidates wins — alignment to a peer's
edge/centre, a ruler guide (`SnapLine`), or equal spacing
(`snapSpacingRules.ts`: the same gap as one the row already has, or centred
between two neighbours). The pills (`SnapResult.spacings`) describe where the
rect ENDS UP, whichever candidate moved it. The user's two toggles
(`snapPreferences.ts`, persisted to `localStorage`; ⌘⇧' objects, ⌘' ruler
guides; also in the zoom menu and the empty-selection panel) take effect in
exactly one function, `snapSourcesFor` — furniture goes through
`snapBoardFurniture` (`canvas/boardSnapping.ts`), which applies it — P5-G's
loose-layer drag included. Ruler guides are BOARD space; an
element's rects are frame space, so they are converted once per gesture
through the screen (`guideLinesInSpace`: the transform layer's rect top-left
IS board (0, 0) because its `transform-origin` is `0 0`). Element pills paint
in the frame's drag layer (`canvasDragPainter`); furniture pills render from
the store's `boardSnapSpacings` in `BoardGuidesLayer`.

### The draw tools (P5-E, IX-12, OD-5)

`R` / `O` (and `E`) / `T` / `F` **arm** a draw tool — `canvasTool` is
`'rectangle' | 'ellipse' | 'text' | 'frame'` — instead of inserting at once.
While armed, `CanvasRoot` mounts `CanvasDrawToolLayer`: a crosshair,
click-catching layer over the whole canvas in the PARENT document (z 44:
over the frames, under the rulers and notch), so one gesture works the same
over a portal and a live bridge frame and neither frame's document sees the
press. Hover shows the insertion drag's own drop line
(`resolveCanvasPointerInsertionDrop` + a per-arming candidate snapshot); a
click inserts there (a box gets Figma's 100 × 100, text its natural size), a
drag also writes the drawn `width` / `height` (screen px ÷ the frame's zoom;
⇧ square, ⌥ from the centre), and the tool puts itself away. Space / the hand
tool make the layer click-through (the pan owns the pointer). T opens the new
text for typing through `createdNodeFollowUp.ts` → `canvasTextEditStart.ts`.
⏎ with a tool armed is the old immediate insert (`T` / `F` inside the
selection, `R` / `O` after it).

Everything a draw writes rides the insert itself: the size, `O`'s
`borderRadius: 50%` and the rectangle / ellipse default fill go in
`insertNode(…, inlineStyles)`, which `writeInsertToSource` passes to
`commitStudioInsert` as a `style` prop — one write, one undo entry. A
follow-up `setNodeInlineStyles` could not work on a studio tree: there the
insert is an async source write that returns `''`, so no id exists to style
until the resync lands.

**The pen (P5-D, SVG-7).** `P` arms `canvasTool: 'pen'` (a `VectorTool`;
`isArmedTool` covers both kinds) and `CanvasRoot` mounts it through the same
lazy boundary, `CanvasArmedToolLayer` → `CanvasPenToolLayer`: the draw layer's
capture surface, with the preview in BOARD units in an svg portalled into the
transform layer, written imperatively per rAF. Click = corner, drag = smooth
(⌥ breaks symmetry), ⇧ = 45°, click the first point = close; ⏎/Escape finish,
⌘Z/Backspace pop the last point (its `vector-edit` rung, active while a path
has points). The whole session is ONE write: an `insert` of
`<svg …D5 defaults><path d/></svg>` at the FIRST click's drop target
(`planSourceInsert` + `commitStudioInsert` with element children), or a loose
free-canvas layer (`createCanvasLayer`) when it started on the empty board.

**The empty board is P5-G's.** A press outside every frame is offered to
`registerBoardDrawHandler`'s handler (`canvasDrawTool.ts`) with the drawn
rectangle in BOARD units; with none registered it is ignored and the ghost
says "draw inside a frame". The one exception is **B, the board tool** (P5-F,
IX-13): inside a frame it is the F tool, and on the empty board it never
reaches that handler — it opens the add-page picker at the release point
(`BoardDrawPagePicker`, through the store's `boardDrawRequest`), and the pick
lands at the drawn rect (`boardDrawTool.ts`: a click is a point at the default
size, a drag its size floored at `MIN_FRAME_SIZE`, a width within 8 units of
a device preset becomes the preset). A new page is ONE server call —
`POST /admin/api/studio/page` with a `placement` writes the page files and
the `boards.json` frame under the project write lock; an existing page is one
`addFrame(pageId, placement)`.

**`createdNodeFollowUp.ts`** is the seam for "do X to the element this gesture
creates": it snapshots the node ids at arming time and runs once, on the
first selection of a node that did not exist then (`store-13` selects what a
write created when its resync lands), within 8 s. Selecting anything that
already existed drops it.

**During an inline edit both keyboard paths must stand down.** The `inline-edit`
rung claims every keystroke and acts on none, and
`useIframeEventForwarding.onKeyDown` returns early without forwarding —
otherwise Cmd+Z runs the store `undo()` while the contentEditable DOM keeps the
text, and store and DOM diverge. A bridge frame's runtime never posts a key
typed into a contentEditable at all (`keyForwarding.ts`). The third path the
viewport keys used to be — a React `onKeyDown` on the canvas div, which a
synthetic event from inside a frame still reaches through the fiber tree — is
gone since P2-B: those keys are a ladder scope, so the halt covers them.

### A live frame does not stop propagation, and one press is one activation

`NodeRenderer` activates a node from its **capture-phase** `onClickCapture`,
which sits ABOVE the authored element (a design-system / package component's
editor bag goes on a `display: contents` host, and the component's own
`<button>` is a descendant of it). `stopPropagation()` there means the authored
component's own `onClick` **never runs at all** — so a live frame only calls it
when it owns the click outright (`interaction !== 'live'`). `preventDefault()`
still applies in both: an authored `<a href>` must not navigate the frame away.

Letting the event through means this node's bubble-phase `onClick` sees the same
gesture a moment later. `canvasNodeGestureLatch.ts` holds the two module-level
latches that collapse `pointerdown` → compatibility `mousedown` → `click` into
ONE activation. **Match on the NATIVE event, never the synthetic one:** React
dispatches each phase from its own root listener and mints a separate
`SyntheticEvent` for each, so synthetic identities never match across phases.

**The prototype player follows a link on the press/release PAIR, not on the
`click`.** A `click` is dispatched at the nearest common ancestor of the
mousedown and mouseup targets — and when the mousedown target has left the
document by the time the button comes up, there is no common ancestor and the
browser dispatches **no click at all**. A component whose hover/press effect
re-renders under the finger does exactly that on the first press and has settled
by the second, which is what "the link doesn't fire on the first click" looks
like. The node's own host element is rendered by `NodeRenderer` and survives
that churn, so `onPointerDownCapture`/`onPointerUpCapture` on it are the reading
of the gesture a component cannot break. See `useCanvasNodeInteraction`'s
`PlayGesture`.

---

## Runtime diagnostics — what a frame says went wrong (Z5)

A frame whose component throws paints a blank rectangle, and a screenshot of
that is indistinguishable from an empty screen, a collapsed layout, or a capture
taken too early. So every canvas frame collects what its own runtime reported,
into one buffer, with **two collectors and no third**:

| | portal frame (Tier 0/1) | bridge frame (Tier 2) |
|---|---|---|
| Who installs the taps | `CanvasDiagnosticsInjector`, reaching into the frame's `Window` | `@core/studio-runtime`'s `runtime.ts`, inside the frame |
| How a finding gets out | a direct call to `recordFrameDiagnostic` | the outbound `error` postMessage → `useBridgeFrameDiagnostics` |
| Where it lands | `canvasDiagnosticsBuffer.ts`, keyed by the iframe's `Window` | the same buffer, the same key |

The four taps are identical on both sides — capture-phase `error` (**capture is
mandatory**: a failed `<img>`/`<script>`/`<link>` load does not bubble),
`unhandledrejection`, a pass-through `console.error` patch (React reports a
failed render, an invalid hook call and a hydration mismatch through this
channel and **nowhere else**), and a `fetch` wrapper that records only
failures. The predicates that turn a raw value into a classified finding live in
ONE place, `@core/studio-runtime`'s `runtimeErrorRules.ts`, shared by both — the
same "one implementation each" arrangement hover suppression, scroll unroll and
animation freeze already use. Two copies would mean a live frame and a design
frame classifying the same exception differently.

Keying the buffer by the iframe's own `contentWindow` is what makes
`studio_page_diagnostics` (`agent/studioPageDiagnostics.ts`) see a Tier-2 frame
**with no change to the tool at all**: it finds a page's frame in the DOM and
reads `iframe.contentWindow`, which is obtainable from the parent even
cross-origin.

**Two surfaces read it, neither of them a toast.** A `--warning` dot on the
board frame's header (`FrameDiagnosticsBadge`), and a "this screen crashed" card
over the Play surface (`PlayCrashCard`). Both subscribe by **scope key** — a
string the mounting component supplies through `CanvasDiagnosticsScopeContext`
(`BoardFrameView` passes the board frame id; the Play surface passes
`live:<pageId>`). Deliberately not `CanvasFrameContext`: that one scopes
SELECTION, and the player's frames have no board frame id. A frame with no scope
key still collects for the agent and simply notifies no UI — the right answer
for a capture frame nobody is looking at.

**It is never a toast, and that is a rule, not a preference.** A React render
loop emits the identical error hundreds of times a second; `pushToast` would
stack that into a wall of red boxes for a frame the author may not even be
looking at. The buffer aggregates by `(kind, code, message, url, nodeId)`, so a
repeated failure is one entry with a count.

**Bounded at the sender, not only at the receiver.** `runtime.ts` posts at most
10 errors per second and 50 per document — the FIRST 50, not a ring of the last
50, because the first error is usually the cause and the rest are its
consequences. The wire message's `message`/`stack`/`source` carry
`maxLength` bounds matching the buffer's own truncation, so an honest sender is
never rejected and a same-realm forger (`sec-06`) cannot post an unbounded
string into the parent's trusted document.

Vite's own error overlay inside a live frame is **left on** — it is the user's
app telling the truth in the user's own words. Studio adds a quiet badge beside
it; it does not replace it. The generated `vite.config.js` template says so in a
comment (`server/handlers/studio/prototypeShell/shellFiles.ts`).

---

## Vector editing (P5-D)

Double-clicking a literal `base.svg` (`vectorEditEntry.ts`, before
`startInlineEdit`) enters vector edit mode — or refuses BY NAME (a `?raw` icon,
a `.map` row, locked, no stamped paths, a live frame, > 5,000 anchors, every
`d` from code). The mode is a tiny external store (`vectorEditState.ts`), not
editor-store state; it ends on Escape/⏎, a selection change, or the node going
away.

- **Board space, not screen space, not in-frame** (audit 08 §4.2 option c).
  `BoardVectorLayer` mounts in `StudioBoardLayers` after the frames. Each
  part's map is `frame content origin + part.getScreenCTM()`, measured once per
  session and again whenever the host's markup changes (a re-applied `__html`
  recreates every inner element — always re-query by `data-studio-svg-part`).
  The origin is read against `[data-studio-board-origin]`. Nothing is measured
  per pan, zoom or move. Chrome is sized `px / zoom` from the COMMITTED zoom.
- **O(1) DOM.** All idle anchors are one path of squares, all hit targets one
  transparent path (`pointer-events: fill`); `pointerdown` finds the anchor by
  a linear nearest search. The overlay's geometry is written imperatively
  (`paint`) — React renders the elements, never their `d`.
- **One gesture = one write, zero React commits per move.** The drag mutates a
  ref'd model in one rAF, mirrors `d` onto the real in-frame `<path>` (D6) under
  `beginCanvasGesture()`, and on `pointerup` posts ONE `svg-attr`
  (`svgPartCommits.ts`, a `known` structural inverse = one undo entry). A write
  that does not land restores the old `d`. Arrow nudges are one write per burst
  (400 ms after the last press).
- **Point edits that change the segment list** (`@core/vector`'s `pathEdit`:
  splice the source, restore every later segment's absolute geometry, minimal
  re-emit): double-click the outline adds a point by an exact split (a 12 px
  transparent stroke per part is the target), Delete / Backspace remove the
  selected point (its neighbours join; always claimed, or the `node` rung
  would delete the svg), double-click a point toggles corner ⇄ smooth. Each is
  one `svg-attr`. The svg's resize handles stand down while its points are
  edited (`CanvasResizeHandles`).

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

**A canvas click (OD-3, IX-2):** plain click replaces; ⇧-click and ⌘/Ctrl-click
both TOGGLE (`canvasClickSelectionMode`, `canvasSelectionUtils.ts`) — the frame's
React click, a bridge frame's forwarded click and a native `<select>`
activation all call it. Range stays a Layers-panel gesture (`TreeNode.tsx`).

**Instances (`studio.instance`):** a click or hover inside a closed instance
lands on the OUTERMOST closed one (`findEnclosingInstance`), and a double-click
opens one level (`resolveInstanceEntry`): the card, then the button inside it,
then the exact node. Portal frames apply it in `NodeRenderer`, bridge frames
in `useBridgeFrameInteraction` (a double-click there arrives as
`text:editStart` and is answered "not allowed" after the entry). It was the
nearest instance until P2-B, and bridge frames skipped it entirely — a click on
a component in a live frame selected the element inside it.

- `canvasDomGeometry.ts` — cross-iframe measurement, `nodeVisualRect`
  (child-union fallback for box-less nodes), `panToCenterBreakpointFrame`.
- `canvasSelectionOverlayPositioning.ts` — places rings/toolbar/inspector.
  Keeps an `appliedOverlayPlacements` WeakMap so the write phase no-ops when
  nothing moved (same-value style writes are not free).
- `canvasNodeLookup.ts` — `ownElementForNode` / `presentedElementForNode` are
  the "which element IS this node" answers, as opposed to
  `RenderedCanvasNodeCache.resolve`'s "where is this node" (which falls back to
  a fragment node's rendered descendants, right for drawing a box and wrong for
  writing to one). `presentedElementForNode` also descends through a
  layout-transparent (`display: contents`) host, because a module may carry the
  node id on a wrapper that produces no box — right to SELECT, wrong to SIZE.
- **Element resize** — `CanvasResizeHandles` portals eight handles into the
  iframe overlay root and `BreakpointSelectionOverlay` positions them off the
  SAME measured rect as the selection ring, so they cannot drift off the box
  they belong to. `resizeOffer.ts` decides whether they exist at all; the three
  refusals (no element of its own, a `display` CSS ignores a size on, a module
  that does not own its own `style=""`) exist because handles that track the
  cursor for a whole drag and then snap back are worse than no handles.
  What a drag writes (P2-D) — one `setNodeInlineStyles` call, so one undo
  entry and one source write:
  - **The CSS size, not the rect** (IX-6a). The drag moves the BORDER box;
    `readResizeBoxStart` (`elementResizeMeasure.ts`) reads the computed
    `width`/`height` plus the padding + border `content-box` puts outside
    them, and `resizeElementBox` converts back. The aspect lock and the 8px
    floor are visual, so they run on the border box.
  - **A flex / grid child goes Fixed** (IX-6b) through the inspector's own
    `sizingPatch('fixed', …)` (`@core/studio-runtime`'s `elementResizeSizing.ts` → `elementSizingRules.ts`):
    the Fill marker (`flex: 1 1 0`, `align-self: stretch`) goes with the
    width, and a `flex` the CASCADE still applies (a class) is overridden with
    `flex: 0 1 auto` — probed once at `pointerdown`. The preview applies the
    same patch and restores every property it touched before the commit
    (`elementResizeInlinePreview.ts`). A live frame plans the SAME patch in
    its runtime from the stored markers the parent sends with
    `setResizeTarget` (canvas-23), and previews it through its stylesheet —
    a cleared marker as the value the cascade gives without it.
  - **A flow element gets a size and never a position**: its position is
    produced by layout, so the W/N handles invert the delta. A
    `position: absolute | fixed` element is the exception (IX-6d): its W/N
    handles (and ⌥) also move `left` (`insetInlineStart` under RTL) / `top`
    so the opposite edge stays put.
  - **The moving edge snaps** (P2-E / IX-6e, `elementResizeSnapRules.ts`) to the
    siblings' and the parent's padding / content box edges and centres, at
    the screen-px threshold. Only an edge the drag really moves snaps: every
    handle of an `absolute | fixed` element; the E/S handles of a flow element
    whose layout keeps its start edge (`flowStartAnchored`: block flow, a
    start-packed flex/grid item, LTR for the inline axis). A W/N handle on a
    flow element, a centred item, ⌥ and ⇧ on a corner do not snap — no single
    edge follows the pointer there, and a guide that promises an alignment
    the element does not reach is worse than none. The POINTER delta is
    snapped before `resizeElementBox`; guides paint into the frame's
    parent-document drag layer (`elementResizeGuides.ts`) in the preview's
    own rAF. A live frame snaps in its runtime against the tree siblings,
    parent and zoom the parent sends with `setResizeTarget`, and posts its
    guides as `resize:guides` for the parent to paint the same way (canvas-26).
    The board's ruler guides are snap lines too (P5-F, IX-5c,
    `resizeGuideLines` in `elementResizeGuides.ts`), and both snap toggles
    apply — portal frames only: `ResizeSnapContext` carries neither guides
    nor toggles to a live frame yet, so it snaps to peers with both on.
  - **Double-click a handle: Hug** (P5-F, IX-6f). `hugPatchForHandle` is the
    inspector's own `sizingPatch('hug', …)` on the axes the handle owns (an
    edge one, a corner both), in one `setNodeInlineStyles`. Detected as a
    SECOND PRESS on the same handle within 400 ms of a press that moved
    nothing — never from the native `dblclick`, which a real browser did not
    deliver after the handle's cancelled `pointerdown` (measured by the e2e).
  - **Rotation** (P5-F, IX-25, `useElementRotateDrag.ts`). Four invisible
    zones just OUTSIDE the corner handles (`ROTATE_HANDLE_ATTR`, placed by
    `selectionChromeCss.ts`), so a press on the corner still resizes. The
    angle is the pointer's turn about the element's bounding-box centre,
    added to its current rotation; ⇧ snaps to 15°. It writes the STANDALONE
    `rotate` property — never `transform` — and 0° clears it
    (`rotateValue.ts`, shared with the inspector's `RotationRow`). Refused,
    with a toast, when `transform` already rotates or `rotate` is not a plain
    2D angle. Rings stay axis-aligned: `getBoundingClientRect` is the box the
    rotated element covers.
  - **A multi-selection gets ONE set of handles on the union of its rings**
    (P5-F, IX-6g — `CanvasGroupResizeHandles`, `useGroupResizeDrag.ts`,
    `groupResize.ts`; placed by `resizeFrameRect`). The union resizes by the
    single-element rules; each member scales with it about the union's
    origin and is written through the single-element pipeline (box-sizing,
    Fixed companions, authored anchors) — size always, offsets only for an
    `absolute | fixed` member, since a flow member's position is layout's.
    One `setNodesInlineStylesPerNode`: one undo entry. All or nothing: one
    member `canOfferResize` refuses draws no group handles. Not yet: group
    edge snapping, group rotation, double-click Hug on a group.
  - **One drag session for every handle** (`handleDragSession.ts`): pointer
    capture, ⇧ / ⌥ read on every move AND key change, Escape, one write per
    rAF, `guardDragSession` (ERR-12) and the canvas-gesture freeze are
    written once and shared by the single resize, the group resize and
    rotation. A new handle gesture supplies `step` / `paint` / `end` and
    gets all of it; it does not get a second copy.
  - **The W×H badge** (IX-18) is a child of the handle frame, shown by
    `selectionChromeCss.ts` only while the frame carries
    `data-canvas-resizing`; its text is the ring's own measured rect, written
    by `positionResizeFrame` in the overlay's write phase.
  - **The click that ends a drag is swallowed** at the frame document
    (capture phase) when its target is inside the handle frame. The overlay
    root lives in the page's `<body>`, so that click used to bubble into the
    body node's click-to-select and every resize ended with the page selected.
  - The live runtime's handles (`resizeHandles.ts`) run the same rules and
    guard. Not yet there: the flex/grid companions, because the resolver needs
    the node's stored styles, which the frame side of the wire does not have.
- **Padding and gap handles (P5-E, IX-17).** `CanvasSpacingHandles` renders
  INSIDE the resize-handle frame (before the handles, so an edge strip wins
  at the edge), so the bands ride the ring's one measurement. Shown for a
  single flex / grid container; gap bands between consecutive children
  (`columnGap` side by side, `rowGap` stacked). The one layout read
  (`spacingHandleMeasure.ts`) runs in a rAF on mount, on a store change to
  the node and on a `ResizeObserver` tick; during a drag the bands follow the
  preview arithmetically. Positions are `--band-*` custom properties read by
  `canvasSpacingChromeCss.ts`, appended to the portal injector's unlayered
  chrome sheet (not `selectionChromeCss.ts`: the runtime bundle has no
  handles). A drag previews on the element's own `style` and commits ONE
  `commitStyleMany` through the inspector's commit API
  (`selectionStyleCommands.ts`), so it lands where the Layout section's field
  would (inline, or the one class that already sets it). ⇧ writes the axis
  pair, ⌥ all four. Portal frames only.
- **Style writes from outside the inspector** (`selectionStyleCommands.ts` +
  `SelectionStyleCommandHost`): ⇧A, a flow child's align, paste-style's
  single-target half and the spacing handles QUEUE a command; the host mounts
  `useSelectionModel` + `useInspectorCommit` only while one waits, runs it in
  a layout effect (so a canvas preview cleared inside it and the committed
  value paint together), then unmounts. One write-target rule, zero idle cost.
- **In-frame marquee (P5-E, IX-16, OD-6).** A press on the page ROOT itself
  (no child under the pointer) that travels 4 px sweeps a rectangle painted
  in the overlay root; it selects the touched layers at the shallowest hit
  depth (⌥ the deepest, ⇧ adds), live, and swallows the release's click.
  `useInFrameMarquee` (a capture listener on the frame document beside the
  body drag trigger), rules in `inFrameMarquee.ts`. ⌘-drag stays free move.
- **Alt-hover measurement (K5).** `MeasureLayer.tsx` + `canvasMeasureGeometry.ts`.
  With a selection and Alt held, hovering another node paints the distances
  between the two boxes and the hovered node's padding bands/content box — and
  with NOTHING hovered, the same drawing against the selection's parent (the
  nearest ancestor a multi-selection shares; P2-E / IX-19,
  `resolveMeasureTarget`) — into
  the SAME in-frame overlay root the rings use (parent-document fallback for a
  live/bridge frame, same `scoped`/`fixed` mode attribute the ring fallback
  uses). Mounted from `BreakpointSelectionOverlay` with one line; it owns its
  own Alt state and renders nothing until the gesture is live.
  - **The rule, per axis:** disjoint → ONE segment, the gap between facing
    edges; overlapping → TWO segments, the insets between same-side edges. So
    a measurement is 2–4 segments, not always 4. Containment (the usual case)
    gives all four. The distance is never negative — a selection that sticks
    out past the hovered box just produces a segment that runs backwards.
  - **Numbers are frame px, not screen px.** Segments are computed in the
    frame's own coordinates and only PROJECTED for painting
    (`CanvasOverlayMeasureSession.project`, the same arithmetic `measure`
    applies), so a pill never shows `px × zoom`.
  - **Geometry comes from `FrameDocumentAdapter.measure`** — one call per
    pass, both nodes, plus the four `padding-*` properties; that is the only
    measurement API a bridge frame has. ONE documented exception: in portal
    mode the RECTS come from `measureIframeLocalRect`, because the adapter
    returns body-relative rects while the in-frame rings are positioned from
    iframe-viewport-relative ones and the two differ by `body`'s margin. A
    measurement line that does not touch the ring it starts from reads as
    broken, so the layer follows the ring.
  - **Alt is shared with the tree ladder, and the split is one predicate.**
    `measurementWinsOverTreeLadder(selectedNodeIds, hoveredNodeId)`, called by
    BOTH `MeasureLayer` and `CanvasTreeLadderOverlay`: measurement wins while
    the pointer is over a node OUTSIDE the selection; the ladder wins over the
    selection itself and whenever nothing is selected (its behaviour there is
    completely unchanged). Both gestures fire immediately — there is no delay
    to sequence them with — so the split has to be by target, not by time.
    The no-hover parent fallback applies only while no node has been hovered
    during this Alt hold: once one has, the ladder is anchored on it, and the
    pointer leaving the frame is how the user reaches the ladder's rows.
    The ladder is SUPPRESSED (not merely hidden) while measurement owns Alt,
    which is what stops an Alt release from committing a new selection out
    from under the thing being measured. Both stand down during an inline
    text edit.
  - Appearance lives in `selectionChromeCss.ts` (`data-canvas-measure-*`,
    unlayered, tokens forwarded from the editor `:root`) for the in-frame
    path and `MeasureLayer.module.css` for the fallback. Keep the two in sync.
- **`canvasGesture.ts`** — a module-level "a pointer gesture is continuously
  mutating the page; hold every derived geometry until it ends" flag. Two
  subsystems recompute expensive geometry on layout change and are right to:
  the overlay's parent-document anchor session and `useIframeFrameAutoHeight`'s
  refit. An element resize changes layout on EVERY frame of a drag, which turns
  both "rare, expensive" paths into per-frame paths and makes the frame grow
  under the cursor. One settle pass runs when the gesture ends, because the
  layout finished changing while the observers were being ignored.
- **Overlay portal target.** `BreakpointSelectionOverlay` portals the toolbar,
  the in-place inspector and the tree ladder into the canvas root
  (`CanvasViewportActionsContext.canvasRootRef`), captured into state one rAF
  after mount — an ancestor's ref is not attached yet while a descendant's own
  layout effects run, so a single-commit mount cannot see it any earlier.
  While it is unresolved the chrome renders **nowhere**; it must never be
  parked in `document.body` "for now". React re-creates a portal's entire child
  subtree when the container identity changes, so a body→root relocation is a
  REMOUNT: it silently discards that chrome's own state. Measured back when
  "Insert module" opened a full-screen inserter dialog of its own: clicking it
  in that window opened the dialog, and the relocation closed it again a frame
  later (`open` reset to `false` on a fresh `CanvasInsertModuleButton`) with the
  click already consumed. That button now only reveals the Assets panel and
  holds no state, but the rule it proved is unchanged — focus inside the
  inspector is lost the same way. `document.body` remains the target only for
  frames with **no** viewport context at all (CMS/VC), where it is the answer
  from the first render and therefore never swaps. Consequence for tests: a
  harness that mounts the canvas root and the frame in the same commit gets the
  toolbar one frame later — `await screen.findByRole(…)`, not `getByRole`.

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
| A permanent rAF loop per mounted frame while anything is selected | `BreakpointSelectionOverlay.tsx` | **fixed (S4)** — `overlayMeasureScheduler.ts`, below |
| Frames mount all iframes once the doc is in the store | `CanvasTransformLayer.tsx` | virtualize iframe mounting; frozen poster for offscreen frames |
| Every on-screen frame's node-tree mount was its own `startTransition`, but React groups all pending transition lanes into ONE commit — ten frames committed together, 1.3–1.9 s after their shells | `IframeFrameSurface.tsx` | **fixed (perf-17)** — `frameTreeMountQueue.ts`, below |
| React re-render per pointermove during pan | `useCanvas.ts` | write `transform` to a ref, commit on pointerup |
| Every store `set()` runs every mounted `NodeRenderer`'s selectors; hover was a `set()` per crossing | `NodeRenderer.tsx`, `selectionSlice.ts` | **fixed (P2-I)** — hover is off the store, selection is a keyed read, see "Per-node reads" below |
| A poster rasterized under the user after every edit | `useFramePosterCapture.ts` | **fixed (P2-I)** — refresh only once the frame leaves the screen; the busy listeners run in every frame |
| A post-write re-read re-rendered every node of the page, remounted every renumbered node, and restyled every mounted frame | `lifecycleActions.ts` `patchPages`, `NodeRenderer.tsx` child keys, `ClassStyleInjector.tsx` | **fixed (P6-A, PERF-6)** — deep-equal nodes/rules keep their objects; moved nodes keep their React key (`nodeRenderKeys.ts`). See `editor-store.md`'s `patchPages` |

### Frame trees mount one at a time, centre first (perf-17)

`frameTreeMountQueue.ts` (`src/admin/pages/site/canvas/`) gates each frame's
node-tree `startTransition` behind a single module-scoped grant: only the
holder's tree renders; every other frame's shell sits mounted (header, body,
poster) but has not yet asked React to render its content. The holder releases
on commit or unmount, and the next grant goes to whichever waiting frame's
element is closest to the viewport centre right then (a pan while frames are
still queued re-orders what's left) — "the frame you are looking at" paints
first, not first-requested. No timer, no `rAF`, no idle-callback staging: a
grant is synchronous on request or release, so nothing can strand a frame as a
skeleton in a backgrounded tab or a headless runner (see the Hard rules note
in `PROJECT-BRIEF.md` about the RAF→setTimeout→requestIdleCallback chain this
repo already removed once for exactly that failure mode).

Companion fixes landed alongside it: concurrent `studio/load` requests for the
same project dedupe onto one in-flight promise (`studioLoadMemo.ts`), token
extraction memoizes on the parsed site rather than re-walking it per request
(`tokenExtractMemo.ts`), and `.studio/framework.json`/`fonts.json` writes are
skipped when the serialized value is byte-identical to what's on disk
(`writeStudioStoreJsonIfChanged` in `studioFramework.ts`) — every project open
was posting the token-extraction merge, which is a no-op once the framework is
populated, and rewrote the sidecar anyway.

Measured on the 40×300 corpus (`studio-board-load.e2e.ts`, warm open, first
frame painted): trunk (all ten visible frames committing together) 2695 /
2906 ms; queued one-at-a-time, several samples on the same shared machine,
2161 / 2216 / 2395 / 2908 ms. `BUDGET_WARM_FIRST_FRAME_MS` tightened from
6000 to 4000 (~20% over the worst observed "after" sample, rounded up for
headroom) — see the test file's own doc comment for the full numbers and why
a busy sample can erase the gain on its own; the ORDER assertion in the same
test (first frame paints alone, not together with the rest) is what actually
pins the mechanism regardless of machine noise.

### Per-node reads (P2-I) — what a `NodeRenderer` may subscribe to

`NodeRenderer` is mounted once per node per mounted frame (40 × 300 × 12 is
~3,600 instances), and Zustand runs every subscribed selector on every
`set()`. So each `useEditorStore(...)` in it is paid ~3,600 times per
keystroke, click and pan commit. The rules, gated by
`per-node-selector-budget.test.ts` (budget 7, no `useShallow`) and timed by
`bench:editor-store`'s subscriber sweep, a gate there (a breach fails the
bench). The sweep (`scripts/bench/lib/canvasSubscriberSweep.ts`) runs a COPY of
`NodeRenderer.tsx`'s selectors, so a change to one changes the other in the
same PR:

- **Hover is not store state.** `canvas/canvasHover.ts` holds it: keyed
  listeners (`useIsNodeHovered`, a Layers row) wake only the two ids a
  crossing involves; per-FRAME consumers (`useBreakpointOverlaySelectionState`,
  the tree ladder) use `useCanvasHoverSelect` with a primitive result. Store
  actions that drop the selection (`clearCanvasSelectionDraft`, a reparse's
  follow, arming Play) call `clearCanvasHover`/`followCanvasHover`.
  `NodeRenderer` never reads hover — the ring is the overlay's.
- **Selection is a keyed read.** `useIsNodeSelected` (`canvasNodeSelection.ts`)
  — one store listener diffs old vs new `selectedNodeIds`/`selectedNodeFrameId`
  and wakes only the ids whose answer changed.
- **Every selector returns a primitive or an existing reference.** No
  object literals; values constant for a session (`activeInlineEdit`'s
  `initialValue`/`multiline`) and store actions are read through `getState()`
  where they are used.

- **The `CanvasSelectionContext` value never changes identity.** Every
  `NodeRenderer` consumes it, and `CanvasRoot` re-renders on every selection.
  `useCanvasNodeInteraction` returns a facade created once that calls the
  latest handlers through a ref. Before P2-I the object was rebuilt per render
  (the React Compiler cannot keep closures over changing options stable), so
  EVERY click re-rendered all ~2,800 mounted nodes. A new context read in
  `NodeRenderer` has to meet the same bar.

Measured (40 × 300 × 12, medians): a hover crossing 8–16 ms → 0.000 ms of
store work; `selectNode` ~21 → 6–10 ms; a keystroke ~23 → 7–12 ms; a pan
commit ~16 → 4.7 ms. In a browser (`canvas-feel-budgets.e2e.ts`, dev build):
the hover sweep's worst frame went 169–183 → 21–30 ms, and a warm click to a
painted ring 292–440 → 78–85 ms (`NodeRenderer` renders per click: 2,799 → 2).
Stubbing out the Properties and Layers panels moved click-to-ring by nothing
measurable, so the inspector is NOT on that path (PERF-14's hypothesis) — do
not defer it for the ring's sake.

`frameVirtualization.ts` already exists and is used by `BoardFramesLayer`:
`isFrameOnScreen(frameRect, viewportState, marginPx)` — pure board→screen math,
one extra screen of margin so panning doesn't pop frames. **Its own board→screen
formula deliberately omits `CanvasTransformLayer`'s 80px `top`/`left` offset**
(harmless there — a 600px culling margin absorbs it) — do not copy it for
anything that needs to be pixel-exact (a ruler tick, a measurement HUD); see
`CanvasRulers/rulerGeometry.ts` for the corrected formula and why.

### What a click and a keystroke re-render (P6-C)

`canvas-edit-budgets.e2e.ts` and `canvas-feel-budgets.e2e.ts` put numbers on a
click and a keystroke on the 40 × 300 board; `tests/e2e/helpers/reactRenderCounter.ts`
counts which components rendered (a minimal DevTools hook — no product code).
What it found, and the rule each finding became:

- **An action hook reads state when it acts, never subscribes to it.**
  `useInsertModule`, `useInsertInserterItem` and `useCanvasInsertionDrag`
  subscribed to the selection and the active page — values they read only when
  something is inserted — so every panel that offers insertion (the Assets
  panel: 46 cards, ~130 buttons and tooltips) re-rendered on every click and
  every keystroke. They read `useEditorStore.getState()` at call time now;
  `useModuleInsertionContext` subscribes to four primitives. Gated by
  `assetsPanelRenderScope.test.tsx`.
- **A store write that changes nothing notifies nobody** (`store/skipUnchangedSets.ts`).
  An object partial always made a new state object, so `set({ focusedPanel })`
  with the current value swept every mounted `NodeRenderer`'s selectors — a
  canvas click made two such writes, ~8–10 ms each in production.
- **Per-frame chrome reads per-frame answers.** Every mounted frame runs
  `BreakpointSelectionOverlay`, `ClassStyleInjector` and the tree-ladder hook.
  The ladder reads the active page (a new object after every keystroke) only
  while Alt is held — subscribed unconditionally it re-rendered all 9 frames'
  chrome per keystroke (measured 9 → 0). The forced-state preview is its own
  component, scoped to the frame that renders the selected node
  (`ClassStyleInjector` renders per click 9 → 0).
- **An overlay write that changes nothing is skipped** (`PortalFrameAdapter.applyOverlay`):
  reassigning a `<style>`'s text re-parses it and invalidates style for the
  whole frame document even when the text is identical. Measured: 3 identical
  rewrites per keystroke → 0.
- **Every canvas, UI-primitive and inspector function must actually be
  compiled.** The React Compiler silently skips a function it cannot lower and
  nothing fails. `CanvasRoot` was skipped, so its context values were rebuilt
  on every render and every frame's selection chrome re-rendered on every
  click and keystroke. The biggest cause was the toolchain: compiler 1.0 on the
  root Babel 8 rejects every destructured default, so the compiler now runs on
  its own Babel 7 (`scripts/vite/reactCompilerPlugin.ts`). The rest are
  constructs it cannot lower (`try … finally`, a logical/ternary/loop inside
  `try`, `??=`, `++` on a captured variable, `import()`, a ref touched in
  render). `react-compiler-bailouts.test.ts` compiles `canvas/`, `src/ui/components`,
  `inspector/`, `panels/PropertiesPanel` and `property-controls/` through the
  exact Vite transform and fails naming each skipped function and the rewrite;
  `bun run compiler:bailouts` lists what is left in the rest of `src/`.
  `NodeRenderer` is `memo(NodeRenderer)` over a plain declaration: inside
  `memo(function NodeRenderer …)` the recursion bound to the unwrapped function,
  so no child had the memo bailout and the compiler skipped the renderer.

Measured on the 40 × 300 board (dev build / production bundle,
`E2E_VITE_MODE=preview`): warm click → ring (mean) 144 → 75 ms / 61.6 → 47.1 ms;
inspector keystroke → canvas paint (median) 115 → 42 ms / 32 → 26 ms; cold
click → ring 253 → 216 ms / 109 → 69 ms. WS-5.6's 32 ms click target is **not
met** in production; `canvas-feel-budgets.e2e.ts`'s warm-click docblock lists
what is left in a click.

### Mounting a frame (S1) — what a mount actually costs, measured

`perf-01` recorded "a zoom that mounts frames costs 290–337 ms in one frame"
and blamed "one `BreakpointFrame` mount is 100–140 ms". **A CPU profile of the
same gesture says otherwise**, and the difference is the whole point: the long
animation frames during a zoom-out admit **zero** new iframes. Creating an
iframe is ~12 ms. What costs is everything that happens to a document *after*
it exists, and two of the three biggest items were not the node tree at all:

| Cost, per mounting frame | Where | What it is now |
|---|---|---|
| ~85–350 ms per **poster** (880–1,160 ms on a 310-element frame), in a burst | `useFramePosterCapture` → `html-to-image` | queued: `framePosterQueue.ts` holds every capture until the board is quiet, then runs them one per macrotask; since P2-I only off-screen pooled frames are captured |
| ~10 ms | `CanvasHoverSuppressionInjector` walking all four content sheets' CSSOM | a per-sheet-text rewrite **plan**, built once and applied by index in every other frame |
| ~7 ms | `ProjectCssInjector` assigning `textContent` — the browser parsing vendor CSS into a new document | unchanged; only an iframe **pool** can avoid it, see below |
| ~5 ms | `collectScrollDeficits` (`@core/studio-runtime`'s `frameFitRules.ts`) forced layout | unchanged |
| ~5 ms | `CanvasScrollUnrollInjector`'s `snapshotAuthoredStyles` + unroll pass | unchanged |

`IframeFrameSurface` therefore mounts in **three commits**: the `<iframe
srcDoc>` alone, then the injector chain once `contentDocument` exists, then the
node tree in a `startTransition`. Stage 3's commit is published two ways from
ONE state (`treeMounted`): `onContentReadyChange`, which `BoardFrameView` uses
to keep the frozen poster painted over the iframe until the tree lands, and
`data-studio-canvas-content-ready` on the iframe element, for callers that hold
only DOM. The agent's frame selection (`agent/renderEvidence.ts`) is the second
kind: **a loaded document is not a mounted frame**, and without that gate a
`'visible'` capture — `studio_export_frames`, most of all — rasterises a blank
page and reports zero nodes.

**`startTransition`, never an rAF/`setTimeout`/`requestIdleCallback` chain.**
That distinction is why this is not the staging chain a predecessor removed: a
transition always runs (it may only yield to a higher-priority update), whereas
`rAF` never fires in a backgrounded tab or a headless runner and could strand a
frame as a skeleton forever.

**`interaction === 'capture'` does not stage at all.** Staging buys smoothness
when MANY board frames mount inside one gesture. `AgentSnapshotFrame`'s frame is
exactly one, offscreen, `inert`, mounted on demand, with a tool call already
blocked on its tree — there is nothing to yield to, and yielding lets React
leave that one commit behind whatever else the editor is doing (an agent turn
streams store updates continuously). Measured: staged, the transient frame's
body held **0 children for the whole 5 s `waitForAgentRenderFrame` window** and
the capture failed with "did not become ready".

### `framePool.ts` — the ONE module that answers "is frame X mounted, and why"

**Leaving the viewport no longer throws a document away.** A departed frame
stays mounted while the pool has room, evicted least-recently-on-screen, so
panning back to where you just were costs nothing. The cap is a memory ceiling,
not a target: each live frame is a whole document with its own copy of every
stylesheet.

There were two pools until `perf-9` merged them — S1's `frameMountPool.ts` for
portal frames and L8 Phase B's `liveFramePool.ts` for Tier-2 live frames. They
ran the same algorithm and differed only in budget, `BoardFramesLayer` computed
both on every render and threw one away, and `BoardFrameView` re-derived which
applied from the trust tier (`isLiveMounted ?? isMounted ?? isOnScreen`). Now
there is one policy, parameterised by what a frame **costs**:

| `FrameMountCost` | A mounted frame is | Budget |
|---|---|---|
| `'portal'` (Tier 0/1, and Tier 2 until its dev server is ready) | one same-origin `srcDoc` iframe, ~12 ms to create | `max(8, onScreen + 4)` — a floor with headroom |
| `'live'` (Tier 2, dev server ready) | `LiveBoardFrame`: a cross-origin bridge iframe against a real dev-server process (plus its fallback until that frame reports ready) — measured ~0.85 MB of heap, one document and ~110 DOM nodes per small frame (`docs/audits/2026-09-13-live-frame-memory-baseline.md`) | `max(onScreen, 8)` — a ceiling only the visible set may exceed |

The cost is derived from the trust tier **and the dev server's readiness** in
`BoardFramesLayer` and **nowhere else**; the tier no longer reaches mounting at
all. One retention list, one `useState`, one budget per render. A trust change,
or the dev server coming up, is part of the retention key, so the pool resizes
without a pan.

**Why readiness and not just the tier (P6-C).** Until its dev server is ready
a Tier-2 frame IS its same-origin fallback (the bridge iframe has nothing to
load), and the portal headroom is the only window in which a departed frame
can be rasterized into its poster — capture runs only for a frame that is off
screen and still pooled (P2-I). Under the live budget a frame leaving a full
screen was evicted on the spot, so a Tier-2 board whose server was booting,
failed or could not start (no `node_modules`) never got a poster: `perf-01`
read 0/4. And `LiveBoardFrame` paints a cached poster OVER its clickable
fallback until the fallback's tree commits — never INSTEAD of it; it used to
replace it, so a frame panned away from and back to became a picture nothing
could select until the server reported ready.

`resolveFrameMount({ isOnScreen, isPooled })` is the single per-frame answer,
returning `{ mounted, reason }` where `reason` is `on-screen` / `pooled` /
`offscreen`. `BoardFrameView` stamps it on the frame element as
**`data-frame-mount`**, so the answer is legible from the DOM — to
`src/__tests__/canvas/framePoolMountReason.test.tsx` (which asserts the mounted
count against `framePoolBudget` at every step of a scripted pan across a
24-frame board, for both costs), to `agentRenderFrameMountReason` in
`agent/renderEvidence.ts` (so a timed-out `studio_export_frames` says whether
the frame was never pooled or was mounted-but-not-ready), and to a human
dogfooding a pan with devtools open.

`isPooled` — and `BoardFrameView`'s `isMounted` prop — are **optional**, and
must stay that way: a caller outside `BoardFramesLayer` means "mounted exactly
while visible", and making it required silently renders nothing at all for
every such caller with no `tsc` error (`meta-14` landmine 1;
`boardFrameViewTierFork.test.tsx` is the gate). `isOnScreen` stays a separate
prop because it drives poster CAPTURE — since P2-I (PERF-5) the picture is
taken only while the frame is OFF screen and still pooled (`framePosterNeeded`
in `useFramePosterCapture.ts`), never while the user is looking at it. A capture
was measured at 880–1,160 ms of main thread per 310-element frame; the old rule
("on screen, no poster for this `Page` object") rasterized every visible frame
the first time the board went quiet and the edited frame after every edit. A
frame evicted before the board went quiet shows the plain title placeholder.
`framePosterQueue`'s busy listeners run in every mounted frame document too
(portal: DOM listeners; bridge: the adapter's `pointer`/`wheel`/`key` events),
so a press inside a frame holds the queue. Each capture records a
`studio:poster-capture` User Timing measure.

Measured, 18-frame stand-in board, dev build, same Playwright runner
`tests/e2e/studio-board-perf.e2e.ts` uses:

| | before | after |
|---|---|---|
| zoom-out admitting 12–14 frames — worst animation frame | 350 / 354 / 375 ms | 195 / 198 / 200 ms |
| the same gesture — mean frame | 41 / 46 / 44 ms | 22 / 21 / 21 ms |
| pan churning 3–6 frames out and back — worst frame | 148 ms | 50 / 92 / 53 ms |
| the same pan — frames over 50 ms | 13 | 5 / 1 / 2 |

**Two known, deliberately-unshipped levers**, both in the S1 `STATE.md` entry:
a *literal* iframe pool that re-points a parked document at a new frame (needs
the CSS injectors to stop removing their `<style>` element on cleanup and to
skip an identical `textContent` write — otherwise a reused document re-parses
everything and the pool buys nothing), and zoom-aware virtualization (do not
mount a live document for a frame rendering 100 px wide). The second is a
product decision, not a perf one: a poster is a stale picture, so a frame whose
page was just edited would show a blank title card instead of live content.

**Never** add a full-site scan inside a `useEditorStore(selector)` callback.

### The selection overlay measures on events, not every frame (S4)

`BreakpointSelectionOverlay` used to arm an uncapped rAF loop whenever
`hasOverlayWork` was true — i.e. forever while anything was selected or
hovered, **per mounted frame**. Eight frames and one selected node meant eight
60 Hz loops over a canvas nobody was touching, which is enough to keep the main
thread from ever sleeping and to undo what frame virtualization buys.

`overlayMeasureScheduler.ts` now owns *when* the overlay measures. The component
owns *what* a pass costs (unchanged: cheap in-iframe rects every pass, the
zoom-converting parent-doc anchor only when `anchorDirtyRef` is set).

A per-frame loop is armed **only** while something moves the geometry on every
frame and no event can fire per frame:

| Continuous reason | Signal |
|---|---|
| element resize drag | `canvasGesture.ts` → `onCanvasGestureChange` (new: the begin edge, not only `onCanvasGestureSettle`) |
| reorder drag, animation replay | render state the component already holds (`reorderDrag.dragging`, `animationScrubStore`'s `'playing'`), passed in as `continuous` |
| pan / zoom — **only for rings painted in the PARENT document** (`ringsFollowViewport: false`: the startup window before the in-frame overlay root exists, a live frame's fallback) | `canvasViewportActivity.ts` → `onCanvasViewportActivityChange`, marked from `useCanvas`'s `applyTransformToDOM` |
| a bridge frame's DOM swap | the adapter's `hmr:before` → `hmr:after`, capped at 2 s |

Everything else schedules **one** coalesced pass: a `ResizeObserver` on the
frame body/root **and on each tracked element** (a late-loading image resizes an
element without mutating the DOM or the body), a `MutationObserver` over the
frame document, capture-phase `scroll` inside the frame, the adapter's
`frame:resize` (bridge mode's only signal — its document is unreachable), a
parent-window resize (which also invalidates the anchor), and the component's
own effects for selection change, the committed pan/zoom, and a **hover target**
change.

Four things are easy to get wrong here:

- **A tracked-target change that mutates no page DOM is invisible to every
  observer.** Hover moving straight from one node to another (body → main → an
  icon) writes only to the ring, and the mutation observer filters that as
  chrome, so the hover ring kept the FIRST node's box under the new id until
  the hover-target effect existed (`breakpointOverlayHoverRingFollowsTarget.test.tsx`).
  Any new input that retargets a ring must call `schedule()` itself.
- **`transformRef` cannot tell you a pan STARTED.** It is mutated in place and
  never changes identity, so the only way to learn from it is to poll — the
  loop this work order deleted. That is why `canvasViewportActivity.ts` exists,
  and why it is a *separate* flag from `canvasGesture.ts`: a pan mutates
  nothing and must not freeze the auto-height refit the way a page-mutating
  gesture does.
- **The mutation observer must skip the selection chrome.** The overlay writes
  inline styles onto its own rings inside the observed document; counting those
  as "the page changed" makes every pass schedule another one. It uses the ONE
  shared predicate, `isSelectionChromeMutation` — see "Selection chrome is not
  page content" below.
- **`BreakpointSelectionOverlay` is a SIBLING of the frame surface**, not a
  descendant, so it cannot read `CanvasFrameAdapterContext`. It resolves the
  adapter from the registry by iframe element and re-resolves on
  `onFrameAdapterRegistryChange`, because either effect may run first.

Gates: `overlayMeasureScheduler.test.ts` (fake rAF — idle board with a
selection runs 0 passes) and `overlayRafDiscipline.test.ts` (source shape: the
component keeps exactly one `requestAnimationFrame` call, the one-shot
portal-root read).

### Selection chrome is not page content, and a pan measures nothing (P2-A)

Four things in this area were fixed together by P2-A (audit `01-perf.md`
PERF-2/3/4/9/10/11/13); each has a regression test that failed before it, and
`tests/e2e/canvas-feel-budgets.e2e.ts` measures them on a generated 40-frame ×
~300-element board (`tests/e2e/helpers/largeBoardCorpus.ts`).

- **`isSelectionChromeMutation(record)`** (`@core/studio-runtime`,
  `selectionChromeMutation.ts`) is the ONE answer to "is this DOM mutation the
  editor's own rings/badge/handles/measure layer, or the page?". Used by all
  four frame observers: the portal auto-height refit
  (`frameFitMutationScheduler`), the scroll-unroll pass (`startScrollUnroll`),
  `overlayMeasureScheduler`, and the live runtime's layout observer. Before,
  only the last two filtered chrome, so a hover ring mounting under `<body>`
  re-ran the frame's two full-document forced layouts. A new observer on a
  frame document must use it too.
- **The hover ring stays mounted.** `CanvasSelectionChrome` renders it whenever
  rings are shown; `BreakpointSelectionOverlay` hides it with a style write
  (`hideOverlayElement`, in a layout effect) when hover ends. Hover start/end
  is an attribute change, never a `childList` one. Selection rings are still
  keyed per id (a selection change is rare next to hover); the predicate
  covers them.
- **`frameFitMutationScheduler` lives in `@core/studio-runtime`** and is the
  live runtime's too (PERF-9): attribute-only batches never reset a fit (a
  JS-animated app writes `style` every frame), text debounces, and structure
  settles immediately in a portal frame but after a 250 ms trailing debounce
  in a live one.
- **The toolbar and in-place inspector follow a pan/zoom arithmetically**
  (PERF-3, `selectionChromeViewportFollow.ts`). Each measured anchor pass
  records the rects plus the transform they were measured under; every
  transform write (`onCanvasViewportTransform`, a second signal on
  `canvasViewportActivity.ts`, fired synchronously from `applyTransformToDOM`
  AFTER the DOM write) re-projects them through `rulerGeometry.ts`'s
  `.canvas`-relative formula. No layout read — the clamp widths are read once,
  at record time. Rings inside a frame move with its transform for free, so
  `overlayMeasureScheduler` arms NO loop for a pan over an in-frame overlay
  (`ringsFollowViewport`), only one settle pass when it ends. Bridge frames get
  the same follower through `useBridgeSelectionChrome`'s `recordAnchor`.
  Known limit: during a discrete zoom's CSS transition (`data-animating`,
  `ANIMATED_TRANSFORM_MS`) the chrome jumps to the final position while the
  frames glide; the settle pass reconciles.
- **The rulers do not loop** (PERF-4). They repaint on every transform write,
  a `ResizeObserver` on their length source, an origin change and a window
  resize. An idle board with a selection now runs **0** `requestAnimationFrame`
  calls per second (was ~121 — the two ruler loops).
- **`PortalFrameAdapter` arms its ring-tracking observer lazily** (PERF-10), on
  the first `select`/`hover` — which portal mode never calls, because its
  rings are the overlay's own portal.
- **A frame-less selection or hover is scoped to the frames whose page holds
  the node** (PERF-13, `idsRenderedByFramePage` in
  `useBreakpointOverlaySelectionState.ts`, via `_nodeIdToPageIds`). A
  Layers-panel row used to arm rings, an inspector wrapper and a measure
  scheduler in every mounted frame. The CMS/VC canvas (no page context) and
  ids the index does not know are left unscoped.

**Frame-invariant work belongs in a cross-frame memo, not in the injector.**
Every mounted iframe runs its injectors in the same commit over the same store
snapshot, so anything that does not depend on the frame is being paid N times
for one answer. The three that do this now, and the pattern to copy:

| Module | Memo shape | What varies per frame |
|---|---|---|
| `canvasClassCss.ts` — `generateCanvasClassCSS` | single-slot identity memo over 9 inputs | nothing |
| `canvasClassCss.ts` — `generateNodeClassCSS` / `nodeClassBackgroundImagePaths` | shared inputs identity-compared, then a `Map` keyed by the node's `classIds` signature | which NODE is asking |
| `canvasVendorCss.ts` | single-slot memo on `projectVendorCss` | nothing |
| `canvasUserStylesheetCss.ts` | two stages: `(site, scopeId, scopeTemplate)` → `Map` by viewport | the viewport-unit resolution, and only by frame **width** |

The `generateNodeClassCSS` pair is the sandboxed-module path (S3):
`ModuleSandboxFrame` renders each module into its own `srcdoc` iframe that no
canvas injector reaches, so it needs a self-contained CSS string built from
just its node's own rules. It used to select the whole `s.site` and run
`collectSiteStyleBackgroundImagePaths` + `generateClassCSS` **in its render
body**, per module instance, on every store change; it now subscribes to
`s.site?.styleRules` / `.breakpoints` / `.conditions` and reads through these
memos. The key is a `classIds` signature rather than a single slot because two
sandboxed modules on one page is the common case, and a single slot would miss
on every alternating call. **`styleRuleNeedsCanvasOverlay`'s filter does not
apply here** — there is no `AuthoredCssInjector` raw text inside a sandbox
document, so an unedited imported rule must be emitted or it is simply absent.
`admin/pages/site/canvas/` is now in the covered set of
`no-full-site-scan-in-selectors.test.ts`'s whole-`site` detector, so the old
shape cannot come back.

`canvasUserStylesheetCss.ts` also **reorders** the chain
(`collect → resolveAssets → rewritePrefersColorScheme → resolveViewportUnits`;
`resolveAssets` is `canvasFrameCss.ts`'s asset-URL pass, P5-B2) so the
frame-invariant half comes first. The two transforms commute — the resolver
touches only `<number><viewport-unit>` tokens in declarations, the rewrite
touches only selectors and the `@media` prelude — verified byte-for-byte over
every `.css` file in `studio-workspace/`. **The reorder alone buys ~0.05 ms;
the win is what it makes cacheable.**

`selectCanvasPageFor` is the other per-node path worth knowing: **both** its
lookups (`pageId → Page`, `frameId → axes.locale`) are memoised, and the
locale branch is skipped entirely while `s.localizedPages` is empty. Any new
branch there must arrive with its own memo — see `PROJECT-BRIEF.md` trap #11.

`useCanvas()` returns `transformRef: RefObject<CanvasTransform>` — the LIVE
transform, mutated in place every rAF tick during a gesture, up to 100ms
AHEAD of the store's own debounced `zoom`/`panX`/`panY`. This is a published,
shared contract (`CanvasViewportActionsContext` carries it too, for consumers
that aren't direct children of `CanvasRoot`): anything that must track
pan/zoom live — `CanvasRulers`, D2's drag/drop, a future measurement HUD —
reads this ref, never the store selector, during an active gesture. See
`docs/features/canvas-rulers-and-guides.md`. **The ref answers "what is the
transform"; it cannot answer "is a gesture running"** — it never changes
identity, so detecting a gesture from it means polling. For that, subscribe to
`canvasViewportActivity.ts` (S4), which `applyTransformToDOM` marks on every
write. The element drag
(`useCanvasReorderDrag`) is one such consumer: its `frameCandidateIndex`
compares the transform it measured its viewport origin under against this
ref, and re-reads the origin only when they differ — which is how auto-pan
stays correct without a `getBoundingClientRect()` per frame.

**A canvas gesture measures once and paints imperatively.** The element drag
(S2) does zero forced layout reads and zero React commits PER POINTERMOVE:
`canvasDragSession.ts` holds the measurements, `canvasDragPainter.ts` writes
the indicator/ghost into a React-rendered but never-React-populated layer, and
the store is written exactly once, on release. React commits twice per
gesture, at its two edges (`dragging` on at activation, off at release) —
that flag is state rather than a ref because the overlay's measurement
scheduler renders from it. The same shape as `useElementResizeDrag`'s
one-write-per-rAF coalescing, extended with the measurement half a hit-test
needs, and it takes the same `canvasGesture` freeze — here to stop the frame's
auto-height refit reflowing the page under a stationary pointer and
invalidating the candidate index. Full contract:
`docs/reference/canvas-dnd.md` → "The drag session (S2)".

**⌘-drag is the ONE gesture allowed to write a position (K6).** It writes
the offsets the source authored (P5-E, IX-21: a `right`-anchored layer keeps
`right`), or `left`/`top` — `inset-inline-start` under `direction: rtl` — for a
layer that becomes absolute in the gesture, as an inline style on one element, plus `position: absolute` when the element was in flow
(without it the offsets do nothing, and a declaration with no effect is a
silent no-op). It **refuses** when the container is `position: static`,
because absolute positioning there hands the element to a different ancestor
than the one it was dropped in; the refusal carries a one-click "make the
container `position: relative`" remedy. Studio still does not fake absolute
placement — an ordinary drag is still a reorder. It snaps to its siblings
and its parent's padding / content box at the screen-px threshold
(`snapThresholdAtZoom`, P2-E), to the board's ruler guides converted into the
frame's space (P5-F, IX-5c, `guideLinesInSpace`), and to equal spacing with
pink distance pills (IX-5d, `snapSpacing.ts`); the ⇧ axis lock leaves the
held axis unsnapped. A multi-selection moves together (IX-22): every dragged
layer is a member of one plan, all move by one snapped delta computed on the
UNION box against the peers that are not moving, and the commit is one
`setNodesInlineStylesPerNode`. All or nothing — a flow layer in the selection
without ⌘ makes the whole gesture a reorder. See
`docs/reference/canvas-dnd.md` → "Free movement (K6)".

**Chrome outside `CanvasRoot` reaches the canvas through the store, not the
context.** The toolbar is painted eagerly by `AdminCanvasLayout`, *above* the
lazy boundary that mounts the editor body — so `ZoomControls` can never be a
descendant of `CanvasViewportActionsContext`'s provider, and that context's
value is built from refs that only exist after the canvas mounts. `CanvasRoot`
therefore publishes its three DOM-measuring viewport gestures (fit / fill /
selection) to the store as `canvasViewportCommands` while it is mounted in
design mode, and retracts them (`null`) on unmount and in live mode.
`null` disables the toolbar's Fit control instead of letting it no-op. The
gesture BODIES stay in `useCanvas` because they need `transformRef` above;
only the measurement is shared (`canvas/canvasViewportCommands.ts`).

### Cold selection on a Tier-2 board: one overlay per board frame, not two (`speed-04`)

Before this fix, `LiveBoardFrame` mounted its Tier-0 fallback `BreakpointFrame`
**and** its hidden bridge `BreakpointFrame` at the same time (by design — the
bridge's cold boot runs concurrently with the visible fallback), and **both**
unconditionally mounted their own `BreakpointSelectionOverlay`. A click on the
fallback (the only interactive surface before the bridge reports `ready`)
selected a node in the store; both overlay instances reacted to it — the
fallback's real, working `tickOnce` AND the bridge overlay's
`useBridgeSelectionChrome`, which opened a real `postMessage` round trip
(`select`/`hover`/`setResizeTarget`/`measure`) into a still-loading
cross-origin document and rendered a **second**, independently-positioned
toolbar and in-place inspector for the very same selection — not just wasted
work, a real double-toolbar correctness bug on every Tier-2 board frame's
first click.

Fix: `BreakpointFrame` grew an `overlayEnabled?: boolean` prop (default
`true`, every existing caller unaffected). `LiveBoardFrame` passes
`overlayEnabled={ready}` to its bridge `BreakpointFrame` — the iframe still
mounts and boots (concurrency untouched), only its OWN
`BreakpointSelectionOverlay` is deferred until `ready`, which is also the
exact commit the fallback unmounts in, so the two are never both live. See
`BreakpointFrame.tsx`'s `overlayEnabled` doc and `liveBoardFrame.test.tsx`'s
`describe('LiveBoardFrame — selection chrome while not ready (speed-04)')`.

A second, smaller fix rides in `tickOnce`'s anchor branch (`needsAnchor` —
the toolbar/inspector's expensive parent-doc `createCanvasOverlayMeasureSession`
path, two forced `getBoundingClientRect()` reads): a frame whose own ring
placements show it owns NONE of the selected nodes (every `elementCache.resolve`
came back `null` — not present in this frame's iframe document) now skips
session creation entirely rather than creating one that would only ever
measure `null`. For a board frame this mostly restates what `selectedNodeFrameId`
scoping (WS-10 Phase 2) already gives for free — a non-owning board frame's
`selectedNodeIds` is already `EMPTY_SELECTED_NODE_IDS`, so its `tickOnce`
never even runs — but the CMS/Visual-Component canvas mirrors one selection
across every real breakpoint frame on purpose, and that is exactly the case
where more than one frame reaches the anchor branch for a selection only one
of them actually renders. See `breakpointSelectionOverlayAnchorSkip.test.tsx`.

`BreakpointSelectionOverlay.tsx` also shed its top-of-component store reads
(selection/hover scoping, the selector-affinity highlight, this frame's page,
the VC list) into `useBreakpointOverlaySelectionState.ts` — a
`module-size-budgets` extraction (the file was at the 700-line ceiling before
either fix above), not a behavior change: eight independent `useEditorStore`
reads with no refs and no effects, the same shape `useCanvasAnimationScrub`
already uses for a component-local slice of store state.

**What did NOT change, and why.** The plan's own cause list also named
"cache the iframe and canvas-root rects per pan/zoom commit and per
`frame:resize` instead of re-measuring per selection." Not implemented:
`iframe.getBoundingClientRect()` can change for reasons OTHER than a pan/zoom
commit or a bridge `frame:resize` — an auto-height fallback iframe whose
content just grew, or the canvas root itself resizing because the very
selection being anchored opened a side panel — and caching across those
triggers would silently reintroduce `standing-03`'s exact class of bug (a
stale term in the anchor math, multiplied by zoom). The two forced reads this
session pays are cheap (`canvasOverlayMeasurement.test.ts` already proves ONE
session reads geometry once no matter how many rings it measures); the real
cost was paying for a session AT ALL on a frame that owns nothing, which the
skip above already removes. Do not add this cache without a measured number
showing the remaining per-selection cost is real on a frame that DOES own the
node — "never skip a measurement that height correctness depends on."

Budget: `tests/e2e/studio-board-perf.e2e.ts`'s `speed-04` describe block —
click → selection ring, cold, on `__board-perf-fixture` (Tier-2 by default,
no `node_modules`, so its bridge iframe never reports `ready` inside a test
run — the fallback stays the only interactive surface for the whole run,
which is exactly the "just opened" window this budget targets). Calibrated
under heavy shared-machine contention, not the plan's own 100ms target — see
that constant's own doc for the real before/after numbers and why the
recorded budget is looser.



- Canvas DOM is inside iframes: `document.querySelector('[data-node-id]')`
  returns `null`. Use `src/__tests__/canvas/iframeCanvasQuery.ts`.
- `src/__tests__/setup.ts` patches `HTMLIFrameElement.prototype.contentDocument`
  so iframe realms get the parent's built-ins. Test-env only.
- happy-dom needs `GlobalWindow` (not `Window`) for CSS parsing — only
  `GlobalWindow` puts JS built-ins on the window object.
- **`MutationObserver` used to die on a GC.** happy-dom holds each observation's
  callback in a `WeakRef` that nothing else references, so once Bun collected it
  the observer stayed "connected" and simply never fired again (`takeRecords()`
  → `[]`). Any injector that attaches its observer in a mount effect and is then
  exercised seconds later — `CanvasScrollUnrollInjector`,
  `useIframeFrameAutoHeight` — looked broken and was not. `src/__tests__/setup.ts`
  pins the derefed callbacks in a `WeakMap` keyed by the observer, patched on
  happy-dom's shared implementation class so every iframe window inherits it.

---

## Agent screenshots

`AgentSnapshotFrame` renders one offscreen frame at a configured width through
the same iframe/injector/tree path as the editor, waits on a revisioned
readiness tracker (preview rows, loop data, media, fonts, React settling, image
embedding), captures, and unmounts. It never changes the visible canvas state,
never runs authored runtime scripts, and sits **offscreen** rather than
`display:none` so it has real layout geometry.

**The headless capture page renders the same module set, from a different
bundle.** `/admin/agent-capture` (`src/admin/agentCapture/`) is a second Vite
HTML entry, so it inherits none of the editor's imports — and `NodeRenderer`
resolves every node through the GLOBAL module registry. When the two entries
kept independent lists, the editor rendered a design-system page correctly
while its PNG export came back full of `Unknown module: alm.Button`. The set
now lives once, in `src/admin/pages/site/studio/canvasModuleSet.ts`: built-in
packs as import side effects, plus `mountCanvasModuleSet(dir)` for the
project's own `pkg.*` components (trust-gated on the server, so both surfaces
get the identical Tier-0 outcome without either re-implementing the check).
Because a capture frame is photographed exactly ONCE — an editor frame just
re-renders through `registry.subscribe` when a module lands late — that
registration is a bounded settle phase (`modules`) in
`canvasCaptureSettle.ts`, warning and photographing anyway if the bundle never
arrives. Adding a pack to the canvas is one line in `canvasModuleSet.ts`;
gated by `src/__tests__/canvas/captureCanvasModuleSet.test.tsx`.

### A Tier 2 bridge frame: what crosses the wire, and who consumes it (`live-12`, `live-13`)

A `LiveBoardFrame` renders the user's real app in a cross-origin iframe served
by the live origin (`/p/<projectKey>/…`). Nothing in it is Studio's React
tree, so none of the portal-frame mechanics apply: `NodeRenderer`'s click
handlers, `BoardFrameView`'s activate-on-capture, `useIframeEventForwarding`'s
cloned wheel. Everything the board learns about a bridge frame arrives as a
`postMessage` from the in-frame runtime (`@core/studio-runtime`), validated by
`BridgeFrameAdapter`, and — as of `live-12`/`live-13` — consumed by
`useBridgeFrameInteraction` and `useBridgeSelectionChrome` on the parent:

| Runtime message | In-frame source (`gestureForwarding.ts`) | Parent consumer |
|---|---|---|
| `pointer` (`down`/`move`/`up`/`click`, with the hit's stamped id **and its stamped ancestor chain**, plus `button`/`buttons`/`pointerId`/`pointerType`) | capture-phase document listeners, both modes; never for the runtime's own chrome; `move` is coalesced (`speed-03`, see below) | `useBridgeFrameInteraction` → a PAN press (`shouldStartCanvasPointerPan`: middle button, or primary with Space/hand tool) is replayed on the iframe element as a real `PointerEvent` with its moves and release, and the click after it dropped; otherwise activates the frame's page if inactive, then the same `CanvasSelectionContext` handlers `NodeRenderer` calls (`onFrameNodeClick`, `onNodeHover`, `onNodePointerDown/Up`) — a click or hover target inside a closed `studio.instance` first resolved to the OUTERMOST closed instance, as `NodeRenderer` does (P2-B) |
| `wheel` (design mode only; the frame's own scroll is cancelled) | same listeners | re-dispatched as a `WheelEvent` on the iframe element in parent client pixels, so it bubbles to the canvas root like a portal frame's |
| `resize:commit` (`{ width?, height?, left?, insetInlineStart?, top? }` as integer `px` strings, offsets may be negative; plus the Fixed companions `flex: '0 1 auto' | null`, `alignSelf: null`, `justifySelf: null` — `null` clears; no other key passes the schema, canvas-23) | `resizeHandles.ts` — a finished drag on the in-frame handles | `useBridgeFrameInteraction` → `setNodeInlineStyles`, the one write `useElementResizeDrag` makes for a portal frame |
| `resize:guides` (canvas-26; at most one guide per axis, frame-document px, bounded; `[]` when the drag ends) | `resizeHandles.ts` — posted from the preview's rAF only when the guides change | `useBridgeFrameInteraction` → `paintResizeGuides(resolveResizeGuideSurface(iframe), …)` — the frame's parent-document drag layer, where a portal drag paints its own |
| `text:editStart` (`live-18`, design mode only; carries the same bounded `ancestors` chain as `pointer`, canvas-24) / `text:commit` (final text, bounded to 20 000 chars) / `text:cancel` | `inlineTextEdit.ts` — a double-click on a stamped element opens a session; the runtime owns the whole contentEditable lifecycle itself (seeding, focus, select-all, Escape/Enter, blur) and only the request and the final result cross the wire | `useBridgeFrameInteraction` → `text:editStart` runs the SAME `startInlineEdit` predicate the portal double-click handler applies — on the nearest ancestor the tree KNOWS (`nearestKnownNodeId`, the click's own walk) — and replies via `adapter.startTextEdit(nodeId, allowed, text?)`, which the runtime accepts for any ref in the chain; `text:commit` calls `applyInlineEditValue` + `endInlineEdit`; `text:cancel` calls `cancelInlineEdit` — nothing is written to the store until commit, so cancel (and an HMR update landing mid-edit) is a plain no-op here |
| `ready`, `hmr:before`/`hmr:after`, `frame:resize`, `error`, `measure:result` | unchanged | `useAdapterReady`, `overlayMeasureScheduler`, `useIframeFrameAutoHeight`, `useBridgeFrameDiagnostics`, `useBridgeComputedValues`, and (`hmr:after`/`frame:resize`) `useBridgeSelectionChrome`'s anchor refresh |
| `key` (P2-B; `down`/`up`, `key`/`code` ≤ 32 chars, `location`, `repeat`, modifiers) / `blur` | `keyForwarding.ts` — capture-phase `keydown`/`keyup` on the document and `blur` on its window, DESIGN mode only, never for a key typed into a contentEditable or a text field; a design-mode keydown is cancelled and stopped in the frame | `useBridgeFrameInteraction` → `canvasFrameKeyRelay.ts`, the portal frame's own relay: `down` becomes a keydown clone on the parent `document` (the one dispatcher), `up` goes into the release broadcast, `blur` releases every held key if focus left the editor (ERR-11) |
| `dropCandidates:result` (`speed-06`; every stamped node's `{nodeId, occurrenceIndex, rect, axis, reversed, childRects}`, bounded ≤2000 candidates/≤200 `childRects` each) | `dropCandidates.ts`'s `collectDropCandidates`, answering the matching `dropCandidates` request | `BridgeFrameAdapter.measureDropCandidates()`'s pending-request map → `canvasInsertionDragSnapshot.ts`'s per-drag snapshot (never a per-move consumer) |

And the other direction — what the parent sends a bridge frame that a portal
frame never needs (each is a no-op on a portal adapter). The chrome calls come
from `useBridgeSelectionChrome` (called by `BreakpointSelectionOverlay` with the
frame's adapter); the rest name their caller:

| Adapter call | What the runtime does with it |
|---|---|
| `applyOverlay('selection-chrome-tokens', …)` | mounts the editor's `--canvas-selection-ring`/… token block — the runtime's own ring stylesheet references them, and a cross-origin document cannot read the parent's computed styles, so without this the rings position correctly and paint nothing |
| `select(refs)` / `hover(ref)` | draws and positions the rings in its own overlay root (the `live-05` design; this is the caller it was waiting for) |
| `setResizeTarget(ref, { proportional, sizing, snap })` | draws the eight handles (`resizeHandles.ts`) on the node's presented element when its computed display takes a size; the parent already applied the module half of `resizeOffer.ts` (`canOfferResizeForModule`). `sizing` is the node's STORED `flex`/`alignSelf`/`justifySelf` (canvas-23) and `snap` its tree siblings, tree parent and the committed zoom (canvas-26) — `resizeTargetContext.ts` reads them as primitives, so an unrelated store write re-sends nothing. A drag reads both once, at pointerdown |
| `optimistic.revert(nodeIds)` (store-17) | puts back the optimistic hide and move of exactly those nodes (`revertOptimisticNodes`) — called from `structuralCommitRollback.ts` when a structural write is refused or never answered, because no HMR follows a write that did not land. Other nodes keep their optimistic state: a second gesture still in flight keeps its preview |
| `measure(selection)` | answers with body-relative rects; the parent projects them through `createCanvasOverlayMeasureSession` to anchor the selection toolbar and in-place inspector, which stay in the parent document as they do for a portal frame — once per selection change, pan/zoom commit, `frame:resize` or `hmr:after`, never per frame |
| `optimistic.style(nodeId, patch, className?)` (`speed-01`) | applies the patch as a stylesheet rule ALWAYS scoped to `nodeId`'s own element (never `nodeId`'s own inline `style`, which React's later HMR write must not be cleared), stamping `[data-studio-optimistic-style]` and keying the rule on that stamp — for BOTH an inline write and a class write (`className` present). `className` crosses the wire but is informational only: a bridge frame cannot build a `.<className>` selector from it, because that name is Studio's own PARSE of the class, not the independently-hashed name Vite's CSS-modules plugin gave it in the live DOM — proven live (`speed-01`'s STATE.md entry, "Live-measurement fix"), a `.<className>` rule matched nothing. Only the edited node previews instantly; other elements sharing the class catch up on the next HMR update. Called from `commitApi.ts`'s `writeToTarget`/`previewToTarget` for a BASE-context OR a BREAKPOINT-context style commit or scrub — the broadcast layer (`optimisticStructuralBroadcast.ts`'s `broadcastOptimisticStyle`) filters a breakpoint-context write to only the bridge frame(s) whose OWN `breakpointId` (`canvasFrameAdapterRegistry.ts`'s per-registration field, set by `IframeFrameSurface.tsx`) matches; a base write reaches every bridge frame, same as before. Only a STATE/condition context (hover, focus, active, …) is skipped entirely — a live board frame IS a breakpoint frame, so treating every non-base context as "skip" (the pre-fix behaviour) silently removed the preview from its main use case. `PortalFrameAdapter`'s implementation is a documented no-op — the portal tree already repaints from the same store write. |
| `optimistic.clearStyle(nodeId)` (`speed-01`) | drops whatever optimistic style rule is currently active for `nodeId` — a no-op when nothing is active. Called from `commitApi.ts`'s `clearStylePreview`. |
| `optimistic.insert(nodeId, parentNodeId, index, tagName, text?)` / `optimistic.delete(nodeId)` / `optimistic.move(nodeId, parentNodeId, index)` (`live-07`) | the same-tick paint of a structural gesture, ahead of the file write and Fast Refresh: `optimisticDomOps.ts` inserts a ghost element built from structured `tagName`/`text` (never HTML; the id is a throwaway `optimistic:<uuid>`), removes the node's element, or moves it. `optimisticStructuralBroadcast.ts` sends each call to EVERY registered bridge adapter; a frame that does not hold the node no-ops. Callers: `studioSourceWrites.ts` (insert), `nodeActions.ts` and `deleteNodesAction.ts` (delete), `nodeActions.ts` and `moveSequenceActions.ts` (move). |
| `startTextEdit(nodeId, allowed, text?)` (`live-18`) | the reply to the frame's own `text:editStart` request (called from `useBridgeFrameInteraction`, not `useBridgeSelectionChrome` — the frame asks per-node, not once per selection). `allowed` makes the target `contentEditable`, seeds it with `text` (the node's current canonical value), focuses it and selects all; refused is a silent no-op, mirroring the portal editor's own silence for a non-editable double-click. `PortalFrameAdapter`'s implementation is a documented no-op — nothing in portal mode ever emits `text:editStart` in the first place, since `NodeRenderer` owns its whole session directly with no adapter round trip. |
| `measureDropCandidates()` (`speed-06`) | a bounded `dropCandidates`/`dropCandidates:result` round trip; the wire candidate's stamp+`occurrenceIndex` is translated to a canonical node id exactly like every other inbound method here. Called by `canvasInsertionDragSnapshot.ts`, once per drag per frame it visits (never per pointer move) and again on that frame's own `hmr:after`/`frame:resize`. `PortalFrameAdapter`'s implementation reuses the SAME `collectDropCandidates` the runtime answers with — a portal document's `data-node-id` values are already canonical, so there is no stamp translation to do. |

**`speed-03` — `move` is coalesced, not forwarded raw.** A native
`pointermove` fires far faster than the parent can usefully act on it
(measured ≈120/s while idly hovering a live frame, each one a `postMessage`
plus an unconditional store write). `gestureForwarding.ts` now buffers `move`
and posts at most one per animation frame, carrying the LAST event of the
batch, and skips the post entirely when it would repeat the SAME resolved
node + rect as the last move actually posted — the idle-hover case
`setCanvasHover` (`canvas/canvasHover.ts`; a store action until P2-I) exists
to guard against, and itself no-ops when the id/breakpoint/frame triple is unchanged,
so a coalesced-but-repeated `move` costs nothing even if one still arrives.
The skip only applies while **no pointer button is held**: a held button is
an active drag — a pan replay in particular, whose parent-side replay reads
`clientX`/`clientY` off every `move` — and the resolved node commonly does
NOT change mid-pan (dragging across one full-bleed background element stays
on the same node the whole gesture), but the position still has to reach the
parent every frame. `down`/`up`/`click` stay immediate and always flush a
pending move first, so the parent never observes a press arrive before the
move that preceded it (assert ordering here if you touch this — the
pan-replay `panPointerId` state machine in `useBridgeFrameInteraction`
depends on seeing `move`s in the order they happened).

Three rules that fell out of wiring this, each pinned by a test:

- **The parent declares the mode, on every `ready`.** `IframeFrameSurface`
  calls `setInteractionMode('design' | 'live')` when it builds the adapter, and
  `BridgeFrameAdapter` re-sends it on every subsequent `ready` — a Vite full
  reload replaces the frame's document under the same `WindowProxy`, and a
  mode sent once died with the old document. Before this nobody sent a mode at
  all, so every bridge frame ran as a visitor's page: hover suppression,
  scroll unroll and animation freeze never started, clicks reached the app,
  inputs took focus.
- **In design mode the gesture is the editor's.** The runtime cancels
  `pointerdown`/`click` and stops their propagation at the document (the app's
  React root never sees them; an `<input>` does not focus) — the same
  `ownsAuthoredEvents` rule `NodeRenderer` applies to a portal frame — except
  inside a `[contenteditable]`, where the caret has to land for the inline edit.
- **A component call site is stamped too, and its stamp wins over the
  component's own internal one (`live-17`).** `idStamp.ts` used to stamp only
  host/intrinsic elements (`<button>`), never a component call site
  (`<Button/>`) — reasoning that a call site "renders none of its own DOM".
  False for any component that spreads `...props` onto its own root element,
  which every design-system component in this repo's corpus does: a click on
  `<Button label="Label"/>` in the page produced a live `<button>` stamped
  with `design-system/components/Button.jsx:99:6` — a real position, but one
  the page tree has NO node for (package/design-system call sites are opaque
  instances, never inlined — see `componentSources.ts`). The old ancestor
  walk then landed on the nearest node the tree DID have — the page's own
  `<main>`, not the button — so the click silently selected the wrong node
  instead of failing loudly.
  Fixed by stamping BOTH kinds (`classifyJsxTagKind(name) === 'element' OR
  'component'`, same id-minting `processElement` already uses for either
  kind) and making ORDER decide which stamp survives when both land on the
  same rendered element: a host element's own stamp is `unshift`ed to the
  FRONT of its attribute list, a call site's stamp is `push`ed onto the END
  of its own — so a component that forwards `{...props}` (textually later)
  overrides its own internal stamp with whatever the call site passed in,
  and a component that does NOT forward props leaves its own internal stamp
  untouched (the extra attribute on the call site is simply an unused,
  harmless prop). See `idStamp.ts`'s own "What gets stamped, and where the
  attribute lands" doc for the full mechanics.
- **The ancestor walk still exists, for what genuinely has no stamp at all.**
  The runtime still sends the whole stamped chain (bounded at 32) and
  `liveNodeResolve.ts`'s `resolveLiveNode` still walks it to the nearest
  element that carries ANY `data-node-id` — vendor markup, a package
  component's own un-instrumented internals below Studio's parse boundary,
  or a genuinely un-stamped runtime-only element. That match comes back
  `exact: false` so a caller can badge it rather than act on it as a real
  selection. What changed is which id a design-system/package component's
  OWN rendered root now carries — its call site's, not its internal one — so
  the ancestor fallback no longer fires for the common "click a button"
  case.
- **The frame finds its parent through `location.ancestorOrigins`, then the
  referrer.** A Vite full reload inside the frame (the runtime bundle
  rewritten on project open, an HMR socket reconnect after an API-server
  restart) sets `document.referrer` to the frame's own url; a referrer-only
  check answered `null` and the reloaded frame ran without its bridge until
  the parent tab was refreshed. Both sources are still checked against the
  allowlist (`resolveParentOrigin`).
- **An optimistic delete hides; an optimistic move is put back before React
  reconciles.** The app's React root diffs its next render by sibling
  position against the DOM it built. A delete that detached the node left
  React updating that invisible node into the NEXT sibling and removing the
  sibling's own node — the element below the deleted one vanished too, until
  a reload (`live-14`). `optimisticDomOps.ts` now hides a deleted node with
  `data-studio-optimistic-hidden` (one runtime stylesheet rule, never inline
  `style`), records what a move displaced, and `revertOptimisticDom` restores
  both on `vite:beforeUpdate` (and again on `vite:afterUpdate`). The real
  change then arrives through React from the source.
- **The runtime's chrome is exempt from the design-mode rule.** A press on a
  resize handle (inside the selection overlay root) is neither forwarded as a
  pointer on some node nor cancelled before the handle's own listener sees it.
  The drag's document listeners are CAPTURE-phase for the same reason: the
  design-mode `stopPropagation` at the document would otherwise silence a
  bubble listener on that same document.
- **An in-frame resize previews through a stylesheet, never the element's
  `style`.** The commit is a `postMessage`, a file write and an HMR round trip
  away, after which React writes the SAME inline `width` the drag would have
  previewed — so an inline preview could neither be cleared after the commit
  (it deletes React's value) nor before it (the element snaps back for the
  length of the round trip). A `[data-studio-resize-preview]` rule in a
  runtime-owned `<style>` shares nothing with React and is dropped on the
  runtime's `hmr:after`; a refused commit never produces one, so that preview
  lasts until the next target change, where the snap-back is the honest answer.
- **`speed-01` — a properties-panel style op reuses the exact same
  stylesheet-not-inline-style posture, and had to teach the frame-fit
  `layoutObserver` about a NEW attribute it must ignore.** `optimisticStyle.ts`
  stamps `[data-studio-optimistic-style]` on the edited element for the
  SAME reason `resizeHandles.ts` stamps `[data-studio-resize-preview]` — the
  eventual React re-render writes the identical value, so only a stylesheet
  rule (never `element.style`) can be dropped without either deleting React's
  write or snapping back mid-round-trip. This is the THIRD attribute the
  frame-fit mutation observer (`runtime.ts`'s `layoutObserver`, which watches
  `doc.body` for real content changes to know when to re-derive the fit pin)
  has to be told to ignore — miss one and every style edit spuriously resets
  the frame's fit-height pin through the SAME observer callback that reports
  `frame:resize` to the parent, fighting the "grow to content" requirement
  `docs/features/canvas-iframe-per-frame.md` describes. `runtime.ts`'s
  `optimistic.style` handler also calls `scheduleReposition()` explicitly
  rather than relying solely on the mutation-observer side effect. Any
  FUTURE runtime-owned attribute needs the same three-way check: (1) does the
  mutation observer see it and mis-fire a fit-pin reset, (2) does React's own
  reconciliation ever try to write the same thing (then it must be a
  stylesheet rule, never inline), (3) does clearing it need an explicit
  reposition call because no other mutation will trigger one.
- **A class name is not a portable selector across the parse/DOM boundary.**
  `optimisticStyle.ts` originally tried a class-target write as
  `.<className> { … }`, reaching every element carrying the class in one
  shot — this looked right in every unit test and was WRONG the first time it
  ran against a real project. Studio's own PARSE names a CSS-module class one
  way (`SMS_page__5638d`, read out of the source); **Vite's own CSS-modules
  plugin** names the SAME class a completely different way at dev-server
  build time (`_page_xxxxx_3`-shaped) — two independent hashing schemes over
  one source file, with no reason to agree, and in the live frame's DOM they
  did not. `.SMS_page__5638d` matched nothing; the frame never changed until
  HMR landed. The fix: a class-target write previews element-scoped, exactly
  like an inline write — stamping the ONE node the panel is editing, never a
  class selector. `className` still crosses the wire but is read by nothing
  on the runtime side; it is informational only. Any FUTURE feature that
  wants "every element with class X" from inside a bridge frame needs the
  frame to report ITS OWN class names back over the wire — Studio's parsed
  name is never usable as a live-DOM selector.
- **A live board frame IS a breakpoint frame — "non-base context" and "skip
  the preview" are NOT the same condition.** `commitApi.ts`'s first version
  gated `broadcastOptimisticStyle` on `activeContextId` being falsy, meaning
  ANY non-null context — a breakpoint tab as much as a hover/focus condition
  — turned the broadcast off. That is wrong for a breakpoint context: a
  panel edit almost always happens WHILE a specific breakpoint's frame is
  selected, so the inspector's active context is that breakpoint's context
  for the common case, not an edge one — and the fix silently removed the
  whole feature from its own main use case (proven live: a Width edit sent
  no wire message at all). The correct split is by WHICH KIND of context is
  active, not whether one is active: `selectionModel.ts`'s own derivation —
  `activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab
  : null)` — already tells a breakpoint context (`activeTab`, itself equal
  to `activeBreakpointId` whenever it isn't `'desktop'`) from a state/
  condition one (`activeConditionId`, validated against `site.conditions`).
  A breakpoint context previews too, narrowed by `canvasFrameAdapterRegistry
  .ts`'s per-registration `breakpointId` (`IframeFrameSurface.tsx`'s own
  prop, in scope at every `registerFrameAdapter` call); only a genuine state/
  condition context (`onCondition`) skips the broadcast — that ONE case is a
  bridge frame's document not holding every pointer/focus state at once, not
  "any context at all". `optimisticStructuralBroadcast.ts`'s
  `broadcastOptimisticStyle(nodeId, patch, { breakpointId? })` is the layer
  that does the filtering; `listFrameAdapters()` stays adapter-only (its 8
  existing callers never need a breakpoint id) while
  `listFrameAdapterRegistrations()` carries both — one registry, two derived
  views, so they cannot drift apart.

The Live tab is not this path: `CanvasLiveSurface` is a single portal-mode
frame with `interaction="live"`, zoom locked at 100 %, and a Play toggle that
hands every click to the prototype player by design.

### `speed-06` — drag and drop into (and across) live frames

The board notch's `useCanvasInsertionDrag.ts` is the ONE drag-to-canvas
gesture (pointer events, not HTML5 DnD, so it can cross an iframe boundary —
see that file's own doc for why). Before `speed-06` it had two independent
gaps, both invisible until `run-project` became the trust-tier default:

- **Asset-card drag start.** The Assets panel's `AssetCard` was click-to-insert
  only — no pointer drag at all, in ANY frame mode. It now presses into the
  SAME `useCanvasInsertionDrag` gesture the notch's primitives use
  (`AssetsPanel.tsx` owns the one shared hook instance + overlay; the card
  only gets an `onPointerDown`), with the same payload its click-insert
  already builds.
- **A parent-doc drag crossing into a bridge frame did nothing.** The relay
  flag a drag sets on the parent `<html>` (`markCanvasPointerRelay`,
  `canvasPointerRelay.ts`) was read only by the PORTAL relay
  (`useIframeEventForwarding.ts`, forwarding an iframe-internal move back OUT
  to the parent's `window`). A bridge frame's own runtime ALREADY forwards
  every pointer event as a `pointer` message regardless of that flag
  (`gestureForwarding.ts` doesn't know or care about a parent-doc drag), but
  nothing on the parent replayed those messages onto the iframe element so
  the drag session's `window` listeners would see them. `useBridgeFrameInteraction`
  now does, as a third pointer case checked before hover/selection: when
  `readCanvasPointerRelay(document)`'s pointer id matches the event's, `move`/
  `up` are replayed on the iframe element (bubbling to `window`, the same
  mechanism the pan replay already uses) instead of routed to
  `onNodeHover`/`onNodePointerUp`. `readCanvasPointerRelay` is the ONE reader
  both relays (portal-outbound, bridge-replay) share — see
  `canvasPointerRelay.ts`'s own doc. **Known gap, not silently swallowed:**
  the wire has no `pointercancel` phase (`gestureForwarding.ts` never taps
  native `pointercancel`), so only `move`/`up` are relayed.

**The bigger fix underneath both: a per-drag candidate SNAPSHOT, not a
per-move DOM scan, in either mode.** `resolveCanvasPointerInsertionDrop` used
to call `measureCanvasDropCandidates` — a full `querySelectorAll` plus one
`getBoundingClientRect`/`getComputedStyle` per candidate — on every raw
`pointermove`, and had no bridge-mode path at all (`resolvePortalDocument` is
`null` for a Tier 2 frame, so the scan silently found zero candidates and
every live-frame drop fell back to "page root"). Two changes:

1. **`FrameDocumentAdapter` gained `measureDropCandidates()`** — same
   synchronous-DOM-read-wrapped-in-a-resolved-Promise-vs-real-round-trip split
   `measure()` already has. Bridge mode: the `dropCandidates`/
   `dropCandidates:result` pair above. Portal mode: `collectDropCandidates`
   (`@core/studio-runtime`, shared verbatim with the in-frame runtime — one
   axis rule, `dropAxisRules.ts`, moved out of `canvasDomGeometry.ts` so both
   sides can read it). Both return BODY-RELATIVE rects (`measure`'s own
   coordinate space) and no `depth` — depth is a TREE property the caller
   derives from `buildDepthMap`, which the adapter has no concept of.
2. **`canvasInsertionDragSnapshot.ts`** (new) is what `useCanvasInsertionDrag`
   now asks instead of scanning: `beginInsertionDragSnapshotSession()` measures
   a frame's candidates LAZILY, the first time a drag actually visits it, caches
   them, and re-measures only on that frame's own `hmr:after`/`frame:resize`
   (bridge) or a native `scroll` on its document (portal only — a cross-origin
   scroll has no wire signal yet, a real, documented gap). Converting a
   body-relative rect into the resolver's own "frame-space" (unscaled,
   viewport-local) unit system is ONE function,
   `bodyRelativeRectToFrameSpace` (`canvasDomGeometry.ts`), reused for both
   modes — the same "don't grow a second copy of ×zoom+offset arithmetic"
   discipline `canvasOverlayGeometry.ts`'s own `project` already documents.
   **The no-adapter fallback:** a viewport whose iframe has no registered
   adapter (a hand-built test fixture; nothing in production leaves this
   state) falls back to the original synchronous `measureCanvasDropCandidates`
   scan — not a workaround, the same "nothing to measure" answer that
   function already gave an iframe with no `resolvePortalDocument`.
3. **Resolution itself is throttled to at most once per animation frame**,
   with the LAST pointer position of whatever native moves arrived since the
   previous tick (`useCanvasInsertionDrag.ts`'s own `pendingPoint`/
   `pendingFrame` pair) — the ghost still follows every resolved frame's
   pointer position (no "skip when unchanged" beyond the throttle itself: the
   ghost's `x`/`y` have to keep moving even when the drop TARGET doesn't, so
   `setDrag` runs once per throttled tick unconditionally). `pointerup` still
   resolves SYNCHRONOUSLY, off whatever the snapshot already has — a very fast
   flick-and-release into a bridge frame whose candidates are still in flight
   commits to "page root", the same honest answer a pointer outside every
   frame gets, not a hang.

**Known, deliberately out-of-scope gap:** the ELEMENT REORDER drag
(`useCanvasReorderDrag.ts`/`canvasDragSession.ts`'s `FrameCandidateIndex`,
D2 G3's cross-frame board) still calls `measureCanvasDropCandidates` directly
and is therefore STILL bridge-blind for that gesture — dragging an existing
element across frames when one of them is a live Tier 2 frame silently finds
zero candidates there, same failure mode this work order fixed for INSERTION.
Not touched here: it is a materially larger, higher-risk refactor (an
already-synchronous rAF loop that would need to become async-tolerant) that
the work order this section describes explicitly scoped out. Flagged for a
follow-up, not silently left broken.

**Follow-up fix (same day) — a board can show more than one page's frames.**
A live dogfood found the drop line always fell back to "page root", never a
container, into a live frame that was NOT the store's currently active
document. Root cause, proven by a dedicated round-trip test: resolution
ALWAYS filtered candidates against `canvasPage` (the single active page),
even when the hovered frame showed a DIFFERENT page — a board can have many
simultaneously, and node ids never collide across pages, so every real
candidate failed `canvasInsertionDragSnapshot.ts`'s `tree.nodes[id]` check
and resolution fell back to "page root" of the WRONG page.
`resolveCanvasPointerInsertionDrop` gained an optional
`resolvePageForViewport(viewport) => Page | null`; when it names a page,
THAT tree drives candidates, target resolution, and the page-root fallback's
`rootNodeId` — not `canvasPage`. `useCanvasInsertionDrag.ts` supplies it by
climbing `viewport.closest('[data-page-id]')` to `BoardFrameView.tsx`'s
ALREADY-EXISTING stamp on its outer `.frame` wrapper (never a second copy —
`framePoolMountReason.test.tsx`'s `sample()` reads every `[data-page-id]`
element back through `readFrameMountReason`, and a mount-reason-less
duplicate fails its "every frame answers" assertion). A successful drop
whose resolved page differs from the active one calls
`openPageInCanvas(resolved.pageId)` BEFORE the insert commits — every insert
action writes through `mutateActiveTree`, so the active document has to
already BE the target page or the write lands nowhere.
