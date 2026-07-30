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
    head ← ClassStyleInjector            @layer user-authored — reset + class registry
    head ← UserStylesheetInjector        @layer user-authored — user stylesheets
    head ← AlmDesignSystemCssInjector    unlayered  — design-system CSS
    head ← CanvasAnimationInjector       !important — design frames only
    body ← createPortal(<NodeRenderer/>)
    body ← RuntimeScriptInjector         only when "Run scripts" is on
```

**Cascade order matters and is deliberate.** Unlayered always beats `@layer`d
regardless of specificity, so user CSS can never override editor chrome. The
animation injector needs `!important` because it must beat *another unlayered*
stylesheet (the design system's) whose selectors are more specific than `*`.

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
one extra screen of margin so panning doesn't pop frames.

**Never** add a full-site scan inside a `useEditorStore(selector)` callback.

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
