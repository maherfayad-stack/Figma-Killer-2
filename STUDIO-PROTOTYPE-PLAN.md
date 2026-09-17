# Studio Prototype Mode — plan

**Status:** every phase (1a–7) has landed, richer triggers and
`smart-animate` with `STUDIO-FIGMA-FEEL-PLAN.md`'s P7. What remains is the
one item in §9 ·
**Opened:** 2026-09-02 · **Last updated:** 2026-09-17

Shipped behaviour is documented in
[`docs/features/studio-prototype.md`](docs/features/studio-prototype.md) — read
that for what the feature *is*. This file is the plan, and stays as the record
of what was decided, what was disproved, and what remains.

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
- **Phase 6 reads real navigation out of the code and draws it too.** The user's
  screens carry `onClick` handlers that navigate; the parser reads them into
  `CodeFlowEdge`s (`src/core/studio-prototype/codeFlow.ts`) that render as
  *read-only* connectors, drawn differently from authored ones. The board shows
  flows that are already true on day one — the part Figma structurally cannot
  do. The `origin: 'design' | 'code'` discriminator this bullet originally
  proposed did not survive Phase 6; see "What Phase 6 disproved".

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
| `navigate` | replaces the screen | `instant`, `dissolve`, `smart-animate`, `slide-left`, `slide-right`, `push-left`, `push-right` |
| `overlay` | presents on top, base screen stays | `popup` (centred + scrim), `sheet` (bottom, slides up) |
| `back` | pops the history stack | reverses whatever brought you here |
| `close` | dismisses the top overlay | reverses its presentation |

Trigger was `click` in Phase 1. It is now one of five — `click`, `hover`,
`press { reverseOnRelease }`, `after-delay { ms }`, `key { key }` — a tagged
union rather than a string enum, because two of them carry data. Every trigger
is legal for every action; the table above is about what a link DOES, and that
is a separate question from what makes it fire. See
`docs/features/studio-prototype.md` → "Five triggers, and where each one is
delivered".

The overlay transitions line up with the existing
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

## 6. Phases

- **[x] 1a — `@core/studio-anchor` (S).** Extract the node-hint + resolution
  primitive out of `studio-comments`; re-point its 12 callers. No behaviour change.
- **[x] 1b — `@core/studio-prototype` model + serializer (S/M).** TypeBox schemas,
  tolerant parse, `prototypeModel` add/update/remove/prune. Gates: round-trip,
  unknown-action/transition coercion, pruning links whose target page is gone.
- **[x] 2 — Server store + routes (S/M).** `server/handlers/studio/prototypeStore.ts`
  and `prototypeRoutes.ts`, mirroring `commentsStore`/`commentsRoutes`. One op per
  POST, not the whole file.
- **[x] 3 — Prototype mode + inspector (M).** `boardMode`, the toggle, the
  right-panel swap. **Two deviations, both deliberate:**
  - `boardMode` lives in the new `prototypeSlice`, not `uiSlice`. Every reader of
    it is already reading `codeFlow` or `prototype`, so putting it in `uiSlice`
    would make one question cost two slice subscriptions. (`canvasView` stays in
    `uiSlice`: it means something on every CMS route, this does not.)
  - The mode is a pressed-state **toggle**, not a third tab beside Design/Live.
    Those two are exclusive canvas *surfaces*; this is an overlay on the design
    board, and modelling it as a tab would have implied you leave the design
    canvas to use it.
- **[x] 4 — Connectors (M/L — the hard one).** Two layers, one feature
  (`canvas-12`). `BoardFlowLayer` in `StudioBoardLayers`, alongside
  `BoardCommentsLayer`, in the parent document, in board coordinates,
  counter-scaled in pure CSS, draws the **derived** frame-to-frame edges — a
  claim about two screens has no element to start from, and measuring one per
  edge is the stutter machine `BoardFlowLayer.tsx`'s module doc warns about.
  `src/admin/pages/site/canvas/BoardPrototypeLayer/` draws the **authored**
  links element-anchored and carries the `+` handle, the drag/pick gesture and
  the `back`/`close` chips. Endpoints are measured off a `ResizeObserver` per
  source frame and nothing else (`usePrototypeEndpoints.ts`).
- **[x] 5 — Play in live mode (M/L).** History stack, transition runtime,
  back/close, scrim dismiss, reset (`canvas-12`). The stack machine is
  `src/core/studio-prototype/playback.ts`; the canvas side is
  `canvas/PrototypeScreenStack.tsx`, `canvas/PrototypeOverlay.tsx`,
  `canvas/usePrototypePlayback.ts` and the WAAPI transitions in
  `canvas/playbackMotion.ts`. `setCanvasView` arms and disarms the player.
- **[x] 6 — Code-derived connectors (M).** The differentiator in §1. Four AST
  rules, all refusing rather than guessing — `docs/features/studio-prototype.md`
  enumerates them and, more importantly, what they refuse.
- **[x] 7 — Docs + `STATE.md`.** `docs/features/studio-prototype.md`.

### What Phase 6 disproved

§1 above says the link model carries `origin: 'design' | 'code'` "so this stays
open". It did not survive contact. A derived edge is recomputed from the source
on every load, so it has no id to keep stable, no `NodeHint` to re-resolve and no
transition anybody chose — three fields it would have had to fabricate — and it
needs one field a `PrototypeLink` has no room for: the snippet it was read out
of, which is the whole justification for a connector the user cannot edit.

So `origin` is **gone** from `PrototypeLinkSchema` (it had exactly one possible
value left) and a derived edge is `CodeFlowEdge` in
`src/core/studio-prototype/codeFlow.ts`. Everything else in §1 held.

## 7. Architecture gates on this feature's path

Both are easy to trip and annoying to debug:

- `single-drag-mechanism.test.ts` bans `@dnd-kit` and HTML5 `dataTransfer` in new
  files. The connector drag must be **raw pointer events**.
- `canvas-overlay-pointerdown.test.ts` bans `stopPropagation` in `onPointerDown`
  anywhere under `canvas/` — it poisons use-gesture's tap state and kills every
  click on the canvas.

## 8. Branch base

Resolved. Phase 1's work merged to `main` as PR #3, and everything since is cut
from `main` in the normal way. The 2026-09-02 note about `main` being 171 commits
behind no longer applies.

## 9. What is left

Three of the five items this section used to list — Play, the drag-from-`+`
gesture, and element-level anchoring for authored connectors — landed together
in `canvas-12` and are described under Phases 4 and 5 above. The `+` handle's
open design question ("where does it live, given the selection ring is portaled
*into* the frame's iframe?") was answered by putting the authored layer in the
parent document: `BoardPrototypeLayer/` composes `frame origin + element rect`
and inserts nothing into a frame. Richer triggers and smart-animate were
specced in `STUDIO-FIGMA-FEEL-PLAN.md` work order P7 rather than here, and have
since landed — see the note at the end of this section.

One is left. Nothing here blocks anything above it. Pruning on page delete
landed with P7 — `deletePage` calls `pruneLinksForDeletedPage`
(`studio/prototypePrune.ts`), client-side because the `prune` op carries the
page list by design.

1. **`back`-shaped derived flows.** `router.back()` / `navigate(-1)` /
   `history.goBack()` are real facts with no drawable destination. Worth
   surfacing once there is a flows list to surface them in.

Landed since, from `STUDIO-FIGMA-FEEL-PLAN.md` work order **P7**: the trigger is
no longer only `click` (§4), and a `navigate` can wear **`smart-animate`** —
matched element by element through the same `NodeHint` re-resolution
`.studio/prototype.json` anchors use, flown on ghosts in the parent overlay
because both screens are live iframes and neither may be written into.
