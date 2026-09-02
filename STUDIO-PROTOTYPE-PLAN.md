# Studio Prototype Mode — plan

**Status:** Phases 1-7 shipped · **Branch:** `feat/prototype-mode` · **Opened:** 2026-09-02

The ask: click interactions between screens, with a transition (dissolve, popup,
sheet, slide/push left/right), a back action, Figma-style connector lines drawn
on the board, a Design/Prototype mode switch in the canvas chrome, a prototype-only
inspector, and a drag-from-`+`-to-target gesture to author a link.

---

## 1. The decision: where a prototype link lives

**Chosen: A — a design layer, never the user's source.**

A prototype link is by construction *not* in the code. Writing real `onClick`
handlers into the `.tsx` files (option B) would force Studio to decide **how the
user's project navigates** — router? local state? context? — and to inject a
transition runtime into their repo. Studio's own invariant is that it refuses a
write without exactly one honest target, and "make a sheet slide up from here"
has no single honest target in arbitrary React.

This is not a fidelity violation. `boards.json` already stores frame positions,
sticky notes, doc cards and ruler guides, and `.studio/comments.json` already
stores review threads anchored to elements. None of that exists in the user's
source. Annotation *on* the document is not the document.

Two things keep it from becoming a lie:

- Connectors render **only in prototype mode**. Design mode never shows them and
  the publisher never sees them.
- **Phase 5 reads real navigation out of the code and draws it too.** The user's
  screens already have `onClick` handlers that navigate; the parser already sees
  them and currently drops them as `codeFunctionPaths`. Those become *read-only*
  connectors, drawn differently from authored ones. The board then shows flows
  that are already true on day one — the part Figma structurally cannot do. The
  link model carries `origin: 'design' | 'code'` from Phase 1 so this stays open.

## 2. Storage: `.studio/prototype.json`, not `boards.json`

The earlier sketch put links on `BoardsFile`. Recon says that is wrong, for the
same three reasons `@core/studio-comments` gives for its own separate file
(`src/core/studio-comments/types.ts`, "WHY A SEPARATE FILE FROM boards.json"):

- `boards.json` rides an 800 ms dirty-flag autosave (`useStudioBoardsPersistence`).
  Link authoring has no business on that path.
- A flow is worth reading as a git diff on its own.
- **Links outlive the board they were drawn on.** A link is about a page and an
  element, not about board furniture. Removing a frame from a board must not
  destroy the flow through that screen.

So `@core/studio-prototype` mirrors `@core/studio-comments`: its own core module,
its own tolerant serializer, its own server store, its own file.

## 3. Anchoring: `(pageId, nodeId)` is not enough

The earlier sketch anchored a link at `(pageId, nodeId)`. **Studio node ids are
`relFile:line:col`** and therefore rot on almost every edit above the node. A link
stored that way would break constantly and silently.

`studio-comments` already solved exactly this, and its solution is not
comment-specific: a `NodeHint` of `{ nodeId, indexPath, moduleId, textSnippet }`
plus a re-resolution pass that returns a confidence of
`exact | moved | drifted | detached`. `indexPath` survives edits above the node,
`moduleId` rejects a match on a different kind of node, `textSnippet` separates
"this moved" from "something else took its address".

**Phase 1a extracts that primitive into `@core/studio-anchor`** so both features
depend on a leaf rather than prototype depending on comments. The one difference:
a comment may legitimately be `unanchored` (a pin on empty canvas), a link may
not — you click an element or there is no link. A `detached` link renders as a
visibly broken connector rather than disappearing.

## 4. Interaction model

| Action | What it does | Transitions |
|---|---|---|
| `navigate` | replaces the screen | `instant`, `dissolve`, `slide-left`, `slide-right`, `push-left`, `push-right` |
| `overlay` | presents on top, base screen stays | `popup` (centred + scrim), `sheet` (bottom, slides up) |
| `back` | pops the history stack | reverses whatever brought you here |
| `close` | dismisses the top overlay | reverses its presentation |

Trigger is `click` in Phase 1. The overlay transitions line up with the existing
`PageKind` vocabulary (`screen | popup | sheet-small | sheet-large`,
`@core/studio-board/pageKinds.ts`), so a link to a sheet page can default its
transition from the target's kind instead of asking.

## 5. UI

The canvas chrome already has a Design/Live toggle (`CanvasModeToggle.tsx`,
store field `canvasView`). Design and Prototype are **board modes**; Live is the
**player**, and gains an explicit armed **Play** state:

```
[ ▸ Design | ⌁ Prototype ]   [ 👁 Live ]  [ ▶ Play ]
      board editing mode        player    (live only)
```

Without that split, a click in live mode means both "select this node" and
"follow this link", which is not resolvable.

**Panel note:** the inspector is on the **right** (`RightSidebar.tsx`), not the
left. "on the left is only the prototype stuff" is read as "the inspector shows
only prototype stuff" — the right panel's body swaps in prototype mode, the way
Figma's Design/Prototype tabs work. A left-rail Flows panel is additive and can
follow.

## 6. Phases — all shipped

- **1a ✅ `@core/studio-anchor`.** Node-hint + resolution primitive extracted out
  of `studio-comments`; 12 callers re-pointed. No behaviour change. Comments kept
  their policy half as `agentGate.ts`.
- **1b ✅ `@core/studio-prototype` model + serializer.** Schemas, tolerant parse,
  link operations. The serializer repairs what is derivable and drops only what
  would mean inventing a flow.
- **2 ✅ Server store + routes.** `prototypeStore.ts` + `prototypeRoutes.ts`,
  op-shaped (`upsert`/`remove`/`prune`). An empty `prune` is refused rather than
  obeyed.
- **3 ✅ Prototype mode + inspector.** `boardMode` landed in `canvasSlice`, NOT
  `uiSlice` as planned — see §9. The right sidebar replaces the inspector.
- **4 ✅ Connectors and the `+` drag.** `BoardPrototypeLayer`, all geometry in
  board space, measurement driven by a `ResizeObserver` on the source frame's
  document and by nothing else.
- **5 ✅ Play in live mode.** Stack machine in `playback.ts`, overlay + scrim,
  CSS entrance transitions. Known limit below.
- **6 ✅ Code-derived connectors.** Bounded, literal-only navigation reading in
  the parser; derived links are never persisted.
- **7 ✅ Docs.** [`docs/features/prototype-mode.md`](docs/features/prototype-mode.md),
  `docs/README.md`, `docs/agent-refs/path-index.md`.

## 7. What changed from this plan while building it

Three things the plan got wrong, all caught by recon or by a gate:

1. **Branch base.** The plan said "off `main`". `main` was 171 commits behind
   this line of work; branching there would have discarded the custom camera
   engine, comments, i18n and the framework rem fix.
2. **Storage.** The first sketch put links on `BoardsFile`. `studio-comments`
   shipped in between and its own doc argues the opposite, for reasons that apply
   exactly. Moved to `.studio/prototype.json`.
3. **Anchoring.** The plan anchored at `(pageId, nodeId)`. Node ids are
   `relFile:line:col` and rot, so every link would have broken silently. Hence
   Phase 1a, which was not in the original plan at all.

And one the gates corrected: `boardMode` was written into `uiSlice`, which pushed
that file past the 700-line god-file ceiling. It belongs in `canvasSlice` beside
`canvasView` anyway — both answer "how is the canvas being used".

## 8. Known limits, accepted for v1

- **Only the incoming screen animates.** A true `push` moves the outgoing screen
  too, which needs both mounted at once and would double frame mounts on every
  navigation.
- **`indexPath` is structural**, so wrapping a section in a new element shifts
  every descendant's path and reads as `detached`. Fails toward "I don't know",
  which is the safe direction.
- **One trigger.** `click` only; `hover` and `drag` are additive.
- **Derived links are `navigate` only.** A handler that opens a sheet in local
  state is indistinguishable from one that replaces the screen without knowing
  the component, and guessing would attribute a design decision to the source.

## 7. Architecture gates on this feature's path

Both are easy to trip and annoying to debug:

- `single-drag-mechanism.test.ts` bans `@dnd-kit` and HTML5 `dataTransfer` in new
  files. The connector drag must be **raw pointer events**.
- `canvas-overlay-pointerdown.test.ts` bans `stopPropagation` in `onPointerDown`
  anywhere under `canvas/` — it poisons use-gesture's tap state and kills every
  click on the canvas.

## 8. Branch base

Not `main`. As of 2026-09-02 `main` is **171 commits behind** this line of work
and 1 ahead (a docs checkpoint, `200898d`). Branching off `main` would discard the
custom camera engine, comments, i18n and the framework rem fix. This branch is cut
from the current working head.
