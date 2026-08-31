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
| The armed tool (`C`) | `canvas/BoardCommentsLayer/CommentPlacementLayer.tsx` |
| Tool button | `CommentToolButton`, in `BoardNotesToolbar` |
| Per-comment / per-thread actions | `CommentKebab` — one ⋯ menu, not inline buttons |
| Work queue | `panels/CommentsPanel/` — **right sidebar**, mode `comments` |
| Bulk delete / send-to-agent | `studio/commentBulkActions.ts` |

### The pane lives on the right, and has no rail button

The comments list is a `RightSidebar` mode, not a left-rail panel. That is the
same place the Properties panel appears and for the same reason: the right
sidebar shows whatever you just clicked. Comments **win** over properties when
both would show, because clicking a pin does not clear the node selection —
without a winner the pane would show the properties of whatever was selected
before, beside a comment the user just opened.

`commentsSlice` owns the interlocks so no call site can forget them: opening a
thread or arming the `C` tool opens the pane; closing the pane clears the bulk
working set (a selection that outlived the surface showing it would let a later
"Delete selected" act on threads the user has no memory of choosing) but does
NOT close the open thread (the pane is a list, the popover is a conversation).

Entry points are all on the canvas — `C`, the Comment tool button, or a pin —
so the pane carries its own close button. The Client role reaches it through
all three; the board notes toolbar is not gated on editability.

### Bulk actions act on a selection, never on the filter

Checkboxes per row plus a select-all. Select-all fills the working set from the
**currently visible** rows, so filter + search + select-all is still the fast
path — it just goes through a state the user can see. A destructive action that
silently followed the filter would delete things the user was only looking at.

`Send to AI` sends outright rather than prefilling the composer: the composer's
draft is local component state, and a user who picked threads and pressed a
button named Send should see it in the transcript. The message asks the agent to
reply and resolve, so it meets the same anchor gate as `studio_resolve_comment`.

Two implementation notes worth keeping:

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

The placement surface sits at `z-index: 52` — above the portaled selection/hover
rings (51) so a click on a selected element places a comment instead of
re-grabbing selection chrome, and below the notes toolbar (53) so the button that
armed the tool stays clickable to disarm it.

---

## Files

| Path | Role |
|---|---|
| `src/core/studio-comments/` | schemas, tolerant serializer, pure transforms, **`anchorResolve.ts`** |
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
