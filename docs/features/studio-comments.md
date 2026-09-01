# Studio comments

Review threads pinned to the Studio board, stored in the project's own repository
and readable by the AI agent.

> Not the same thing as **board annotations**
> ([`board-annotations.md`](board-annotations.md)). Sticky notes and doc cards are
> *authoring furniture* — the designer's own scratch space, owned by a board,
> deleted when they stop being useful. A comment is *review*: it is about a
> specific element, it has an author who is not necessarily the reader, and it
> ends in `resolved` rather than deletion.

---

## Why on disk

`.studio/comments.json` sits next to the source it discusses. That buys three
things a database would not:

- **It travels.** Clone the repo, get the review. The author is stored as a
  denormalized `{ userId, displayName }` snapshot precisely so a thread still
  names its participants on a machine whose `users` table has never heard of
  those ids.
- **It diffs.** A review pass is legible in `git log`.
- **The agent can read it.** This is the one Figma cannot do, and the reason the
  format matters: a review thread is readable by the thing that edits the
  repository. See [The agent loop](#the-agent-loop).

It is a separate file from `boards.json` because `boards.json` rides an 800 ms
dirty-flag autosave (`useStudioBoardsPersistence`), and comment bodies have no
business on that path.

---

## The anchor problem

**This is the part to understand before changing anything.**

A Studio node id is `relFile:line:col` — a source *position*. It stops resolving
the moment anything above it in the file changes, which is most edits. The editor
already treats this as routine: after a re-parse, `lifecycleActions.ts` filters
`selectedNodeIds` down to the survivors and drops the rest.

Selection can be dropped. A comment cannot. Penpot and Figma never face this —
their documents are shape databases with stable UUIDs. Ours is a text file.

So an anchor is layered:

```ts
interface CommentAnchor {
  frameId: string | null   // board frame the pin was dropped on
  pageId: string | null    // denormalized, so the thread outlives the frame
  dx: number               // frame-LOCAL px — the coordinate of record
  dy: number
  node: CommentNodeHint | null   // what it is ABOUT. Allowed to rot.
}

interface CommentNodeHint {
  nodeId: string        // `path:line:col` as of authoring. Expect it to be stale.
  indexPath: number[]   // child-index path from the page root. Survives edits above.
  moduleId: string      // rejects a match on a different KIND of node
  textSnippet: string   // the tiebreaker: "moved" vs "replaced"
}
```

`(dx, dy)` is where the comment **is**; `node` is what it is **about**. The second
can rot without moving the first.

### The five confidences

`resolveCommentAnchor(hint, tree)` recomputes on every load — never persisted, since
a stored confidence would be a claim about a tree that has since changed.

| Confidence | Meaning | Agent may act |
|---|---|---|
| `exact` | the stored `nodeId` still resolves | ✅ |
| `moved` | `indexPath` resolves, same module **and** same text — rewrite the id | ✅ |
| `drifted` | same place, same module, **different** text — someone edited the thing under discussion | ❌ |
| `detached` | the comment named an element and it is gone | ❌ |
| `unanchored` | the comment never named an element — a pin on empty canvas | ✅ |

`unanchored` is not cosmetic. Folding it into `detached` made every free-floating
comment permanently un-resolvable by the agent and gave each one a stale badge it
had not earned. `commentTools.test.ts` pins the distinction.

**Known limitation (v1):** `indexPath` is structural, so wrapping a section in a
new element shifts every descendant's path by a level and reads as `detached`
even though nothing was removed. It fails toward "I don't know", which is the
safe direction — a false `detached` costs a re-pin, a false `exact` costs a wrong
edit.

---

## The agent loop

Four calls, no new orchestration:

```
studio_list_comments   → what is outstanding, and what each thread points at
studio_apply_edits     → (existing) make the change
studio_reply_comment   → say what was done, in the thread
studio_resolve_comment → mark it done
```

| Tool | Gate |
|---|---|
| `studio_list_comments` | none (matches every other Studio read tool) |
| `studio_reply_comment` | `mutates` + `studio.write` |
| `studio_resolve_comment` | `mutates` + `studio.write` **+ the anchor gate** |

### Every id is resolved before the agent sees it

A stored thread is five ids — `boardId`, `anchor.frameId`, `anchor.pageId`,
`anchor.node.nodeId`, plus `dx`/`dy` — and not one of them describes anywhere.
`26cc49cd…` is not a board, `pages/Home.tsx:5:6` is not an element, and `dx: 86`
is not a place without the frame it is relative to. An agent handed those either
asks three follow-up questions or guesses which element was meant, and guessing
edits the wrong source.

`buildCommentLocation` in `@core/studio-comments/location.ts` resolves them once
into a `CommentLocation`: named board, named page, **the page's source file**,
the pin's position in frame-local pixels *and* as a share of the frame, the
element's module and text, and its **trail** — the labels from the page root
down to it, so the element is findable by structure when its positional id has
gone stale.

Both doors into the review loop use it, and that is the point of the module
existing:

| Door | Shape |
|---|---|
| `studio_list_comments` | the record verbatim, under `location` |
| the panel's **Send to AI** button | `describeCommentLocation`, the same record as prose |

They were describing a thread differently and incompletely before — the button
named the page and module id, the tool named the page and node id, neither named
the board, the frame, the coordinates or the surrounding structure. A thread
must not be well-described through one door and badly through the other.

`checkAnchor: false` is how a caller says *"I did not parse the project on this
call"*. It yields `confidence: null`, never the `detached` a missing tree would
otherwise produce: **"I did not look" and "it is gone" must never render as the
same sentence** in a briefing an agent acts on.

### The anchor gate

`studio_resolve_comment` re-resolves the anchor against the live tree and
**refuses** on `drifted` or `detached`. It posts the reason *into the thread* —
not only into a tool result the user never sees — and returns
`{ ok: false, code: 'stale-anchor', anchorConfidence }`.

The reason this exists: an agent that trusts a rotten anchor edits the **wrong
element**, in the user's real source, in a file they did not open, and then
reports success. A wrong edit that announces itself as correct is worse than no
edit. Same posture as `refuseStructuralEdit` — when there is not exactly one
honest target, say so instead of guessing.

`isAgentActionable` in `@core/studio-comments` is the single predicate. Do not
inline a looser copy of it.

Reopening (`resolved: false`) is never gated: a stale anchor is a reason to leave
a thread *open*, so it can never be a reason to refuse opening one.

An agent write pushes `commentsChanged: true` through `pushStudioLiveReload`, so
a reply lands in an open browser without a reload.

---

## HTTP

```
GET  /admin/api/studio/comments?dir=<abs>        → { dir, comments }
POST /admin/api/studio/comments  { dir?, op }    → { ok, changed, comments }
```

**POST carries ONE operation, not the whole file** — the deliberate divergence
from the sibling `/boards` route. Board geometry has exactly one writer (the
person dragging), so last-write-wins is fine there. Comments are multi-writer by
definition; that is the feature. The server applies the op to the file it just
read, so concurrent writers merge instead of clobbering.

Ops: `create-thread`, `reply`, `edit`, `delete-comment`, `set-resolved`, `move`,
`delete-thread`.

**The author is never in the request body.** It is built server-side from the
session (`authorFromSession`), because a browser-supplied author is a forgery —
any authenticated account could otherwise sign a comment as the project owner, or
as the agent. `kind: 'agent'` is reachable only from the MCP tool path.

Both routes require a session — the only `/admin/api/studio/*` routes that do. A
comment has a byline, and an unauthenticated write has no honest one to carry.

### Who may do what

| | Read | Comment | Edit / delete own | Resolve | Delete thread |
|---|---|---|---|---|---|
| Any authenticated role (incl. **Client**) | ✅ | ✅ | ✅ | ✅ | own only |

The **Client** role (`site.content.edit` only) is the reviewer this feature
exists for, so the panel is in the read-only rail set alongside Explorer and
Inspect. Resolve is deliberately *not* ownership-gated — gating it to the author
leaves threads open forever once they move on, and it is reversible.

---

## UI

| Piece | Where |
|---|---|
| Pins + thread popovers | `canvas/BoardCommentsLayer/` — last layer in `StudioBoardLayers` |
| Author face on pin + row | `studio/commentAvatarUser.ts` → `@admin/shared/UserAvatar` |
| The armed tool (`C`) | `canvas/BoardCommentsLayer/CommentPlacementLayer.tsx` |
| Point → anchor (place **and** drag) | `canvas/BoardCommentsLayer/commentAnchorAtPoint.ts` |
| Tool button | `CommentToolButton`, in `BoardNotesToolbar` |
| Per-comment / per-thread actions | `CommentKebab` — one ⋯ menu, not inline buttons |
| Work queue | `panels/CommentsPanel/` — **right sidebar**, mode `comments`, shared `PanelHeader` |
| Bulk delete / send-to-agent | `studio/commentBulkActions.ts` |

### A pin wears its author's face, not its number

The marker shows the thread STARTER's avatar. Mid-review the useful question at
a glance is *who is asking*, not *which number is this* — the number only becomes
useful once you are already talking about one thread, by which point you are in
the panel or the popover.

`seq` has not stopped being the thread's name. It is stable for the life of the
project and never reused, so "look at 3" still resolves — it stays in the pin's
accessible name, the hover peek, the panel row's meta line (`#3`), and every MCP
payload. What changed is only what the 26px marker spends its space on.

The picture is the real uploaded avatar (or Gravatar identicon) when the author
is the signed-in user, and `UserAvatar`'s initials circle for everyone else and
for the agent. That asymmetry is deliberate: `.studio/comments.json` stores a
denormalized author snapshot (`userId`, `displayName`, `kind`) and **no image URL
or email hash**. The file is committed to the user's repository, and an
email-derived Gravatar hash sitting in it is a disclosure this feature does not
need to make. `commentAvatarUser` is shared by the pin and the panel row so one
author cannot wear two different faces in the two places showing the same thread.

### A pin can be dragged, and the drop re-anchors it

Press a pin, move more than 3px, and it follows the cursor; below that the press
is a click and opens the thread. The drop calls **`commentAnchorAtPoint`** — the
same function that places a new pin — so it resolves the landing point from
scratch: new frame, new frame-local offset, new node hint.

That is deliberate, and it is what makes the gesture worth having. A pin dragged
onto a different element now points at that element, which means dragging is the
**repair path**: a `detached` thread becomes `exact` again by being dropped where
it belongs, and a comment placed a few pixels off can be nudged onto its real
subject. A drag that only moved coordinates would leave the thread still pointing
at whatever it pointed at before — cosmetic, and quietly wrong.

Three implementation points, each of which was a bug waiting to happen:

- **Pointer capture is required, not defensive.** The board is a field of
  iframes. Without capture the parent document stops receiving `pointermove` the
  instant the cursor crosses into a frame, and the pin freezes mid-drag. The
  capture call is wrapped and non-fatal, and comes *after* the window listeners
  are attached, so a throw degrades the drag instead of stranding them.
- **The preview offset goes AFTER the counter-scale, and the order is the whole
  of it.** Transform functions compose left to right, so the leftmost one applies
  in the pin's *parent* space — inside `CanvasTransformLayer`, already multiplied
  by `--canvas-zoom`. Written there (it was, first), a 100px cursor delta moved
  the pin 50px at 50% zoom and the pin visibly lagged the cursor. Placed after
  `scale(1 / --canvas-zoom)` it lands in a space divided by the zoom and then
  multiplied by it again on the way to the screen, so the two cancel and the
  offset IS the cursor delta at every zoom. Only the drop converts to board
  coordinates, once.
- **The offset is cleared after the write settles, not on pointer-up.** The move
  is a server round trip; clearing early snaps the pin back to its old spot for a
  frame before it jumps to the new one. On failure that same clear restores the
  original position, which is right — the toast says why.

Escape cancels a drag in flight. The trailing `click` is swallowed by a ref that
is set when the threshold is crossed and cleared by the *next* press — not on
pointer-up, because the click arrives after that.

### The pane lives on the right, and has no rail button

The comments list is a `RightSidebar` mode, not a left-rail panel. That is the
same place the Properties panel appears and for the same reason: the right
sidebar shows whatever you just clicked. Comments **win** over properties when
both would show, because clicking a pin does not clear the node selection —
without a winner the pane would show the properties of whatever was selected
before, beside a comment the user just opened.

**Properties and Comments are TABS in that one slot, not a winner and a loser.**
Comments used to win outright whenever both would show, on the reasoning that
clicking a pin does not clear the node selection — so without a winner the pane
would show stale properties beside a freshly-opened comment. That was right about
the conflict and wrong about the remedy: it made the inspector *unreachable*
during a review. Selecting an element with the comments pane open did nothing
visible at all; Properties was not behind the comments, it was not rendered.

The arbitration is now `rightSidebarTab` (in `uiSlice`) plus a strip shown ONLY
when both panels are genuinely available, and it follows the surface the user
last acted on: a selection switches to Properties (an effect in `RightSidebar`),
opening a thread or arming the tool switches to Comments (`commentsSlice`). The
stale-properties case the old rule feared cannot arise, because a selection is
what puts the sidebar on Properties in the first place.

The tab strip and the panel live in one absolutely-positioned `.stack` column.
That positioning is what holds the panel at its full layout width while the
sidebar's own width animates — it used to sit on `.panelSlot` itself, which is
why a tab strip added as a flex sibling simply drew on top of the panel.

**Arming the tool opens the pane, disarming closes it; clicking a pin does
neither.** The line is between
"I am doing a review pass" (the `C` key or the Comment button — bring the queue)
and "what does this one say" (a pin — just the thread). Opening the right
sidebar shrinks the canvas viewport, so when a pin click opened the pane it
reflowed the board and shoved the very pin you had just clicked out from under
the cursor, while the popover flipped sides to dodge the pane that had appeared.
Reading one comment must not re-lay-out the editor; entering a review pass may.

Leaving comment mode — a second `C`, the Comment button again, or `Escape` —
takes the queue with it, so the round trip returns the editor to where it
started instead of leaving a pane behind to close by hand. That hangs off
`setCommentToolActive`, NOT off `commentToolActive` going false: placing a pin
also disarms the tool, and it does so by writing the field directly in
`beginDraftPin` precisely so committing a comment does not yank the queue out
from under the composer that is still open.

Closing the pane clears the bulk working set (a selection that outlived the
surface showing it would let a later "Delete selected" act on threads the user
has no memory of choosing) but does NOT close an open thread — the pane is a
list, the popover is a conversation.

It **swaps with** the Properties panel in one slot; it is not drawn over it, and
it shares the sidebar's width and resize handle. It also shares the standard
`PanelHeader` — same 36px bar, same icon close button, same `panel-close-<id>`
hook as every other editor panel. It did not, at first: a hand-rolled `<h2>` and
a literal `✕` glyph inset by the panel's own padding made a swap read as an
unrelated card appearing on top of the sidebar.

Entry points are all on the canvas — `C`, the Comment tool button, or a pin —
so the pane carries its own close button. The Client role reaches it through
all three; the board notes toolbar is not gated on editability.

### Bulk actions act on a selection, never on the filter

Checkboxes per row. Select-all fills the working set from the **currently
visible** rows, so filter + search + select-all is still the fast path — it just
goes through a state the user can see. A destructive action that silently
followed the filter would delete things the user was only looking at.

Selection is a mode, and every control for it is conditional on being in it.
Ticking the first row is what enters the mode; until then there is no action bar
and no select-all row, because a select-all with nothing selected is a control
for a mode you are not in. Leaving is the inverse — clearing the last checkbox —
so there is no Cancel button, and no "N selected" readout either, since the
select-all row directly below the bar already carries the count. Both were
restating what the checkboxes already showed.

The select-all row and a thread row share one two-column shape (a checkbox
gutter, then content inset by the row button's padding), declared in a single
grouped ruleset in `CommentsPanel.module.css`. Splitting them is how the header
tick and the row ticks drift out of alignment.

`Send to AI` sends outright rather than prefilling the composer: the composer's
draft is local component state, and a user who picked threads and pressed a
button named Send should see it in the transcript. The message asks the agent to
reply and resolve, so it meets the same anchor gate as `studio_resolve_comment`.

Two implementation notes worth keeping:

- **A pin wears a white ring** (`--canvas-comment-pin-ring`, a spread
  `box-shadow` rather than a border, so it sits outside the 26px marker instead
  of eating 2px of the badge). The token is fixed white and deliberately not a
  surface token: a pin floats over the *user's* rendered page, whose colours
  have nothing to do with the editor theme, and amber on an amber hero is
  otherwise invisible. `.active`'s outline steps out to `outline-offset: 2px` to
  clear it.
- **Pins do not scale with zoom.** They counter-scale via
  `scale(calc(1 / var(--canvas-zoom)))`. That custom property is republished by
  `useCanvas.applyTransformToDOM` on every rAF tick — it cannot come from the
  store, whose `zoom` is committed 100 ms *after* the last gesture event, so a
  subscribed counter-scale would lag a pinch and then snap.
- **A pin renders at its stored coordinate, not at the live rect of its element.**
  Matching Penpot (`position` + `frame-id`) and Figma. Tracking a rect would mean
  a rAF loop reading across the iframe boundary for every pin and a family of
  "the frame had not loaded yet" ordering bugs — and it degrades worse: when the
  element is gone a rect-tracking pin has nowhere to go, while a coordinate-anchored
  one is still exactly where the reviewer put it, with only its badge changed.

- **Zoom for placement maths comes from the transform matrix, never from
  `rect.width / offsetWidth`.** That ratio is the usual way to recover a CSS
  scale and it is correct for a frame's iframe, but the canvas transform layer
  has **`offsetWidth === 0`** — every board frame is `position: absolute`, so
  the layer has no in-flow content. The `> 0` guard then returned a
  plausible-looking `1`, and a pin dropped at 50% zoom was stored twice as far
  from its frame's corner as the user clicked, appearing to jump the moment it
  rendered. `canvasZoom.ts` reads the computed matrix instead — the thing
  actually on screen, so it cannot disagree with what was clicked.
- **A filtered thread list is derived in render, never in a selector.** Zustand
  reads a selector through `useSyncExternalStore`, so a selector that builds an
  array hands React a new reference on every snapshot read and the component
  re-renders forever. This shipped once as `selectVisibleThreads`, and the
  symptom was as bad as it gets: the whole `site-editor-body` error boundary,
  reported as "Editor chunk failed to load", from the moment the project
  contained a single comment. `CommentsPanel` now subscribes to
  `comments.threads` / `commentFilter` / `commentSearch` — three *stored*
  references — and calls the plain `visibleThreads(threads, filter, search)` in
  its body, where the React Compiler memoizes it. Every `select*` in
  `commentSelectors.ts` returns a stored reference or a primitive, and
  `comment-selector-stability.test.ts` enforces both halves of that rule.

- **Hovering a pin peeks at the thread's LATEST comment**, not its first. On a
  board of a dozen pins the question you are asking as you sweep the cursor is
  "what is the current answer here"; the opening comment is the one part you can
  usually already remember. It is a peek and not a popover — `pointer-events:
  none`, no actions, and suppressed for the thread that is already open, whose
  real popover is saying more.
- **Both popovers flip to the left of their pin near the canvas edge**
  (`usePopoverFlip`, shared by the draft and the committed thread so a comment
  does not jump sides the moment it is submitted). The decision measures the
  PIN's wrapper, not the popover's own rect — the pin does not move when the
  popover flips, so the question has a stable answer; measuring the popover
  asks "does where I am now overflow", which oscillates.
- **The panel row out-specifies `Button`'s fixed height** with a two-class
  selector (`.rowShell .row`). `size="sm"` sets `height: 26px` and
  `white-space: nowrap`, which clips a row whose whole point is two lines of
  author and preview. Same move as `.nodeViewSwitcher .nodeViewButton`, and the
  reason it is a descendant selector rather than `!important`.

- **Neither popover stops `pointerdown`.** `CanvasRoot`'s `@use-gesture` drag
  runs with `filterTaps: true`, which suppresses the click after a drag by
  calling `stopPropagation()` at React's root container. An overlay that
  swallows `pointerdown` hides the press from use-gesture, leaving its tap
  state stale so it kills every later click in the canvas. Guard by target
  instead — the canvas's own handlers already do.

The placement surface sits at `z-index: 52` — above the portaled selection/hover
rings (51) so a click on a selected element places a comment instead of
re-grabbing selection chrome, and below the notes toolbar (53) so the button that
armed the tool stays clickable to disarm it.

---

## Files

| Path | Role |
|---|---|
| `src/core/studio-comments/` | schemas, tolerant serializer, pure transforms, **`anchorResolve.ts`** |
| `src/core/studio-comments/location.ts` | ids → a described location, for both agent doors |
| `server/handlers/studio/commentsStore.ts` | disk IO, the op layer, ownership, `authorFromSession` |
| `server/handlers/studio/commentsRoutes.ts` | the two HTTP routes |
| `server/ai/mcp/tools/studio/commentTools.ts` | the three MCP tools + the anchor gate |
| `src/admin/pages/site/store/slices/commentsSlice.ts` | editor state (no HTTP) |
| `src/admin/pages/site/studio/commentActions.ts` | the op round trip |
| `src/admin/pages/site/canvas/BoardCommentsLayer/` | pins, popovers, the armed tool |
| `src/admin/pages/site/panels/CommentsPanel/` | the work queue |
| `src/admin/pages/site/studio/commentBulkActions.ts` | bulk delete + send-to-agent |
| `src/admin/pages/site/canvas/canvasZoom.ts` | live zoom off the transform matrix |
| `src/admin/pages/site/canvas/useCanvasToolShortcuts.ts` | the `T` / `F` / `C` keys |
| `src/ui/lib/useOutsidePointerDismiss.ts` | iframe-aware outside-click dismiss |
| `src/admin/pages/site/store/slices/commentSelectors.ts` | the read side — stored references only |
| `src/__tests__/architecture/comment-selector-stability.test.ts` | the gate on that rule |

---

## Not in v1, deliberately

Mentions and `@` autocomplete · per-user unread state and rail badges · live SSE
sync between sessions · email notification · reactions · attachments · threads on
the published site. Each is additive to the format above.
