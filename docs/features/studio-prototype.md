# Studio prototype mode

Flows on the Studio board: the ones the user draws, and — the part that matters —
the ones their code already performs.

> Not the same thing as **board annotations**
> ([`board-annotations.md`](board-annotations.md)) or **studio comments**
> ([`studio-comments.md`](studio-comments.md)). Those are things a person put on
> the board. Half of this feature is a **read of the repository**.

---

## The differentiator, stated plainly

Figma's prototype connectors are drawings. They are true because somebody drew
them, and they go stale the moment the implementation diverges — which is
immediately, because the implementation lives somewhere else.

Studio's source of truth **is** the React repository. So it can read the
navigation the project already performs — `<a href>`, `<Link to>`,
`navigate('/details')`, `router.push(…)` — and draw it. Open a repository nobody
has ever prototyped, switch to prototype mode, and the flow map is already there
and already correct. A shape-database design tool structurally cannot do this;
it has no code to read.

Those connectors are **read-only**. The only way to change one is to change the
code it came from.

---

## Two collections, and why they are different shapes

| | Authored links | Derived flows |
|---|---|---|
| Type | `PrototypeLink` | `CodeFlowEdge` |
| Lives in | `.studio/prototype.json` | nothing — recomputed every load |
| Who made it | the user, in the inspector | Studio, from the source |
| Anchoring | `NodeHint`, re-resolved on load | none needed |
| Transition | the user picked one | none — code says where, not how |
| Extra field | — | `evidence`: the snippet it was read from |
| Drawn as | saturated, solid | quiet, achromatic, dashed |

The plan's Phase 1 anticipated one merged shape with an
`origin: 'design' | 'code'` discriminator. Phase 6 disproved it: a derived edge
would have needed a synthetic hint, an invented transition and a fabricated
stable id, and would still have had nowhere to put `evidence`. The field is
gone; the two live side by side.

**A derived edge is never persisted.** A stored copy would go stale the first
time the user edited a handler, and a stale claim about the code is worse than
no claim — it is exactly the lie this feature exists to avoid.

---

## How a flow is read out of the source

`server/handlers/studio/prototypeNavScan.ts`, purely syntactic — no type
checker, no cross-file resolution. Four rules:

1. **`href="…"` / `to="…"`** as a plain string attribute. `<a>`, `<Link>`,
   `<NavLink>`, and any design-system button that forwards one.
2. **A navigation call anywhere inside a non-string attribute expression.**
   `onClick={() => navigate('/details')}`,
   `toolbar={{ onBack: () => router.push('/home') }}`. The nesting is not
   enumerated — the whole attribute expression is walked — because a handler's
   depth inside an object prop is not a fact about navigation.
   Recognised: `navigate`/`redirect`/`push`/`replace` as bare calls;
   `.push`/`.replace`/`.navigate`/`.assign` on a `router`/`history`/
   `navigation`/`location` receiver.
3. **A bare identifier handler**, resolved **one hop** to a same-file
   `const goToDetails = () => …` or `function goToDetails() {…}`. One hop, never
   a chain: two hops is where a cycle becomes possible and where the claim stops
   being obvious from reading the JSX.
4. **`window.location.href = '/details'`** — an assignment, not a call.

### What it refuses

Refusal is half the design. An arrow nobody wrote is the one failure this
feature cannot afford, because the user cannot tell it is wrong by looking.

- A target that is not a **literal** string. `` `/user/${id}` `` names a
  different route every render; there is no frame to point at.
- A target that **leaves the project**: `https://…`, `mailto:`, `#anchor`.
- A target **no page answers to**.
- A target **two pages both answer to**. The key is withdrawn rather than
  resolved — same "exactly one honest target" bar Studio applies to writes.
  Both pages keep their unambiguous spellings.
- A handler in **another file**. Following it would make one page's flow map
  depend on a module graph this scan does not build.

### Resolving a target to a page

`server/handlers/studio/prototypeRouteIndex.ts` states every spelling a page
legitimately answers to — its page id, its file path without the extension, its
basename (what React Navigation registers a screen as), and `/` for a top-level
index-shaped file. Exact lookup over a stated key set, never a fuzzy match: an
exact miss costs a missing arrow the user can still see in their code, a fuzzy
hit costs an arrow that is a lie.

Page ids come from the same `assignPageIds` / `assignAppRouterPageIds` the board
loader uses, so they are the same strings the frames carry.

### Cost

One syntactic ts-morph parse per page file, memoized on the page files' mtimes
(`readCodeFlow`). A board reload that changed nothing navigational is a
`statSync` per page. The page parser's own cache cannot be shared: it is
invalidated by things (compiled CSS, preview locale) that cannot change a
navigation target.

---

## Anchoring an authored link

Same problem `studio-comments` documents at length: a Studio node id is
`relFile:line:col`, a source *position*, so it rots on nearly every edit above
the element. An authored link therefore stores a `NodeHint`
(`@core/studio-anchor`) and is re-resolved on every load.

Two policies differ from comments', deliberately:

- A **`drifted`** source (same place, same module, different text) still works.
  Relabelling a button does not change where it goes. A comment refuses on
  `drifted`, because the comment is *about* the text that changed.
- A **`detached`** source is drawn **broken**, never hidden. The user has to be
  able to see what their edit cost.

The inspector finds the link for a selection by re-resolving every link on the
page and matching the *resolved* node id — never by comparing the stored one.
Matching on the stored id would hide the link the moment a line was added above
it, and the next edit would silently author a second link on the same element.

---

## The two board layers, and why they are two

Both mount in `StudioBoardLayers`, derived under authored, in the **parent
document**, inside `CanvasTransformLayer`, positioned in **board coordinates**.
Both render `null` outside prototype mode, so a normal editing session pays one
store read each.

| | `BoardFlowLayer/` | `BoardPrototypeLayer/` |
|---|---|---|
| Draws | derived `CodeFlowEdge`s | authored `PrototypeLink`s |
| Anchored to | frame → frame | **element** → frame |
| Interactive | no — hover only, for the evidence tooltip | yes: click to select, `+` handle to author |
| Voice | quiet, achromatic, dashed | saturated, solid |

This is one feature with two line families, not two prototype systems: one
store slice, one mode toggle, one inspector, one file on disk. They are drawn by
two components because they are different claims that want different geometry.

A derived edge covers **every page at once** — it is a read of the whole
repository — so measuring an element per edge is exactly the cross-document
measurement pass that would make the board a stutter machine, and it is the
wrong granularity anyway: the fact is "Home navigates to Details", and the
element that does it is named in the chip's tooltip where it does not have to be
measured to be true. An authored link is the opposite: the user placed it
deliberately, on a specific element, one at a time, and the `+` handle that
creates it has to sit beside that element or the gesture means nothing. So
`BoardPrototypeLayer` measures only the handful of elements links actually start
from, on a `ResizeObserver` over their frames' documents — never on pan or zoom,
which cannot move a board-space endpoint.

- **Nothing is ever inserted into a user iframe.** Selection rings are portaled
  into each iframe to dodge coordinate conversion; a connector cannot be,
  because it spans two of them and neither contains it.
- **Board-space endpoints are pan/zoom invariant.** The transform layer moves
  them for free, so the geometry runs on frame move and resize only — never per
  animation frame. Getting this wrong is how the feature becomes a stutter
  machine.
- **Everything visible counter-scales in pure CSS** by `1 / var(--canvas-zoom)`
  — stroke, dash rhythm, arrowhead, chip. The `CommentPin` pattern: the store's
  `zoom` is committed 100 ms after the last gesture, so subscribing to it would
  make every connector lag the board.

### Frame-to-frame, for the DERIVED half

One line per **frame pair**, with the count on the chip — three buttons on Home
that all reach Details is one flow, and three curves between the same two frames
stack invisibly on top of each other. A page with several frames on the board
(the "duplicate as variant" case) connects each source frame to the **nearest**
copy of the target page: every variant shows its outgoing flow without drawing
S × T lines for one fact.

---

## Authoring a link

Two entry points, one draft, so they cannot drift apart:

- **Drag the `+` handle** beside the selected element onto another frame. The
  rubber band SNAPS to a frame once the cursor is over it — routed exactly as
  the committed connector will be — because a band that keeps chasing the cursor
  over a valid target is a drag that never says whether releasing will do
  anything. The frame under the cursor takes a wash, not just a ring: at board
  zoom a 2px outline on a 1440px frame is easy to miss.
- **The selection toolbar's link button**, which sets a request that
  `usePrototypeLinkPick` converts into a `pick` draft once it has board
  geometry the toolbar has no way to know. It exists because the handle can only
  be drawn where the canvas can MEASURE the node, and "we could not measure it"
  is not an answer to give someone who has already selected the thing. A drag
  commits on pointer-up; a pick commits on the next click and cancels on Escape.

The draft is deliberately NOT a `PrototypeLink` with a null target: a half-drawn
gesture the user abandons must leave nothing behind, and giving it the real shape
is how it ends up accidentally persisted. It becomes a link only at the drop, in
`prototypeActions.commitLinkDraft`, where the `NodeHint` is captured against the
tree as it stands.

**The drop decides the action.** Dragging onto a `popup` or `sheet` page means
"present this over the current screen"; onto a `screen`, "navigate to it"
(`defaultLinkPresentation`, keyed on `PageKind`). Asking the user to say so
twice — once by aiming, once in a dropdown — is a question the drop already
answered.

**Every drop target is an iframe**, and a left-click pointer event inside an
iframe never reaches the parent document's `window`. Without
`markCanvasPointerRelay` the drag went silent the instant the cursor entered the
only thing it was aiming at, which read as "the drop does nothing" rather than
"the drag stopped". Three architecture gates sit directly on this file:
`single-drag-mechanism` (raw pointer events, no `@dnd-kit`, no `dataTransfer`),
`canvas-overlay-pointerdown` (no `stopPropagation` in `onPointerDown` under
`canvas/`), and the relay requirement itself.

`back` and `close` are authored in the inspector instead, because there is
nothing to drag TO: "go back" names no screen, it names the one you came from,
which is only known while the player is running. They draw a chip on their own
element rather than a connector — an interaction you cannot see on the board is
one you will forget you authored.

---

## Playing it

Live view with the **Play** toggle armed: a click follows a link instead of
selecting a node. Both meanings at once is not resolvable, which is the whole
reason the toggle exists. `setCanvasView` arms it on the way into live and
disarms it on the way out, so the flag can never be set where no control exists
to clear it.

The machine is `src/core/studio-prototype/playback.ts` — pure, no DOM, no store,
no React — over two stacks:

- `screens` — everything `navigate` pushed. `back` pops it.
- `overlays` — everything `overlay` presented on top of the current screen.
  `close` pops it, and so does `back` when one is showing, because that is what
  the gesture means to someone looking at a sheet over a screen.

Navigating out from under an overlay drops every overlay: it belonged to the
screen being left. Each stack entry remembers HOW IT ARRIVED, because `back` has
no transition of its own — going back means reversing whatever brought you here,
and a bare stack of page ids no longer says what that was. `applyPlayAction`
returns the SAME state object when nothing changed, and aliases nothing from its
argument when something did: the store hands it a Mutative draft, and an object
assigned back into a draft while still holding references into it does not
survive finalization.

Arming the player changes what is **being looked at**, never what is being
edited. Selection, the properties panel and the page tree all keep pointing at
the editing page, so disarming puts the editor back exactly where it was. The
hover ring is the one piece of editing chrome that stands DOWN while armed — a
visitor clicking through a prototype should see the component's own hover state
and nothing of ours — so `setPlayMode` clears whatever was lit and
`useCanvasNodeInteraction` stops writing it.

### The gesture, and why it is not a `click`

A linked element usually has interactions of its OWN — a hover state, a pressed
state, an `onClick`. **Both have to work**, and neither may cost the other.

Two rules make that true:

- **The player reads the press/release PAIR on the node, not the `click`.** A
  `click` is dispatched at the nearest common ancestor of the mousedown and
  mouseup targets, and when the mousedown target has left the document by the
  time the button comes up there is no common ancestor and the browser
  dispatches **no click at all**. A component whose hover/press effect
  re-renders under the finger does exactly that on the FIRST press and has
  settled by the second — which from the outside is "the link doesn't work on
  the first click". A node's own host element is rendered by `NodeRenderer` and
  survives all of it, so `onPointerDownCapture` latches the node and
  `onPointerUpCapture` over that same node follows the link. The `click` that
  may or may not follow is swallowed by the latch (`useCanvasNodeInteraction`'s
  `PlayGesture`), so one press is one navigation.
- **A live frame does not stop propagation.** The canvas activates a node in the
  CAPTURE phase, above the authored element — `stopPropagation()` there meant
  the component's own handlers never ran at all. Live frames now let the event
  through and use `canvasNodeGestureLatch` to keep the bubble-phase twin from
  activating the node a second time. `preventDefault()` still applies in both:
  an authored `<a href>` must not navigate the frame away. Design frames are
  unchanged — there, a click means "select this node" outright.

### Two screen slots, and no `key`

`PrototypeScreenStack` mounts two frames for the life of the player and moves
pages BETWEEN them. A push has to animate the departing screen too — it
parallaxes back a third of the way and darkens under the arriving one, which is
what stops the motion reading as a cross-dissolve — so both have to be on screen
at once.

Keying a slot on the page id is the obvious way to replay a CSS entrance, and it
remounts the `<iframe>`; the React portal that renders the page into the frame's
body does not survive that, so every navigation landed on an empty device.
`playbackMotion.ts` replays the entrance with the Web Animations API against a
frame that stays put — which also means one source for every duration instead of
the same numbers written twice, once per language. `prefers-reduced-motion` is
honoured there explicitly, because the global CSS rule that clamps
`animation-duration` cannot see a script-driven animation.

The numbers are the design system's own motion tokens. Two principles are baked
into them: `EASE_IOS` is the curve the DS `BottomSheet` uses (a sheet the DS
animates and a sheet Studio animates have to move identically), and dismissal is
quicker than presentation (arriving is the moment worth drawing out; leaving
should get out of the way).

### The overlay owns its own unmounting

React removes a component the moment its parent stops rendering it, so an
overlay wired straight to "is one presented?" VANISHES rather than dismissing.
`PrototypeOverlay` keeps the last presented page mounted, plays the exit, and
only then drops it.

It supplies motion and a dim and **nothing about the overlay's shape**: an
overlay page is scaffolded at screen size and draws its own panel, corner radius
and scrim (`pageKinds.ts`), so a height chosen here would be a second opinion
about a decision the design already made. A fixed top inset cropped the top off
every full-screen sheet, which is what that rule replaced.

Because the overlay page covers the screen completely, there is no outside left
to tap — so `close` on the affordance the design itself drew is the only honest
dismissal, and the scrim is presentation only.

---

## UI

- **The mode** is a pressed-state toggle in the canvas chrome
  (`CanvasModeToggle`), shown only on a Studio board in design view. It is not a
  third tab beside Design/Live: those two are exclusive canvas *surfaces*, this
  is an overlay on the design board. It is **not persisted** — restoring it on
  load would open the editor in a state where the first click selects nothing,
  with no memory of having asked for that.
- **Play** is the same shape one axis over: a pressed-state toggle shown only
  in LIVE view, because that is the only place following a link means anything.
- **The inspector body swaps** in prototype mode (`PrototypePanel` replaces
  `PropertiesPanel` inside `RightSidebar`), the way Figma's Design/Prototype
  tabs work. Not a third tab in the Properties/Comments strip: those are two
  panels you choose between, this is the same inspector showing a different
  layer of the same selection.
- **The inspector answers two questions**, because a link can be reached two
  ways. Selecting the ELEMENT shows (and authors) the link on it; clicking the
  CONNECTOR (`selectedLinkId`) shows that link, which is how you reach one whose
  source element is off-screen or gone. The second wins when both are live — the
  user just clicked a specific line. Editing there goes through `updateLink`
  (the whole link, anchor included) and never `saveLink`, which is keyed on an
  element and would silently re-anchor the link to whatever is selected on the
  canvas.
- **Every screen's outgoing links are listed**, so the panel answers "what does
  this screen do" without the user hunting a connector first. A link whose
  source element is gone is listed and marked, never hidden.
- **Delete / Backspace removes the selected link**, Escape deselects it, from a
  document-level listener in the CAPTURE phase — a link and a node can be
  selected at once, and only one of them was meant.
- Every control **saves on change**. A link is three enum choices, each a
  complete statement, and the server merges op-by-op — a form-and-submit would
  add an "edited but not saved" state that has no meaning here.

---

## HTTP

| Route | What |
|---|---|
| `GET /admin/api/studio/prototype?dir=` | the authored `PrototypeFile` |
| `POST /admin/api/studio/prototype` | apply **one** `PrototypeOp` (`upsert` / `remove` / `prune`), returns the merged file |
| `GET /admin/api/studio/prototype/flow?dir=` | the derived `CodeFlow` |

Writes are op-shaped rather than whole-file (unlike `/boards`) because a browser
holding a stale file would otherwise erase anything written between its last
read and its next save — and this file will not stay single-writer. There is
deliberately **no POST counterpart for `/flow`**.

`prune` carries its own page list and refuses an empty one: the server cannot
enumerate pages without parsing the project, and a prune naming no pages is
indistinguishable from a caller that failed to load its pages.

---

## Where the code is

| Path | What |
|---|---|
| `src/core/studio-anchor/` | the `NodeHint` + re-resolution primitive, shared with comments |
| `src/core/studio-prototype/types.ts` | authored link schemas, action/transition legality |
| `src/core/studio-prototype/codeFlow.ts` | derived-edge schema, id, page-pair grouping |
| `src/core/studio-prototype/serialize.ts` | tolerant read of `.studio/prototype.json` |
| `src/core/studio-prototype/prototypeModel.ts` | pure add/update/remove/prune, source resolution |
| `server/handlers/studio/prototypeStore.ts` | the file, and one op applied to it |
| `server/handlers/studio/prototypeNavScan.ts` | the AST rules |
| `server/handlers/studio/prototypeRouteIndex.ts` | target string → page id |
| `server/handlers/studio/prototypeCodeFlow.ts` | discovery, orchestration, mtime memo |
| `server/handlers/studio/prototypeRoutes.ts` | the three routes |
| `src/admin/pages/site/store/slices/prototypeSlice.ts` | both collections + `boardMode` |
| `src/admin/pages/site/studio/prototypeActions.ts` | every round trip |
| `src/core/studio-prototype/playback.ts` | the player's stack machine |
| `src/admin/pages/site/canvas/BoardFlowLayer/` | the derived connectors |
| `src/admin/pages/site/canvas/BoardPrototypeLayer/` | the authored connectors, the `+` handle, the drag |
| `src/admin/pages/site/canvas/playbackMotion.ts` | every animation the player runs |
| `src/admin/pages/site/canvas/PrototypeScreenStack.tsx` | the two screen slots |
| `src/admin/pages/site/canvas/PrototypeOverlay.tsx` | a sheet or popup over the screen that opened it |
| `src/admin/pages/site/canvas/usePrototypePlayback.ts` | which page the live frame shows while armed |
| `src/admin/pages/site/canvas/usePrototypeLinkKeyboard.ts` | Delete removes a link, Escape deselects |
| `src/admin/pages/site/studio/playNavigation.ts` | a click in the armed frame → the machine |
| `src/admin/pages/site/canvas/useCanvasNodeInteraction.ts` | what a pointer gesture on a node does, armed or not |
| `src/admin/pages/site/canvas/canvasNodeGestureLatch.ts` | one press = one activation, across every event it raises |
| `src/admin/pages/site/store/slices/prototypeSelectors.ts` | derived reads (never zustand selectors — see its doc) |
| `src/admin/pages/site/panels/PrototypePanel/` | the inspector |

---

## Not built yet

Tracked in [`STUDIO-PROTOTYPE-PLAN.md`](../../STUDIO-PROTOTYPE-PLAN.md).

- **`back`-shaped code flows.** `router.back()` is a real fact with no drawable
  destination and, today, no consumer.
- **Pruning on page delete.** `prunePrototypeLinks` and the `prune` op exist;
  nothing calls them yet. A link to a deleted page simply draws nothing, and
  the inspector's list shows it pointing at "Deleted page".
- **A trigger other than `click`.** The schema has one, and the reader repairs
  anything else to it.
