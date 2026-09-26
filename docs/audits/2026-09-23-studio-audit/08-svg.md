# Audit 08 — SVG on the canvas: insert, draw, edit, write back
> **Trust:** historical, dated 2026-09-23. Paths and line numbers were true at `560ddb0e`; re-read the code before acting on a finding. The plan built from it is `ROADMAP.md`.

Auditor: canvas-engineer (read-only). Repo: `C:\Users\Admin\Documents\GitHub\Figma Killer 2`.
Ground truth studied: Penpot `frontend/src/app/main/data/workspace/path/*`,
`ui/workspace/shapes/path/editor.cljs`, `ui/workspace/viewport/path_actions.cljs`,
`data/workspace/drawing/curve.cljs`, `common/src/app/common/svg.cljc`,
`common/src/app/common/svg/path/parser.js`, `common/src/app/common/types/path/*`,
`data/workspace/svg_upload.cljs`.

---

## 0. Executive summary

- **Today an inline `<svg>` is one opaque, non-editable node.** `parsePageFile.ts:397-435` stops
  recursing at `<svg>`. `inlineSvg.ts` serialises the JSX subtree to a markup string on
  `props.svg`. `moduleMapping.ts:113-118` maps it to `base.svg`. The children (`<path>`,
  `<circle>`, `<g>`) are not page-tree nodes and cannot be selected. The `svg` prop is in
  `codeProps`, so it is read-only. The root `<svg>`'s own literal attributes (`viewBox`, `fill`,
  `width`) are ordinary props at the svg's own `rel:line:col`, so `setJsxProp` can already write
  them.
- **You cannot insert an SVG on the canvas today.** `base.svg` has no `sourceIntrinsic`, so
  `moduleAvailability` hides it (`IconsSection.tsx:12-16`, which is why clicking an icon only
  *copies* it). A dropped `.svg` file goes through the image path and lands as `<img src>`
  (`useCanvasFileDrop.ts:231`). Pasting SVG text does nothing: `⌘V` calls `preventDefault()` in
  the keydown (`useCanvasNodeShortcuts.ts:182-190`), so no native `paste` event ever fires. The
  only SVG→JSX writer is `svgToJsxNode.ts`, which the slot picker uses for icon props.
- **Five existing defects need fixing before building on this** (§2).
- **The design has three rules:**
  1. The parser stamps each serialised SVG element with its own source location
     (`data-studio-svg-part="line:col"`). Every inner element then carries the exact place a
     write lands, and `<path>` stays out of the page tree.
  2. During a gesture, edits are drawn only in a new board-space layer, `BoardVectorLayer`, inside
     `CanvasTransformLayer`. It follows the precedent of `BoardPrototypeLayer`, sizes chrome with
     `--canvas-zoom`, and costs nothing per pan. The only extra is an optional mirrored `d` write
     onto the real element under `beginCanvasGesture()`.
  3. **One gesture = one write.** Each gesture sends one `svg-attr` edit, updates the markup
     optimistically, and records one undoable "source gesture" entry. A whole pen session is one
     gesture.
- **Recommendation for shapes:** `R`/`O` stay `<div>`s, because a box a React developer writes
  is a div. Line (`L`) and arrow (`⇧L`) become `<svg>`. Inside vector-edit mode, `R`/`O`/`L`
  draw SVG primitives (`<rect>`/`<ellipse>`/`<line>`) in that svg's user space.
- **Out of scope for v1:** SVGR and `?raw` external `.svg` files (read-only render plus an
  "Inline to edit" remedy later), live Tier-2 frames, boolean ops, and `d` values reached through
  an expression.

---

## 1. How inline SVG works today (findings with file:line)

| Concern | Where | What it does |
|---|---|---|
| Capture | `src/core/page-parser/parsePageFile.ts:393-435` | For a lowercase host `svg`, it calls `serializeInlineSvg` and builds ONE node with `props.svg = markup` and `children: []`. `codeProps` includes `'svg'`. If serialisation fails, the node is locked with `DYNAMIC_SVG_LOCK_REASON` ('SVG built in code'). |
| Raw icon | `parsePageFile.ts:438-465`, `iconPropValues.ts` | `dangerouslySetInnerHTML={{__html: rawSvg}}` (`?raw` import) → `props.svg`, with the host element kept as `props.tag`. `icon={<svg…/>}` props also go through `serializeInlineSvg` (`iconPropValues.ts:252`). |
| Serialiser | `src/core/page-parser/inlineSvg.ts` | Maps JSX names to markup names (`CAMEL_CASE_SVG_ATTRIBUTES` allowlist; `className`→`class`). Resolves `{expr}` through the §7 evaluator. Omits anything it cannot resolve (a `{cond && <path/>}` child simply vanishes). `MAX_MARKUP_LENGTH = 64 KB`, above which the whole svg locks. |
| Module mapping | `server/handlers/studio/moduleMapping.ts:110-118` | `props.svg` present, or tag `svg` → `base.svg`. |
| Canvas render | `src/modules/base/svg/SvgEditor.tsx` | `sanitizeSvg` on every render. If an authored wrapper exists (`props.tag`), it renders that element with `dangerouslySetInnerHTML`. **Literal `<svg>` case:** it renders a Studio-owned `<span style="display:contents">` carrying `data-node-id`, `className` and the markup (`SvgEditor.tsx:59-88`). |
| Host tag | `src/modules/base/svg/hostTag.ts` | Case 1 (literal svg, no wrapper) vs case 2 (authored `<span dangerouslySetInnerHTML>`). |
| Sanitiser | `src/core/sanitize.ts:256-288` | DOMPurify `svg` + `svgFilters` profiles. `FORBID_TAGS: script, foreignObject, a`; `FORBID_ATTR: href, xlink:href`. Allows `data-*` by default. Browser-only: Bun has no DOM, so the server never sanitises (`iconCatalog.ts` returns raw markup). |
| Panel | `src/admin/pages/site/property-controls/SvgControl.tsx` | Preview tile, "Edit code" (CodeMirror on the `svg` prop), "From library". On a studio tree the prop is a `codeProp`, so these are CMS-era affordances. |
| SVG → JSX | `src/admin/pages/site/studio/svgToJsxNode.ts` | Sanitises, parses with `DOMParser('image/svg+xml')`, camelCases attributes, drops `xmlns*`/`on*`, and caps at 256 nodes / depth 12. Used by `SlotPicker` / `insertablePropValues.ts` for icon props only. |
| Subtree writer | `src/core/ast-codemods/jsxSubtree.ts` | `renderJsxNode` + `validateSubtree`. `isSafeIntrinsicTagName` (`src/core/utils/htmlTags.ts:85`) accepts `linearGradient`, `path` and similar, but refuses `style`/`script`. |
| Insert wire | `server/handlers/studioStructuralWriteback.ts:176-205` | `InsertNodeSchema` already takes nested `children: InsertNode[]`. The client `commitStudioInsert` (`studioStructuralCommits.ts:412-435`) narrows `children` to `string`. |
| Prop write | `server/handlers/studioWriteback.ts:188-196` → `src/core/ast-codemods/setJsxProp.ts` | Writes to any `rel:line:col` JSX element. **It does not refuse overwriting an expression attribute**; that guard lives only on the client (`codeProps`). |
| Tools | `canvasSlice.ts:58` `CanvasTool = 'move'\|'hand'\|'scale'`; `useCanvasToolShortcuts.ts` | `R`/`O` insert a `base.container` beside the selection. There is no draw gesture ("there is no rectangle to draw", doc header). `P`, `⇧P`, `L`, `⇧L`, `⇧C` are all free in `src/admin/spotlight/keybindings.ts`. |
| Double-click | `useCanvasNodeInteraction.ts:263-276` | Only `startInlineEdit`. It is a no-op for `base.svg`. |
| Export | `panels/PropertiesPanel/nodeExportModel.ts` | SVG export reads `props.svg` directly. This matters for §4.3 (stamps would leak into it). |
| Board-space precedent | `canvas/BoardPrototypeLayer/*` + `.module.css:1-21` | Draws connectors to elements inside frames, in board units, inside the transform layer. The conversion is `frame origin + element rect` (iframe content is unscaled). Chrome is sized with `vector-effect: non-scaling-stroke` and `calc(px / var(--canvas-zoom))`, and `--canvas-zoom` is published every rAF. |
| Gesture hold | `canvas/canvasGesture.ts` (`beginCanvasGesture`/`endCanvasGesture`) | Holds `PortalFrameAdapter`'s `MutationObserver({attributes:true, subtree:true})` (`PortalFrameAdapter.ts:178`) and `overlayMeasureScheduler.ts:238` during a continuous mutation. |

**Answer to "is an `<svg>` subtree selectable?"** The svg root is selectable as one `base.svg`
node, and clicking any child selects it. The children are not selectable and have no ids. The
root's literal attributes are writable as props, but there is no dedicated UI for them. Children's
attributes are not reachable at all.

---

## 2. Defects found (fix first, they undermine everything built on top)

1. **The `display: contents` span breaks the canvas rule** (`SvgEditor.tsx:59-88`). The canvas
   DOM is `parent > span[display:contents] > svg`, while the user's app has `parent > svg`. So
   `.row > svg`, `.icon > .ring__svg`, `svg:first-child` and `svg + span` all silently mean
   something different in the editor. `nodeVisualRect` hides the geometry, but not the selector
   mismatch. It also makes `canOfferResize` refuse, because the host has `display: contents`, so
   an svg cannot be resized on the canvas.
   → **SVG-0.**
2. **`svgToJsxNode` writes `style` as a string** (`jsxAttributeName('style')` returns `'style'`
   with a string value). The result is `<path style="fill:#fff"/>` in the user's `.tsx`, and React
   throws at runtime ("The `style` prop expects a mapping…"). SVGs exported from Illustrator,
   Figma or Inkscape almost always carry `style=` strings. `src/__tests__/studio/svgToJsxNode.test.ts`
   has no style case.
   → **SVG-2.**
3. **`<style>` elements make the insert refuse with a misleading sentence.** DOMPurify's svg
   profile keeps `<style>`, then `validateSubtree` refuses it as `unsafe-tag` ("must not be one
   that executes script…"). Every Illustrator export (`.cls-1{fill:…}`) fails that way.
   → **SVG-2** (inline class rules into attributes).
4. **`href`/`xlink:href` are forbidden outright**, so `<use href="#icon">` sprites and
   gradient/pattern inheritance (`href="#g1"`) are stripped, and the graphic renders
   blank-by-omission. Local fragment references are safe.
   → **SVG-2** (DOMPurify `uponSanitizeAttribute` hook: keep `href` only when it matches `^#[\w-]+$`).
5. **Duplicate IDs when inserting.** Two inserted icons that both declare `<linearGradient id="a">`
   collide page-wide, and the second one renders with the first one's gradient. Penpot remaps
   every id on import (`svg.cljc:629-665` `generate-id-mapping` / `replace-attrs-ids`).
   → **SVG-2.**

Also relevant: `setJsxProp` has no server-side guard against overwriting `{expr}`. Existing kinds
lean on the client's `codeProps`, but SVG parts will get a new kind with a server-side guard (§5.4).

---

## 3. Target experience (what "not degrading" means)

| Gesture | Result | Writes |
|---|---|---|
| Paste `<svg…>` text (`⌘V`) | New inline `<svg>` beside the selection (or inside a selected container), selected | 1 `insert` |
| Drop `.svg` from OS | Inline `<svg>` if within budget (≤256 elements, ≤32 KB after normalise, no embedded raster). Otherwise `<img src>` with a toast "Large SVG added as an image". `Alt`-drop inverts the choice. | 1 upload + 1 insert, or 1 insert |
| Assets → Icons: click / drag | Inline `<svg>` beside the selection / at the drop target. Replaces today's copy-to-clipboard. | 1 `insert` |
| Double-click an svg (or `Enter` on it) | Vector edit mode: anchors and handles of every `<path>`/`<line>`/`<polyline>`/`<polygon>` part, plus geometry handles for `<rect>`/`<circle>`/`<ellipse>` | 0 |
| Drag an anchor / handle / selection of anchors | Preview in the overlay (plus a mirrored `d` on the real element) | 1 `svg-attr` on `pointerup` |
| Arrow-key nudge anchors | Accumulates; commits 100 ms after the last key (Penpot `move-selected` debounce) | 1 per burst |
| Double-click a segment / `⇧+` | Insert an anchor by exact de Casteljau split (shape unchanged) | 1 |
| Delete anchors | Merge adjacent segments | 1 |
| Double-click an anchor / `C` / `X` | Toggle smooth / corner (Penpot's make-curve `c`, make-corner `x`) | 1 |
| Pen `P` | Click = corner, drag = smooth (symmetric handles, `Alt` breaks symmetry), `⇧` = 45° constraint, click the first anchor = close. `Enter`/`Esc` finish. Local undo inside the session. | **1 for the whole pen session** |
| Pencil `⇧P` (alias `⇧C`, see decision D2) | Freehand → RDP + Schneider cubic fit | 1 |
| Line `L` / Arrow `⇧L` | 2-anchor `<svg>` (arrowhead drawn as a second path, no `<marker>` so there are no ids) | 1 |
| Fill / stroke / width / dash / cap / join | Vector section in the Design pane, on parts or the root | 1 per commit |

**Performance budgets** (gated in SVG-9):
- zero React commits per `pointermove` during any vector gesture;
- p95 frame time ≤ 16.7 ms dragging an anchor on a 2,000-anchor path at 25%, 100% and 400% zoom;
- exactly one `POST /admin/api/studio/save` per gesture;
- entering edit mode ≤ 50 ms on a 64 KB markup svg;
- pan and zoom during edit mode cost nothing extra (board-space layer).

---

## 4. Architecture

### 4.1 Where things live

```
src/core/vector/                         NEW pure module, no DOM, no ts-morph (barrel + gate)
  pathData.ts        token-preserving parse/serialise of `d` (all commands, rel/abs, H/V/S/T/Q/A)
  pathModel.ts       editable anchor model over the parsed segments; mutation → minimal re-emit
  pathGeometry.ts    cubic/quad eval, split at t, nearest point on segment, bbox, flatten LUT
  arcToCubic.ts      only used when the user explicitly converts an arc
  simplify.ts        RDP (radial + Douglas-Peucker) + Schneider fitCurve
  precision.ts       decimals policy (§5.3)
  svgAttributeNames.ts   ONE jsx⇄markup attribute mapping (replaces inlineSvg.ts's list AND
                         svgToJsxNode.ts's jsxAttributeName)
  svgImportNormalize.ts  style-string→attrs, <style> class inlining, id prefixing (string/DOM-free
                         parts; the DOM part stays in the admin layer)
src/core/page-parser/inlineSvg.ts        + part stamps (§4.3)
src/core/ast-codemods/setSvgPartAttributes.ts   NEW codemod (§5.4)
server/handlers/studioEditSchemas.ts     + `svg-attr` kind
src/admin/pages/site/canvas/BoardVectorLayer/   NEW board-space overlay (§4.2)
src/admin/pages/site/store/slices/vectorEditSlice.ts   NEW session state
src/admin/pages/site/canvas/useVectorToolShortcuts.ts or extend useCanvasToolShortcuts
src/admin/pages/site/canvas/canvasClipboardBridge.ts   NEW paste/copy bridge (§4.5)
src/admin/pages/site/inspector/sections/VectorSection.tsx   NEW
```

### 4.2 The overlay: board space, not screen space, not in-frame

Three options were weighed.

- **(a) Parent-document screen-space overlay.** This is literally what the task suggested. It
  recreates `standing-03` defect 1: position = `rect × zoom + offset + pan`, recomputed per tick,
  so any error scales with zoom.
- **(b) In-frame overlay root** (like `CanvasResizeHandles`). Zero drift, but chrome is sized in
  frame px, so 9 px handles become 2 px at 25%. There is no zoom var in-frame
  (`selectionChromeCss.ts:162-207`). It also cannot draw a new shape that starts over empty board.
- **(c) Board-space layer inside `CanvasTransformLayer`.** This is exactly what
  `BoardPrototypeLayer` does. Pan and zoom are free because the ancestor transform moves it. It is
  pixel-exact because iframe content is unscaled, so `frame origin + element rect` is the whole
  conversion (`usePrototypeEndpoints.ts:20-24`). Chrome is sized with `--canvas-zoom`, it can
  cross frames and empty board, and it never touches user DOM.

**Recommendation: (c), one layer for both drawing and editing.** Mount `BoardVectorLayer` in
`StudioBoardLayers.tsx` after `BoardFramesLayer` and before `BoardCommentsLayer`.

- **Coordinates:** a part's local point `p` maps to board as
  `frameContentOrigin(frame) + partEl.getScreenCTM() · p`. `getScreenCTM()` inside the iframe
  covers `viewBox`, `preserveAspectRatio`, and every ancestor `transform=` in iframe-client
  coordinates. `frameContentOrigin` = `frameBoardRect` + the title-bar/device offset. Take it from
  the same source `BoardPrototypeLayer` uses; do not re-derive it. Pointer → part-local uses the
  inverse. A non-invertible CTM (scale 0) refuses edit mode by name.
- **When it measures:** once at session start, then on a `ResizeObserver` of the frame document
  element, as prototype endpoints do. Never per pan, per zoom, or per rAF.
- **Rendering:** ONE `<svg>` in board units containing:
  - `outline` path (every part's `d`, transformed);
  - `anchors` path (all idle anchors as a single path of `M x y h s v s h -s z` squares);
  - `handles` path;
  - a handful of elements for hovered/selected/active items.

  So DOM size is O(1), not O(anchors). Penpot renders one React element per point
  (`editor.cljs:45-130`); that does not scale to the 2k-anchor budget. Strokes use
  `vector-effect: non-scaling-stroke`. Anchor size is `calc(5px / var(--canvas-zoom))` in CSS, or
  `s = 5 / zoom` baked into the anchors path, rewritten only when zoom settles (subscribe to the
  zoom-commit, never rAF). Constants from Penpot: point radius 5, handle 6, hit area 15, drag
  threshold 5, snap accuracy 10 — all ÷ zoom.
- **Updates during a drag:** a rAF-coalesced write of `d` onto 1–3 ref'd overlay paths. No React
  state. React re-renders only on session enter/exit and on selection-set changes.
- **Pointer routing:**
  - *Edit mode:* the layer is `pointer-events: none` except the outline stroke
    (`pointer-events: stroke`, 12 px ÷ zoom hit width) and the anchor/handle hit targets. A click
    anywhere else falls through to the iframe, changes selection, and the session ends on
    selection change (Figma's "click away exits").
  - *Drawing tools armed:* a new flag source `'vectorTool'` joins `canvasPanInput.ts`'s
    `parentDocument` / `iframe` / `handTool` sources, as a separate `data-studio-canvas-capture`
    attribute rather than the pan flag, because it is not a pan. `IframeFrameSurface` makes iframes
    `pointer-events: none` while it is set, as it already does for space-pan. The layer then
    mounts a full-viewport capture rect. Target-container hit testing reuses
    `canvasSurfaceAtPoint` / `buildFrameCandidateIndex` / `resolveCanvasInsertionTarget` from the
    file-drop path (`canvasFileDrop.ts`). No second hit-test implementation.

### 4.3 Part addressing: stamps, not page-tree nodes

`<path>` must not become a page-tree node. The reasoning in `inlineSvg.ts:17-26` still holds:
there is no module with attribute passthrough, and a tree of drawing instructions would bloat
every panel. The editor still needs, per inner element, **where a write lands** and **which
attributes are literals**.

**Recommendation:** `serializeInlineSvg` emits two attributes on each element it serialises:
- `data-studio-svg-part="<line>:<col>"` — the element's own JSX location, in the SAME file as the
  host's id tail;
- `data-studio-svg-code="d,fill"` — only when non-empty; these attributes came from an expression
  and are read-only.

Why stamps rather than a parallel index array:
- DOMPurify survives them (`data-*` allowed).
- DOMPurify also REMOVES elements (`script`, `foreignObject`, `a`), and an index array keyed by
  pre-order position would silently shift onto the wrong element. A stamp cannot drift.
- The canvas DOM needs them anyway: `event.target.closest('[data-studio-svg-part]')` is the hit
  test, and it keeps the answer "a fact about the parse the browser already holds" (the SVG-export
  precedent, `STATE.md` ~15065).

Costs:
- about 30 bytes per element on the load payload, bounded by the 64 KB cap;
- stamps must be **stripped at every exit**: `nodeExportModel.ts` (SVG export), `SvgControl`
  preview copy, the CMS publisher's `escapeProps` path, and `studio_*` MCP reads that return
  markup. One helper, `stripSvgPartStamps(markup)` in `@core/vector`, called at each exit, plus a
  gate test that greps exits for `props.svg` reads.

The host id's `~` prefix (inlined component) and `#n` suffix (map row) govern writability exactly
as for any prop. `#n` means read-only. `~` means the write lands in the component file and affects
every call site, so it goes through the same shared-component surfacing prop edits use today.
Never invent a separate rule.

### 4.4 Rendering fix (SVG-0): render the `<svg>` as itself

Rewrite `SvgEditor`'s literal-svg branch to `React.createElement('svg', { ...rootAttrs,
...editorProps, className: mcClassName, style: nodeStyle, dangerouslySetInnerHTML: { __html: inner }})`:
- `rootAttrs`/`inner` come from `splitSvgRoot(markup)`. It is `DOMParser`-based, cached in a
  module-level `Map` keyed by the sanitised markup string (bounded LRU of about 500), and root
  attribute names are converted by `@core/vector/svgAttributeNames`.
- `innerHTML` on an SVG-namespace element parses in SVG context, so this is valid.
- React compares the `__html` string and leaves inner DOM alone while it is unchanged. That is
  what makes the mirrored-`d` preview safe (§5.2).
- The `props.tag` wrapper branch (case 2, `?raw` icons) is unchanged; that span is authored.

Consequences:
- selectors match the app;
- `canOfferResize` stops refusing, so an svg gets resize handles;
- `nodeVisualRect`'s fallback is no longer exercised for this case.

The `[24,44]` line-box regression that motivated `display: contents` (`STATE.md` ~14916,
`canvas-12`) does not come back. That regression was the *span's* inline line box around an svg;
an `<svg>` rendered directly is exactly what the browser renders in the user's app.

### 4.5 Clipboard (paste SVG, and later paste images)

`⌘V` today calls `preventDefault()` in the keydown (`useCanvasNodeShortcuts.ts:182-190`), which
cancels the native `paste` event, so clipboard text is never readable without a permission
prompt (`navigator.clipboard.readText()` prompts).

**Recommendation:** make paste driven by the `paste` event.
- `canvasClipboardBridge.ts` listens for `paste` (and `copy`) on the parent `document` AND on each
  design-frame document. This is a 6th bridged case in canvas-internals "Events across the iframe
  boundary", registered where `useIframeEventForwarding` attaches.
- The `layers.paste` keydown handler stops calling `preventDefault()` and stops pasting. It only
  claims the key so nothing lower in the ladder fires.
- Decision order inside the `paste` handler:
  1. If `clipboardData` carries `application/x-studio-clipboard` whose token matches the internal
     clipboard entry, run the internal `pasteNode(…, 'after')`. The internal copy writes that token
     through the `copy` event's `clipboardData.setData`. This is Figma's approach: the system
     clipboard always tells you whose content it is.
  2. Otherwise, if `text/plain` or `image/svg+xml` sniff as an SVG document (trim, optional XML
     prolog, `<svg` root), run the SVG insert.
  3. Otherwise, if `files[0]` is an image, run the existing image-drop pipeline.
  4. Otherwise, fall back to the internal paste.
- `keybindings-single-dispatcher.test.ts` counts `keydown` listeners only. Add the two clipboard
  listeners to its allowlist with a justification, and gate "exactly one paste listener per
  document".

---

## 5. Write path

### 5.1 New `svg-attr` edit kind

```ts
// server/handlers/studioEditSchemas.ts
const SvgAttrEditSchema = Type.Object({
  kind: Type.Literal('svg-attr'),
  nodeId: Type.String(),                    // the HOST (base.svg node / icon-prop call site) id
  part: Type.String(),                      // 'line:col' from data-studio-svg-part ('' = the root svg)
  set: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),   // JSX names
  remove: Type.Optional(Type.Array(Type.String())),
})
```

It is dispatched in `studioWriteback.ts`'s `applyStudioEdit` to the new codemod
`setSvgPartAttributes`. It needs no new route and no `routeCapabilities.ts` entry, because it rides
`POST /save`. This is a new *kind*, not a reuse of `prop`, for three reasons:
- **Containment.** The part location must be a JSX element that is a descendant of the host
  element in the same file, and whose tag is an SVG-content tag. `svg-attr` therefore cannot be
  used to write arbitrary attributes anywhere in the file (defence in depth: `rel` arrives from
  the client).
- **Server-side expression refusal.** Overwriting `d={ICON}` refuses with
  `svg-attr-expression`, whose remedy is jump-to-source. The server holds this guard itself,
  unlike `prop`.
- **Atomic multi-attribute set plus removal** (for example `d` + `transform`, or clearing
  `strokeDasharray`), which `setJsxProp` cannot express.

Undo is a `source` gesture entry (`docs/reference/editor-history.md`) whose inverse is the same
kind carrying the previous literal values, with `remove` for attributes that were absent. There is
a `stale-undo` refusal if the part id no longer resolves. Adding a part reuses the existing
`insert` kind with `nodeId` = the svg host id or a `<g>` part's `rel:line:col` (every part location
is a legal JSX parent location). Removing a part uses `delete`, and reordering uses `move`. Only
attribute writes need the new kind.

### 5.2 One gesture = one write

1. `pointerdown`:
   - snapshot the part model (parsed once at session start, cached per part);
   - call `beginCanvasGesture()` (holds `PortalFrameAdapter`'s attribute MutationObserver and
     `overlayMeasureScheduler`, which would otherwise fire on every `d` write);
   - set pointer capture on the layer.
2. `pointermove`:
   - store the latest point only;
   - one rAF callback applies the model mutation, re-emits `d` for the touched segments only
     (§5.3), and writes the overlay paths;
   - **mirrored preview (default on):** the same callback also sets `d` on the real in-frame
     element found via `[data-studio-svg-part]`. That is one `setAttribute` with no React
     involvement, so the user sees real fill and stroke. An svg's box does not depend on its
     content, so there is no height feedback.
3. `pointerup`:
   - `endCanvasGesture(token)`;
   - if the model is unchanged, no-op (compare before commit);
   - otherwise one `svg-attr` edit through the store action `commitSvgPartAttributes`, which also:
     - applies the **optimistic markup** via `previewActiveTreeMutation`, the `perf-10` channel
       (no history, no dirty). It rewrites `props.svg` with a DOMParser → set attribute →
       XMLSerializer pass on the stored markup (not the live DOM, which carries editor attributes).
       React then re-applies `__html`, whose content equals what was already mirrored;
     - records the source-gesture history entry;
     - enqueues through `structuralCommitQueue.ts` so rapid gestures serialise and re-plan.
4. The narrow resync replaces the page (`studioBoardResync.ts`). Stamps keep `line:col` stable,
   because `svg-attr` rewrites an attribute value in place: same element start position, so the
   ids after it on the same line may shift. If they shift, the session re-resolves the part by
   ordinal within the host after resync.

**Pen/pencil session:** points live only in the vector slice and the overlay until finish. Finish
posts one `insert`, either of a new `<svg>` at the resolved target or of a `<path>` into an
existing svg host. The optimistic preview uses `previewOptimisticInsert` with `moduleId: 'base.svg'`
and `props.svg` = the generated markup. Inside the session, `⌘Z` pops the last anchor from a local
stack (Penpot `path/undo.cljs`). It must not touch store history; the `vector-edit` keyboard rung
claims it.

### 5.3 `d` serialisation: token-preserving, minimal diff

The path is the user's source. Rewriting a hand-written `M4 4h16v16H4z` as
`M4.000,4.000 L20.000,4.000…` is a destructive reformat. Penpot normalises everything to absolute
M/L/C/Z on parse (`parser.js:973-981`); **Studio must not.**

- **Parse into segments** that keep the original command letter, relative/absolute flag, and the
  original source text span.
- **Untouched segments re-emit their original text byte-for-byte.** Gate this with a round-trip
  test over the 568 real icons in `vendor/alm-design-system/src/icons/`: parse → serialise must be
  byte-identical.
- **A mutated segment keeps its command form where it can:**
  - `h`/`v` stays if the orthogonal coordinate did not change, else becomes `l`/`L`;
  - relative stays relative, which means recomputing the *next* relative segment's start as well:
    moving an anchor in a relative path changes one segment's end and the following segment's
    offset, and both are re-emitted;
  - `S`/`T` stay only while the reflected handle still matches, otherwise `C`/`Q`;
  - `A` keeps its arc for an endpoint move; arc handles are not offered, and "Convert to curve"
    is explicit (`arcToCubic.ts`).
- **Precision:** decimals = the smallest `n` such that 10^-n ≤ one-tenth of a CSS pixel in user
  units (from the CTM scale at 1× zoom), clamped to [0, 3]. Never fewer decimals than the source
  segment already used. Strip trailing zeros and keep a leading `0.` (readability over bytes). Use
  the separator style detected from the source (`,` vs space). Optional pixel snap (Penpot
  `to-pixel-snap`) rounds anchors to whole CSS px in the svg's viewport.
- **Pencil output** is the simplified cubic list emitted fresh (there is no source to preserve),
  with the same precision rule.

### 5.4 Codemod `setSvgPartAttributes`

`src/core/ast-codemods/setSvgPartAttributes.ts`:
- `findJsxElementAtLocationOrThrow` for host and part, then
  `part.getFirstAncestor(n => n === hostWhole)` for containment;
- tag check against an SVG-content allowlist (`path`, `g`, `circle`, `ellipse`, `rect`, `line`,
  `polyline`, `polygon`, `text`, `tspan`, `defs`, `linearGradient`, `radialGradient`, `stop`,
  `use`, `svg`, `mask`, `clipPath`, `symbol`, `pattern`);
- per attribute: missing → `addAttribute`; a string literal → `setInitializer` with the
  quote-choice logic of `setJsxProp.buildInitializerText` (extract it as a shared helper); a
  numeric JSX expression literal (`strokeWidth={2}`) → keep the numeric form when the new value is
  a number; any other expression → refuse `svg-attr-expression`; a spread on the element → refuse
  `spread-attribute`;
- `remove` deletes literal attributes only;
- formatting-preserving through the same `EolPreservingFileSystem` project.

Refusals are returned rather than thrown, the same way `setStyledDeclaration` does
(`studioWriteback.ts:206-214`).

### 5.5 Insert: SVG markup → JSX, done right

`svgToJsxNode.ts` becomes `svgMarkupToInsertNode` (same file, renamed). The pipeline:
1. sanitise (browser);
2. DOMParser;
3. `normalizeImportedSvg(doc, idPrefix)`:
   - `<style>` blocks: inline simple `.class` / `tag` / `#id` rules as presentation attributes on
     matching elements, then drop the `<style>`. Refuse with a sentence if a rule uses a selector
     it cannot inline (a combinator or pseudo-class);
   - `style="a:b;c:d"` strings: SVG presentation properties (`fill`, `stroke`, `stroke-*`,
     `opacity`, `fill-opacity`, `fill-rule`, `clip-rule`, `stop-color`, `stop-opacity`,
     `font-*`…) become attributes, and the rest becomes a `style={{…}}` object via
     `InsertableJsxPropValue` (`renderJsxNode` already emits objects);
   - prefix every `id` with `idPrefix` (a slug from the file name or `svg`, plus a 4-char hash)
     and rewrite `url(#…)`, `href="#…"`, `xlink:href` → `href`, and
     `aria-labelledby`/`-describedby`;
   - drop `xmlns*`, `version`, `sodipodi:*`, `inkscape:*`, Illustrator `data-name`, and empty
     `<defs>`/`<metadata>`/`<title>` (keep `<title>` if non-empty: accessibility);
   - root: keep `viewBox`; if `width`/`height` are missing, derive them from `viewBox`; keep
     `fill="none"` if present; never add `xmlns`;
4. convert attribute names with `@core/vector/svgAttributeNames` (the one mapping shared with
   `inlineSvg.ts`, so both directions agree);
5. budgets: 256 elements, depth 12, and a new 32 KB rendered-JSX cap. Anything larger routes to
   `<img>` (drop) or refuses with a sentence (paste).

`base.svg` gains a real source spelling. Generalise `ModuleDefinition.sourceIntrinsic` from
`(props) => { tag, text? }` to `(props) => InsertJsxNode` (tag, props, children). `base.container`
and `base.text` return their current shapes and `base.svg` returns its converted subtree. There is
then ONE spelling hook, and `moduleAvailability` unhides `base.svg` without special-casing.
`commitStudioInsert` widens `children` to `InsertJsxChildren`.

---

## 6. Draw tools: SVG vs div (decision)

| Shape | Default | Why |
|---|---|---|
| Rectangle `R`, Ellipse `O` | **`<div>`** (unchanged `base.container` + `borderRadius: 50%`) | In a React repo a box is a div. It takes padding, children, text, flex, CSS classes and responsive width. An `<svg><rect/></svg>` is a dead end for a UI developer. This also matches the existing K4 behaviour and doc. |
| Line `L`, Arrow `⇧L` | **`<svg>`** with `<line>` (arrow: `<path>` shaft + `<path>` head, no `<marker>` so no ids) | A div line only does horizontal/vertical via border hacks. Diagonal lines and arrowheads are vector by nature. |
| Pen `P`, Pencil `⇧P` | **`<svg>`** + `<path>` | — |
| `R`/`O`/`L` while in vector edit mode | `<rect>`/`<ellipse>`/`<line>` parts inside the edited svg | The context decides, so users do not need a separate "vector rectangle" tool. |

**Placement:** a new `<svg>` is inserted **in flow** at `resolveCanvasInsertionTarget`, the same
resolver file drop uses, with:
- `width`/`height` = the drawn bbox (ceil, CSS px at 1×);
- `viewBox="0 0 w h"`;
- the path translated so the bbox origin is 0;
- defaults `fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"`.
  `currentColor` inherits text colour, which is the idiomatic form for code, rather than Figma's
  black 1 px.

The shape therefore appears where layout puts it, not necessarily where it was drawn. It is the
same honest trade-off `R`/`O` already make (`useCanvasToolShortcuts.ts:13-18`). During flight the
layer shows the stroke at the drawn position; on finish the optimistic node appears in flow, and
the layer animates the ghost into it (≤150 ms, and skipped under reduced motion).

**Owner decision D1:** offer "pin where drawn" when the target container is *already* a
positioning context (computed `position` ≠ `static`). It would write
`position: absolute; left; top` on the new svg. Never promote a static container.

Drawing inside an existing svg keeps full position fidelity, which is why the tool first
hit-tests for a literal svg host under the pointer.

**Pencil algorithm:**
- sample `pointermove` with `getCoalescedEvents()` (Penpot samples every 10 ms; coalesced events
  are strictly better), capped at 5,000 raw points;
- stream the raw polyline into the layer's `d` in rAF;
- on `pointerup`: radial-distance pre-pass (0.5 px ÷ zoom), then Douglas-Peucker (tolerance
  0.3 × stroke, Penpot's 0.3), then Schneider `fitCurve` (max error 1.5 px ÷ zoom) → `C`
  segments;
- a typical 3 s scribble becomes about 20–60 cubics and under 1.5 KB of `d`. Penpot emits line-tos
  only (`segment.cljc:869-891`), which is 5–10× larger and jaggy when edited.

---

## 7. Vector edit mode details (Penpot parity map)

| Penpot | Studio |
|---|---|
| `start-path-edit` on double-click / Enter | `enterVectorEdit(nodeId, frameId)` from `onNodeDoubleClick` (before `startInlineEdit`) and from `layers.selectFirstChild` Enter when the selection is a literal svg. Refuses by name for: `#n` host (map row), part with `d` in `data-studio-svg-code`, live frame, `props.tag` (`?raw` icon, SVG-11), > 5,000 anchors ("too many points to edit on the canvas — open in code"). |
| edit modes `:move` (`M`) / `:draw` (`P`) | same keys inside the `vector-edit` rung |
| `content-modifiers` during drag, `apply-content-modifiers` at the end | the model mutation lives in a ref; commit on `pointerup` (§5.2) |
| `move-handler-stream`: Alt breaks symmetry, snap to opposite at ±5° | same; Shift = 45° (`position-fixed-angle`) |
| `select-node`, marquee over points | click / ⇧-click / marquee in board space; spatial grid over anchors (bucket = 32 px ÷ zoom) for O(1) hit tests at 5k anchors |
| add-node `⇧+`, remove `Del`, merge `⌘J`, join `J`, separate `K`, corner `X`, curve `C`, snap toggle `⌘'` | v1: add, remove, corner, curve, close. Later: merge, join, separate. `K`/`C` are claimed by the rung only while editing, so the board's `K` (scale) and `C` (comment) are shadowed while in vector edit. Say so in the help list. |
| path-local undo stack, merged on exit | not needed for edit mode: each gesture is already a real undoable source write. Needed only for the in-flight pen session. |
| `convert-to-path` for rect/ellipse on edit | NOT automatic: `<rect>`/`<circle>`/`<ellipse>` get geometry handles (x/y/w/h/r/rx) written as their own attributes. "Convert to path" is an explicit action = `tag` kind (`setJsxTagName`) + `svg-attr` in one batch. |

Keyboard: a new rung `vector-edit` in `editorKeyDispatcher.ts`, directly under `inline-edit`
(`inline-edit > vector-edit > prototype-link > annotation > node > board > global`).
- It claims Escape/Enter (exit), arrows (nudge), Delete, `⌘Z` while a pen session is in flight,
  and the edit-mode letters.
- `useIframeEventForwarding.onKeyDown` does not need a new guard: vector edit keeps the real
  keydown path (unlike inline edit, no contentEditable owns keys).
- `useCanvas`'s React `onKeyDown` viewport keys stay live on purpose (zoom while editing is
  wanted).

---

## 8. Design pane

A new `VectorSection` (inspector manifest `inspector/sections/index.ts`, order just after Fill). It
applies when the selection is a literal-svg `base.svg` host, or when a vector session has parts
selected.
- **Rows:** Fill (`fill`: colour / `none` / `currentColor`), Fill rule, Stroke colour, Stroke
  width (ScrubInput), Dash (`strokeDasharray` presets plus a raw field), Cap, Join, Miter, Opacity.
- **Mixed values** across parts use the one multi-select Mixed contract (`docs/features/inspector.md`
  §9.3). Writes are one `svg-attr` edit per part in ONE batch, i.e. one gesture and one undo.
- **Where a write lands** (and this is shown in the row's write-target note, `colorWriteTargetNote.ts`):
  - host selected with no part selection: if every paint-bearing part inherits (no own `fill`),
    write the root `<svg>` attribute through `prop` kind; otherwise write each part;
  - `codeProps` / `data-studio-svg-code` attributes are read-only.
- **`FillSection` / `StrokeSection` for `base.svg`** today offer CSS `background` / `border`,
  which is technically writable but almost never what a designer means for a vector. For a
  literal svg host, relabel them "Box fill" / "Box border" under More, and put Vector first.
- **viewBox row:** readout, "Fit to content" (`getBBox()` union, rounded out, written as `viewBox`
  plus proportional `width`/`height`), and `preserveAspectRatio` select.
- **Resize semantics for an svg with a `viewBox`:**
  - proportional by default (the viewBox ratio), with ⇧ to free the ratio. This inverts K4's `K`
    for this node kind only; the tooltip explains it;
  - with a free ratio that differs from the viewBox, show a chip "Letterboxed — Stretch" that
    writes `preserveAspectRatio="none"`;
  - write-target rule: if the root has literal `width`/`height` *attributes* and no class/inline
    size, the resize writes those attributes (via `prop`); otherwise it writes the inline style
    (existing path). Never both.

---

## 9. Work orders

Effort: S ≤ 1 day, M 2–4 days, L 5–8 days (single specialist).

### SVG-0 — Render a literal `<svg>` as itself (no wrapper) — canvas-engineer — S

- **Modify:** `src/modules/base/svg/SvgEditor.tsx`, new `src/modules/base/svg/splitSvgRoot.ts`
  (cached DOMParser split, uses `@core/vector/svgAttributeNames`; if SVG-1 has not landed, a local
  copy of the mapping to be replaced there), `src/admin/pages/site/canvas/resizeOffer.ts`
  (verify: it now offers resize), `docs/agent-refs/canvas-internals.md` (remove the "`base.svg`
  host is `display: contents`" note).
- **Tests:** `src/__tests__/canvas/svgHostIsTheSvg.test.ts`. Use `iframeCanvasQuery` and happy-dom
  `GlobalWindow`: `[data-node-id]` IS the `<svg>`; `.row > svg` matches; `:first-child` matches;
  editor props are on the svg; case-2 `?raw` wrapper unchanged.
- **Risk:** React warnings for markup attribute names. Mitigated by converting names.
  `dangerouslySetInnerHTML` on `svg` is supported.
- **Perf:** one DOMParser per unique markup (LRU cache).

### SVG-1 — `@core/vector` pure engine — test-engineer + canvas-engineer — M

- **Create:** `src/core/vector/{index,pathData,pathModel,pathGeometry,arcToCubic,simplify,precision,svgAttributeNames,svgPartStamps}.ts`.
- **Modify:** `src/core/page-parser/inlineSvg.ts` (use `svgAttributeNames`),
  `src/admin/pages/site/studio/svgToJsxNode.ts` (same),
  `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` (add `@core/vector`), CLAUDE.md
  barrel list.
- **Tests:**
  - byte-identical round trip over `vendor/alm-design-system/src/icons/**/*.svg` (568 files);
  - property tests: split-at-t keeps the curve (max deviation < 1e-6), nearest point, bbox vs
    brute force;
  - relative-path anchor move re-emits exactly two segments;
  - precision policy table;
  - simplify: synthetic circle scribble → ≤ 12 cubics within 1.5 px;
  - perf: parse + serialise a 100 KB `d` in < 5 ms.
- **Risk:** relative-command bookkeeping; arc edge cases (zero radii, large-arc flags written
  without separators, e.g. `a1 1 0 01 2 2`).

### SVG-2 — Import normalisation + sanitiser allowances — security-guard (owner) + canvas-engineer — M

- **Modify:** `src/core/sanitize.ts` (`uponSanitizeAttribute` hook keeping `href`/`xlink:href`
  only for `^#[\w.-]+$`, scoped to the svg config),
  `src/admin/pages/site/studio/svgToJsxNode.ts` → rename to `svgMarkupToInsertNode.ts` with
  `normalizeImportedSvg`, `server/handlers/studio/assetLanding.ts` (`sanitizeSvgBytes` parity for
  the `href="#"` rule), `src/__tests__/studio/svgToJsxNode.test.ts` (rename + cases).
- **Tests:**
  - `style="fill:#fff;stroke-width:2"` → attributes;
  - an Illustrator `<style>.cls-1{fill:#f00}</style>` → inlined;
  - two inserts of the same gradient icon → distinct ids and rewritten `url(#…)`;
  - `<use href="#a">` kept, `<use href="https://…">` stripped, `javascript:` stripped;
  - unsupported selector → refusal sentence;
  - an end-to-end JSX output renders under React without throwing (use `react-dom/server`
    `renderToStaticMarkup` on the rendered JSX string via a tiny `new Function`-free path: parse
    with the test's TSX loader).
- **Risk:** the security surface. Get a security review of the `href` hook: fragment-only, no
  `data:` or `javascript:`.

### SVG-3 — Part stamps in the parse — parser-surgeon — S/M

- **Modify:** `src/core/page-parser/inlineSvg.ts` (emit `data-studio-svg-part`,
  `data-studio-svg-code`), `src/core/page-parser/iconPropValues.ts` (verify icon-prop svgs are
  stamped), `src/admin/pages/site/panels/PropertiesPanel/nodeExportModel.ts` +
  `SvgControl.tsx` + the publisher `escapeProps` svg path (call `stripSvgPartStamps`),
  `docs/agent-refs/studio-pipeline.md` (new "SVG parts" paragraph), `docs/features/studio-import.md`.
- **Tests:** `src/core/page-parser/__tests__/imageAssetsAndInlineSvg.test.ts` (stamps equal each
  element's `getStartLineNumber()`/column; an expression attribute is listed in code; a
  sanitiser-removed sibling does not shift stamps); `src/__tests__/architecture/svg-part-stamps-stripped.test.ts`
  (every reader of `props.svg` outside canvas render goes through the strip).
- **Risk:** the 64 KB cap is reached earlier (stamps add bytes). Measure on the corpus, and
  exclude stamp bytes from the cap check.

### SVG-4 — `svg-attr` edit kind + codemod — server-engineer + parser-surgeon — M

- **Create:** `src/core/ast-codemods/setSvgPartAttributes.ts` (+ export from barrel),
  `src/core/ast-codemods/__tests__/setSvgPartAttributes.test.ts`.
- **Modify:** `server/handlers/studioEditSchemas.ts` (+ `SvgAttrEditSchema` into the union),
  `server/handlers/studioWriteback.ts` (dispatch + refusal translation),
  `src/core/ast-codemods/setJsxProp.ts` (extract `buildInitializerText` to shared),
  `src/admin/pages/site/studio/studioSaveRequests.ts` (client type),
  `docs/reference/editor-history.md` (inverse form).
- **Tests:**
  - containment refusal (part outside host; part not an svg tag);
  - `d={X}` refusal (`svg-attr-expression`);
  - spread refusal;
  - numeric stays numeric;
  - CRLF file round trip;
  - multi-attribute set + remove is one write;
  - a composite `~` host writes to the tail file.
- **Risk:** line/col drift after a same-line edit. The session re-resolves by ordinal.

### SVG-5 — Insert flows: paste, drop, icon picker — store-engineer (owner) + canvas-engineer — M

- **Modify:**
  - `src/core/module-engine/types.ts` (generalise `sourceIntrinsic` → `InsertJsxNode`);
  - `src/modules/base/{container,text}/index.ts`, `src/modules/base/svg/index.ts` (declare it);
  - `src/admin/pages/site/store/slices/site/studioSourceWrites.ts` (subtree insert; `:656` spelling helper);
  - `src/admin/pages/site/studio/studioStructuralCommits.ts` (`children: InsertJsxChildren`);
  - `src/admin/pages/site/store/slices/site/structuralOptimism.ts` (`base.svg` ghost with markup);
  - `src/admin/pages/site/canvas/frameAdapter/optimisticStructuralBroadcast.ts` (bridge frames: tag-only ghost is acceptable);
  - `src/admin/pages/site/canvas/canvasFileDrop.ts` + `useCanvasFileDrop.ts` (inline-vs-img decision, Alt inverts);
  - `src/admin/pages/site/panels/AssetsPanel/IconsSection.tsx` + `assetsModel.ts` (click = insert beside selection, drag = insert at target; "Copy SVG" stays in its context menu);
  - `src/admin/pages/site/canvas/useCanvasNodeShortcuts.ts` (`layers.paste` stops `preventDefault`);
  - new `src/admin/pages/site/canvas/canvasClipboardBridge.ts`;
  - `src/admin/pages/site/canvas/useIframeEventForwarding.ts` (attach the bridge per frame doc);
  - `src/__tests__/architecture/keybindings-single-dispatcher.test.ts` (allowlist + gate);
  - `docs/agent-refs/canvas-internals.md` (6th bridged event).
- **Tests:**
  - paste decision table (Studio token / SVG text / image file / fallback);
  - drop budget routing;
  - icon click writes an `insert` with an svg subtree and selects `createdNodeIds`;
  - undo of the insert posts `delete`.
- **Risk:** changing ⌘V from keydown-driven to paste-event-driven. Firefox and Safari fire `paste`
  only on editable targets or document focus. **Verify in the dogfood** that a paste fires with
  focus on the canvas root (a `tabIndex` div) and inside a frame document. If Safari refuses,
  fall back to keydown + `navigator.clipboard.read()` behind the first-use prompt.

### SVG-6 — Vector edit mode (existing svgs) — canvas-engineer (owner) + store-engineer — L

- **Create:**
  - `src/admin/pages/site/canvas/BoardVectorLayer/{BoardVectorLayer.tsx,BoardVectorLayer.module.css,vectorLayerGeometry.ts,useVectorEditGestures.ts,vectorHitGrid.ts}`;
  - `src/admin/pages/site/store/slices/vectorEditSlice.ts`;
  - `src/admin/pages/site/canvas/useVectorEditKeyboard.ts` (the `vector-edit` rung).
- **Modify:**
  - `canvas/StudioBoardLayers.tsx` (mount);
  - `canvas/useCanvasNodeInteraction.ts` (double-click enters; exit on selection change);
  - `canvas/editorKeyDispatcher.ts` (rung order);
  - `src/admin/spotlight/keybindings.ts` (`vector.*` bindings: M, P, ⇧+, Del, C, X, arrows, Enter/Esc);
  - `store/slices/site/*` (new action `commitSvgPartAttributes`: optimistic markup + source-gesture history + queue);
  - `docs/agent-refs/canvas-internals.md` (new "Vector editing" section), `docs/agent-refs/editor-store.md`, `docs/agent-refs/path-index.md`.
- **Tests:**
  - geometry: board ↔ part mapping through a nested `transform` and viewBox scale;
  - gesture: 200 synthetic `pointermove` → 0 store commits, 1 `svg-attr` on up;
  - no-op drag → 0 writes;
  - arrow nudge burst → 1 write;
  - refusals by name;
  - Escape exits and Delete removes an anchor, not the node.
- **Risk:**
  - interplay with `CanvasResizeHandles` and the selection ring (hide both while in edit mode);
  - the Alt tree ladder (stands down in edit mode, as for inline edit);
  - posters (`framePosterQueue`): hold during the session.

### SVG-7 — Draw tools: pen, pencil, line, arrow — canvas-engineer — L

- **Modify:**
  - `canvasSlice.ts` (`CanvasTool` += `'pen' | 'pencil' | 'line' | 'arrow'`);
  - `useCanvasToolShortcuts.ts` (`P`, `⇧P` [+`⇧C` alias per D2], `L`, `⇧L`; in edit mode `R`/`O`/`L` draw parts);
  - `canvasPanInput.ts` (new capture flag source) + `IframeFrameSurface.tsx` (iframe `pointer-events: none` while it is set);
  - `BoardVectorLayer` (draw sessions);
  - `studioSourceWrites.ts` (insert svg at target or a path into a host);
  - toolbar tool buttons (panel-designer, S) and `HelpKeybindingsList`.
- **Tests:**
  - pen: corner/smooth/close/finish produce the expected `d` and ONE insert;
  - pencil: coalesced-event scribble → one insert with a bounded `d` size;
  - line/arrow produce valid JSX (no ids);
  - drawing over an existing svg appends a `<path>` to it;
  - Escape with < 2 anchors writes nothing.
- **Risk:** the in-flow placement surprise (D1). Clear feedback: the ghost animates to the landing
  spot.

### SVG-8 — Vector design section + svg resize semantics — panel-designer (owner) + canvas-engineer — M

- **Create:** `src/admin/pages/site/inspector/sections/VectorSection.tsx` (+ `.module.css`).
- **Modify:** `inspector/sections/index.ts` (manifest), `FillSection.tsx`/`StrokeSection.tsx`
  (relabel for a literal svg host), `canvas/elementResize.ts` + `useElementResizeDrag.ts`
  (viewBox-proportional default, attributes-vs-style target rule), `docs/features/inspector.md`.
- **Tests:** Mixed across three parts; one batch = one undo; a code attribute renders read-only;
  resize writes attributes when the root has literal `width`/`height`.
- **Risk:** the inspector height budget (`inspector-height` e2e, `panel-41`). Keep Vector ≤ 5 rows
  collapsed.

### SVG-9 — Perf + e2e gates — perf-hunter + test-engineer — M

- **Create:** `tests/e2e/studio-vector.e2e.ts` on a fixture copied with
  `tests/e2e/helpers/studioFixtureProject.ts` (never dirty `test4`), with a page holding one
  2,000-anchor path and 50 icons.
- **Assertions** (computed layout, per `standing-02`):
  - anchor-drag p95 frame ≤ 16.7 ms at 0.25/1/4 zoom, using `tests/e2e/helpers/canvasPerf.ts`;
  - React commit count during the drag = 0 (profiler hook);
  - exactly one `/save` request per gesture;
  - after commit, the in-frame `path.getAttribute('d')` equals the file's `d` after resync;
  - the frame's `scrollHeight` is unchanged across the gesture (no height feedback);
  - pan during edit mode keeps the budget of `studio-board-perf`.
- Add to the `e2e-budgets` CI slice.

### SVG-10 — Boolean ops, outline stroke, flatten (later) — canvas-engineer — L

Penpot `common/types/path/bool.cljc` (429 lines) is the reference: segment intersection +
winding + rebuild. Needs a robust intersection core (evaluate `paper.js` boolean,
bundle-size-gated, vs porting Penpot's). Writes are one `svg-attr` (the result `d`) plus `delete`
of the consumed parts in one batch. Owner decision D4 whether it is worth it for a code-first tool.

### SVG-11 — External SVG files (later) — parser-surgeon — M

- **SVGR** (`import Logo from './logo.svg?react'`, `{ ReactComponent as Logo }` with
  `vite-plugin-svgr` detected in the Vite config): render read-only as `base.svg` with the file's
  text (reading an asset is not executing it; the same trust posture as `?raw`), locked with the
  reason "SVG lives in logo.svg".
- **`?raw` + `dangerouslySetInnerHTML`:** already rendered; stays read-only for vector editing.
- **Remedy "Inline to edit"** (both cases): one batch of `insert` the JSX subtree (SVG-2
  converter), `delete` the old element, then `pruneOrphanedImports`. It carries a RefusalDialog
  remedy.
- **Editing the external `.svg` file in place** needs a formatting-preserving XML CST codemod,
  which does not exist. Out of scope; decision D3.

Optional (mcp-tooling, S): `studio_insert_svg` MCP tool over the same SVG-5 converter and insert
path, so the agent never hand-writes SVG JSX with `style=` strings.

### Sequencing

```
SVG-0 ──┐
SVG-1 ──┼─► SVG-2 ──► SVG-5 ─┐
        └─► SVG-3 ──► SVG-4 ─┼─► SVG-6 ─► SVG-7 ─► SVG-8 ─► SVG-9 (gates run from SVG-6 on)
                             └──────────────────────────────► SVG-11 (later), SVG-10 (later)
```

- SVG-0 and SVG-1 can run in parallel with no shared files.
- SVG-3 (parser) and SVG-2 (sanitise/convert) touch disjoint files.
- SVG-5 and SVG-6 both touch `studioSourceWrites.ts`, so run them serially.

---

## 10. Owner decisions needed

- **D1 — Placement of newly drawn svgs.** In flow (recommended default, consistent with R/O/file
  drop) vs. "pin where drawn" when the parent is already positioned.
- **D2 — Pencil key.** `⇧P` (Figma; the repo names tools after Figma per
  `useCanvasToolShortcuts.ts:8-9`) vs `⇧C` (Penpot, as the task asked). Recommend `⇧P` primary
  with a `⇧C` alias.
- **D3 — External `.svg` editing.** Read-only plus "Inline to edit" (recommended), vs. building an
  XML CST codemod.
- **D4 — Boolean ops at all.**
- **D5 — Default stroke for drawn paths.** `currentColor` / 2 px / round (recommended) vs. Figma's
  black 1 px.
- **D6 — Mirrored `d` preview on the real element during drag.** Recommended on. It is an
  imperative write into user DOM that React does not own, and it is guarded by `canvasGesture`. If
  the owner wants strictly overlay-only, turn it off and the underlying shape jumps on
  `pointerup`.

---

## 11. Landmines (for the STATE.md handoff — height × injectors × events)

1. **⌘V keydown `preventDefault` kills the native `paste` event.** SVG paste is impossible while
   `layers.paste` handles the key itself. Moving paste to the `paste` event requires bridging it
   from every design-frame document (6th bridged event). The keyboard clone dispatched on the
   parent `document` does NOT produce a `paste` event.
2. **An imperative attribute write inside a frame wakes two observers.** Both
   `PortalFrameAdapter.ts:178` and `overlayMeasureScheduler.ts:238` observe
   `attributes: true, subtree: true`. A per-`pointermove` `d` write becomes a per-frame
   re-measure (and a frame-fit pass) unless it happens inside `beginCanvasGesture()`/`endCanvasGesture()`.
   The svg box does not change with its content, so there is no height feedback, but the observer
   cost is real.
3. **The optimistic markup update replaces `innerHTML`.** Every inner element is recreated, so any
   ref to an in-frame `<path>` held across a commit is stale. Always re-query by
   `data-studio-svg-part`.
4. **The 64 KB `MAX_MARKUP_LENGTH` is a cliff, not a limit.** A write that grows an svg past it
   (a long pencil stroke into a big illustration) comes back from the resync LOCKED as "SVG built
   in code". The client must refuse the commit before posting if the optimistic markup exceeds the
   cap.
5. **The sanitiser strips `href` everywhere.** `<use href="#x">` and gradient `href` inheritance
   silently render blank until SVG-2's fragment-only hook lands.
6. **`SvgEditor`'s `display: contents` span** (pre-SVG-0) breaks `>`/`+`/`:first-child` selectors
   and blocks resize handles for literal svgs.
7. **Part stamps leak at exits.** `props.svg` now carries `data-studio-svg-part`, so every exit
   (SVG export, copy, publisher, MCP reads) must strip them. A gate test enforces this.
8. **In-frame chrome does not counter-scale zoom** (9 px handles at 25% zoom are 2 px). Vector
   chrome must live in the board layer and use `--canvas-zoom`, not the in-frame overlay root.
9. **Drawing tools must make iframes `pointer-events: none`,** or the first `pointerdown` inside a
   frame selects a node instead of starting a path. Use a new capture-flag source, not the
   space-pan flag, because pan-aware code reads the pan flag and would start panning.

---

## 12. Dogfood instruction (for when SVG-0/5/6/7 land)

- **Route:** `/admin/site` on a copy of `studio-workspace/test4` plus one page containing an
  inline icon `<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>` inside a `.row` whose CSS
  has `.row > svg { width: 48px }`.
- **Board:** 3 frames, zoom 100%, then 25%, then 400%.
- **What must be true:**
  1. The svg renders 48 px wide (SVG-0 selector fix), and dragging its edge resizes it
     proportionally.
  2. Double-click the svg: 4 anchors appear; at 25% zoom they are still about 10 px on screen.
  3. Drag one anchor: the real fill follows the cursor, the Network panel shows exactly one
     `POST /admin/api/studio/save` on release, and the `.tsx` now reads `M4 4h16v16H…` with only
     the moved segment changed. `⌘Z` restores the original byte-for-byte.
  4. Press `P`, click three points on empty space inside a frame, then Enter: one new `<svg>`
     appears in flow and the file gains one element with `stroke="currentColor"`.
  5. Paste an Illustrator-exported SVG with a `<style>` block: it inserts, with no `style=` string
     in the written JSX.
  6. Panning with space during steps 2–4 stays smooth (no visible lag), and the frame height does
     not change during any drag.
