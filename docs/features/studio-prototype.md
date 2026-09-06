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

## The board layer

`src/admin/pages/site/canvas/BoardFlowLayer/`, mounted in `StudioBoardLayers`
beside `BoardCommentsLayer` — in the **parent document**, inside
`CanvasTransformLayer`, positioned in **board coordinates**.

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

### Frame-to-frame, not element-to-frame

Figma anchors a connector to the element you attached it to, because there that
element is a shape in the same document. Here it is a DOM node inside another
browsing context, and tracking its rect means a cross-document measurement pass
on every frame move, resize and reflow.

It is also the wrong granularity for the claim: the fact is "Home navigates to
Details", and the element that does it is named in the chip's tooltip, where it
does not have to be measured to be true.

One line per **frame pair**, with the count on the chip — three buttons on Home
that all reach Details is one flow, and three curves between the same two frames
stack invisibly on top of each other. A page with several frames on the board
(the "duplicate as variant" case) connects each source frame to the **nearest**
copy of the target page: every variant shows its outgoing flow without drawing
S × T lines for one fact.

---

## UI

- **The mode** is a pressed-state toggle in the canvas chrome
  (`CanvasModeToggle`), shown only on a Studio board in design view. It is not a
  third tab beside Design/Live: those two are exclusive canvas *surfaces*, this
  is an overlay on the design board. It is **not persisted** — restoring it on
  load would open the editor in a state where the first click selects nothing,
  with no memory of having asked for that.
- **The inspector body swaps** in prototype mode (`PrototypePanel` replaces
  `PropertiesPanel` inside `RightSidebar`), the way Figma's Design/Prototype
  tabs work. Not a third tab in the Properties/Comments strip: those are two
  panels you choose between, this is the same inspector showing a different
  layer of the same selection.
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
| `src/admin/pages/site/canvas/BoardFlowLayer/` | the connectors |
| `src/admin/pages/site/panels/PrototypePanel/` | the inspector |

---

## Not built yet

Tracked in [`STUDIO-PROTOTYPE-PLAN.md`](../../STUDIO-PROTOTYPE-PLAN.md).

- **Play mode.** Following a link in live mode: history stack, transition
  runtime, back/close, scrim dismiss.
- **The drag-from-`+` gesture.** An alternative input for the same model the
  inspector already writes. Must be raw pointer events —
  `single-drag-mechanism.test.ts` bans `@dnd-kit` and `dataTransfer` in new
  files, and `canvas-overlay-pointerdown.test.ts` bans `stopPropagation` in
  `onPointerDown` under `canvas/`.
- **Element-level anchoring** for authored connectors.
- **`back`-shaped code flows.** `router.back()` is a real fact with no drawable
  destination and, today, no consumer.
- **Pruning on page delete.** `prunePrototypeLinks` and the `prune` op exist;
  nothing calls them yet. A link to a deleted page simply draws nothing.
