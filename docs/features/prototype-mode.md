# Prototype mode

Click interactions between screens, drawn as connectors on the board and
playable in live mode. Studio's answer to Figma prototyping, plus one thing
Figma structurally cannot do: it also draws the flows the user's code already
has.

Plan and phase log: [`STUDIO-PROTOTYPE-PLAN.md`](../../STUDIO-PROTOTYPE-PLAN.md).

---

## 1. A link is a design layer, never a write into the source

A prototype link is by construction *not* in the code. Writing real `onClick`
handlers into the user's `.tsx` files would force Studio to decide **how their
project navigates** — router? local state? context? — and to inject a transition
runtime into their repo. Studio's invariant is that it refuses a write without
exactly one honest target, and "make a sheet slide up from here" has no single
honest target in arbitrary React.

This is not a fidelity violation, and the precedent is already in the repo:
`boards.json` stores frame positions, notes, docs and ruler guides;
`.studio/comments.json` stores review threads anchored to elements. Annotation
*on* the document is not the document.

Two things keep it from becoming a lie:

- Connectors render **only in prototype mode**. Design mode never shows one and
  the publisher never sees one.
- Studio also derives connectors from real navigation code (§6). Those are
  drawn differently and are read-only.

## 2. Storage — `.studio/prototype.json`

Its own file, not `boards.json`, for the three reasons `@core/studio-comments`
gives for its own file:

- `boards.json` rides an 800 ms dirty-flag autosave. Link authoring has no
  business on that path.
- A flow is worth reading as a git diff on its own.
- **A link outlives the board it was drawn on.** It is about a page and an
  element, not board furniture. Removing a frame from a board must not destroy
  the flow through that screen — which is why `source` names a `pageId` and
  never a `frameId`. (Two variant frames of one page share every node id by
  design, so a link authored on either is the same link.)

| Where | What |
|---|---|
| `@core/studio-prototype` | Schemas, tolerant serializer, link operations, the play machine, code-link derivation |
| `server/handlers/studio/prototypeStore.ts` | The file, and the op vocabulary |
| `server/handlers/studio/prototypeRoutes.ts` | `GET`/`POST /admin/api/studio/prototype` |
| `src/admin/pages/site/store/slices/prototypeSlice.ts` | Editor state (pure container, no HTTP) |
| `src/admin/pages/site/studio/prototypeActions.ts` | The round trip |
| `src/admin/pages/site/canvas/BoardPrototypeLayer/` | Connectors and the `+` handle |
| `src/admin/pages/site/panels/PrototypePanel/` | The inspector |

Writes are **op-shaped** (`upsert`, `remove`, `prune`), not whole-file, even
though authoring looks single-writer today. It will not stay that way: links are
also derived from code, and an agent authoring a flow is an obvious next tool.
Under whole-file semantics a browser holding a stale file silently erases
anything written between its last read and its next save.

`prune` carries its own list of pages that still exist. The server cannot
enumerate pages without parsing the project, which is the work the route exists
to avoid, so the caller — which just deleted a page and holds the page tree —
states what remains. **A `prune` naming no pages is refused**, because it is
indistinguishable from a caller whose pages failed to load and obeying it would
wipe every flow in the project.

## 3. Anchoring — why `nodeId` alone is not enough

Studio node ids are `relFile:line:col`, so they rot on nearly every edit above
the node. A link stored as a bare id would break silently and constantly.

`source.node` is a `NodeHint` from **[`@core/studio-anchor`](../../src/core/studio-anchor/)**
— `{ nodeId, indexPath, moduleId, textSnippet }` — re-resolved against the live
tree on every load into one of `exact | moved | drifted | detached`.

That module was extracted from `studio-comments`, which had already solved this;
the primitive was never comment-specific. **Policy is not shared**, and the two
consumers genuinely disagree:

| Confidence | Comment agent gate | Prototype link |
|---|---|---|
| `exact` / `moved` | act | follow |
| `drifted` | **refuse** — the comment is about the text that changed | **follow** — relabelling a button does not change where it goes |
| `detached` | refuse | broken; drawn broken, not dropped |

A `detached` link is drawn as a visibly broken connector rather than
disappearing. Silently dropping it would let a flow rot without anyone noticing.

## 4. Interaction model

| Action | What it does | Transitions |
|---|---|---|
| `navigate` | replaces the screen | `instant`, `dissolve`, `slide-left/right`, `push-left/right` |
| `overlay` | presents on top; the base screen stays mounted | `popup`, `sheet` |
| `back` | pops the history stack | reverses whatever brought you here |
| `close` | dismisses the top overlay | reverses its presentation |

`back` and `close` take no target and no transition: both are defined entirely
by what is already on the stack.

A transition is not free-floating decoration — `popup` describes a centred
presentation over a scrim, meaningless for a screen replacement; `push-left`
describes two screens moving together, meaningless over a screen that stays put.
The serializer **repairs** an illegal pairing rather than dropping the link (the
destination is what the user drew; the animation is one click to re-pick), and
**drops** anything where guessing would invent a flow: no source page, no source
element, or a `navigate`/`overlay` with no target.

Defaults come from the target's existing `PageKind` (`screen | popup |
sheet-small | sheet-large`), so linking to a sheet page does not ask the user
what a sheet is.

## 5. Modes — three axes, not one

```
[ ▸ Design | 👁 Live ]      the PLAYER: where frames render and at what size
[ ⌁ Prototype ]            the BOARD MODE: what a click on the board means
[ ▶ Play ]                 the player ARMED (live mode only)
```

`boardMode` lives in `canvasSlice` beside `canvasView`; both answer "how is the
canvas being used". Two modes rather than a checkbox because the gestures
collide: in prototype mode a drag from an element means "link this to that",
which in design mode means "move this".

**Play must be armed explicitly.** Without it, a click in live mode means both
"select this node" and "follow this link", which is not resolvable. Armed, the
player owns *every* click in the live frame, including ones that hit nothing —
falling through to selection would make one gesture mean two things depending on
where it landed.

Arming the player changes what is being **looked at**, never what is being
edited. Selection, the properties panel and the page tree keep pointing at the
editing page, so disarming puts the editor back where it was.

The right sidebar **replaces** the inspector in prototype mode rather than
growing a third tab, the way Figma's Design/Prototype tabs do. Leaving a full
style inspector up invites edits the user did not mean to make with a gesture
that now means something else.

## 6. Connectors — everything in board space

`BoardPrototypeLayer` mounts inside `CanvasTransformLayer` (via
`StudioBoardLayers`), second-to-last: connectors draw over frames and furniture
alike, but under a review pin.

**Board-space endpoints are invariant under pan and zoom**, so neither
re-renders nor re-measures anything. A frame's rect is store data. The only DOM
read is where an element sits *inside* its frame, driven by a `ResizeObserver` on
the source frame's document — the one signal that says "this page's layout
changed". Measuring per animation frame instead would re-read two iframes per
connector on every wheel tick.

An element's rect inside its iframe is already frame-local and **unscaled**: the
canvas transform scales the `<iframe>` element, not the CSS pixels of the
document inside it. So `board = frame origin + element rect`, with no zoom term.

All prototype chrome lives in that one parent layer. A connector spans two
iframes, so it cannot use the trick selection rings use (portal into the frame's
own document — there is no document containing both ends); once the connector is
in the parent, putting the `+` handle inside a frame would mean two coordinate
systems for one gesture.

### A node that has no box of its own

Studio renders every component that comes out of a design-system package as a
`display: contents` wrapper carrying the node id — the id has to live on an
element, and that element must not add a box or it breaks the CSS combinators
the published DOM depends on. `getBoundingClientRect()` on such an element is
`0×0`.

So `measureNodeFrameRect` measures a `Range` over the element's contents
whenever its own rect is empty (`visualBox`). Without that fallback the
prototype layer read every design-system component as "renders nothing": no `+`
handle appeared on it, and a link whose source was one drew no connector. Since
essentially every *button* in a real project is such a component, the feature
worked on plain markup and on nothing a user would actually want to make
clickable.

### Chrome is sized in screen pixels, positions in board units

Board units are right for POSITIONS — the canvas transform then handles pan and
zoom for free. They are wrong for THICKNESS. A 2px connector stroke in board
units is 1px at 50% zoom and 0.5px at 25%, so connectors faded out at exactly
the zoom levels where a whole flow fits on screen. `--canvas-zoom` (published on
`CanvasTransformLayer` every rAF, the same variable comment pins counter-scale
by) undoes the transform for anything whose SIZE is chrome: `vector-effect:
non-scaling-stroke` for strokes, `calc(<px> / var(--canvas-zoom))` for the rest.

`handlePoint` returns the middle of the element's right edge and no gap: how far
the handle sits from its element is a screen-space decision, so the stylesheet
owns it.

### Drawing a link crosses an iframe boundary

Every drop target is an `<iframe>`. A left-click pointer event inside one never
reaches the parent document's `window`, so a drag whose listeners live there
goes silent the instant the cursor enters a frame — and here the frames *are*
the targets, so the gesture dies on contact with the only thing it is aiming at.
It still works perfectly over empty board, which is why the symptom reads as
"the drop does nothing" rather than "the drag stopped".

`markCanvasPointerRelay(pointerId)` sets the flag every `IframeFrameSurface`
reads to forward `pointermove` / `pointerup` / `pointercancel` back out to the
parent; `clearCanvasPointerRelay()` takes it down when the gesture ends. Pointer
capture is set too, but it only covers the stretch before the cursor reaches a
frame — capture alone does not survive the crossing for a left-click mouse drag.

While a drag is over a valid frame the rubber band **snaps** to that frame's
edge, routed exactly as the committed connector will be, and the frame takes a
`--canvas-prototype-drop-wash` fill. Overlapping frames resolve topmost-first,
and because the wash and the commit read the same `frameAtBoardPoint` answer,
what lights up is always what you get.

**Three architecture gates sit on this file.** `single-drag-mechanism.test.ts`
bans `@dnd-kit` and the native HTML5 drag transfer API in new files, so the
connector drag is raw pointer events. `canvas-overlay-pointerdown.test.ts` bans
`stopPropagation` in `onPointerDown` under `canvas/` — it poisons use-gesture's
tap state and then eats the next click anywhere on the canvas.
`canvas-drag-pointer-relay.test.ts` requires the relay above of *every* file
under `canvas/` that listens for `pointermove` on the parent `window`. It exists
because this file was the third to need it and the first two only knew by
accident.

## 7. Code-derived connectors

The parser reads a screen destination out of a click handler **without executing
anything** (`src/core/page-parser/navigationIntent.ts`), and it is bounded on
purpose:

```jsx
onClick={() => navigate('/sign-in')}      ✓
onClick={() => router.push('/sign-in')}   ✓
onClick={() => setScreen('otp')}          ✓
onClick={() => navigate(`/user/${id}`)}   ✗  computed
onClick={() => navigate(target)}          ✗  a variable
onClick={() => ok ? a() : navigate('/x')} ✗  two destinations is a branch
onClick={onContinue}                      ✗  the body is not at this call site
```

The bar is not "find as many flows as possible". A derived link is presented as
a fact about the user's source — dashed, desaturated, not editable on the board
— so a wrong one tells them their app does something it does not, while a
missing one costs them drawing a link by hand.

Destinations reach the tree as `PageNode.codeNavigationTargets`, and
`deriveCodeLinks` turns them into `origin: 'code'` links. **They are never
persisted** — recomputed from the tree on every load, which is what keeps them
honest: delete the handler and the connector is gone, with no stale row.

- An **authored link on the same element wins** the merge. The designer overrode
  what the code does; showing both would draw two connectors from one button.
- A route no imported page matches draws **nothing**, not a dangling connector.
- Derived links get the **neutral** transition. The code says where it goes and
  nothing about how it should look getting there.

## 8. Playback

**The live frame must declare which page it is showing.** `NodeRenderer`
resolves every node id against the page named by `CanvasPageContext`, falling
back to the *active document* when there is none. `CanvasLiveSurface` did not
provide it, which was invisible for as long as the live frame only ever showed
the page being edited — and meant that the moment the player navigated to a
different screen, every id it asked for was looked up in the wrong tree, found
nothing, and rendered an empty device. Each board frame provides its own page id
for exactly this reason; the live frame and the overlay now do too.

**The entrance animation must not remount the frame.** A CSS `@keyframes`
entrance only replays when the element is remounted, so the screen wrapper was
keyed on the page id — which took the `<iframe>` down with it, and the portal
that renders the page into the frame's body did not survive that. The entrance
is played imperatively instead (`screenEntrance.ts`, Web Animations API), which
replays on demand with no remount, and is cheaper besides: an iframe remount
re-parses and re-injects every stylesheet. That file honours
`prefers-reduced-motion` itself — the global CSS rule that clamps
`animation-duration` cannot see a script-driven animation.


The player is a stack machine (`@core/studio-prototype/playback.ts`), pure and
testable without a store:

- `back` closes an overlay **before** it pops a screen — what the gesture means
  to someone looking at a sheet over a screen.
- Navigating out from under an overlay **drops** it. The overlay belonged to the
  screen being left.
- **Innermost link wins** a click: a linked button inside a linked card follows
  the button.
- A `back` with nowhere to go **toasts**. A back button on the entry screen is a
  real prototype bug, and the player is where it should surface.

**Known limit, v1:** only the incoming screen animates. A true `push` moves the
outgoing screen too, which needs both mounted at once and would double frame
mounts on every navigation.
