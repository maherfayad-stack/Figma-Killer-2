# Studio Comments — plan

**Status:** proposed, not started. No comments code exists anywhere in the repo today,
and neither `STUDIO-IMPORT-V2-PLAN.md` nor `STUDIO-FIGMA-PARITY-PLAN.md` specs one.

**Decisions already taken** (2026-08-31, with the user):

| Question | Answer |
|---|---|
| Storage | `.studio/comments.json` on disk — travels with the repo, diffable, agent-readable |
| v1 scope | Pin + thread + resolve. No mentions, no unread badges, no live SSE sync |
| Agent | **Full loop in v1** — the agent reads a thread, makes the edit, replies, resolves |

---

## 0. Why this is not just "sticky notes with replies"

`board.notes` and `board.docs` already exist (`docs/features/board-annotations.md`).
They are **authoring furniture**: a designer's own scratch space, positioned in board
coordinates, belonging to a board.

A comment is a different object with a different lifecycle:

- It is **about something** — a specific element on a specific page — not merely *near* it.
- It has an **author** who is not necessarily the person reading it.
- It has a **terminal state**. A note is deleted when it stops being useful; a comment
  is *resolved*, and the resolution is part of the record.
- It is **addressed to someone**, and in this product that someone can be the agent.

That last point is the reason this feature is worth building rather than copying.
Figma cannot do it. Because Studio's document is a real repository on disk, a comment
file next to the source is something an agent can read, act on, and answer — which
turns review comments into work orders.

**Reference reading, already done:**
[Penpot's `comments.clj`](https://github.com/penpot/penpot/blob/develop/backend/src/app/rpc/commands/comments.clj)
for the data model (`comment_thread` carries `seqn`, `participants`, `position`,
`frame-id`, `is-resolved`; `comment` carries `thread-id`, `owner-id`, `content`) and
its 16 RPC commands. For the UI, Mobbin:
[Framer](https://mobbin.com/screens/c2cbaabb-c99b-4e13-a56a-f7ac59e6ba5e) (canvas pin +
thread popover + right-hand list — closest to our target),
[Magnific](https://mobbin.com/screens/3610f00a-ec02-4ed9-8a7c-47ab8ee17c3a)
(All/Open/Resolved filter + search over threads),
[Sketch](https://mobbin.com/screens/e8b9adb8-372f-49f5-ab7e-75cecf2f5a83) (pin with the
thread anchored to a drag handle),
[Gamma](https://mobbin.com/screens/b202d459-301a-4e00-92e9-4f10b0002174) (resolve check
in the thread header, quoted target above the comment body).

---

## 1. The hard part: what does a comment anchor to?

**Studio node ids are `path:line:col`** — see `docs/features/studio-import.md`, "Composite
node ids". They are derived from source position, so they change whenever anything above
them in the file changes. The store already treats this as normal:
`lifecycleActions.ts:359` filters `selectedNodeIds` down to ids that survived the last
re-parse and silently drops the rest.

Selection can be dropped. **A comment cannot.** Penpot and Figma never face this — their
documents are shape databases with stable UUIDs. Ours is a text file.

So the anchor is layered, most-meaningful to most-durable:

```ts
interface CommentAnchor {
  /** Board frame the pin was dropped on. `null` = free-floating on the board itself. */
  frameId: string | null
  /** Page that frame renders. Denormalized, so the anchor outlives the frame's removal. */
  pageId: string | null
  /** Offset in FRAME-LOCAL px (frame top-left = 0,0). The coordinate of record. */
  dx: number
  dy: number
  /** The node the pin was over when dropped. A hint that rots — never the truth. */
  node: CommentNodeHint | null
}

interface CommentNodeHint {
  /** `path:line:col` as of authoring. Usually stale within a day. */
  nodeId: string
  /** Child-index path from the page root, e.g. `[0, 2, 1]`. Survives edits ABOVE it. */
  indexPath: number[]
  /** What the node was — for the re-resolver and for a human reading the JSON. */
  moduleId: string
  /** First ~80 chars of its rendered text, or ''. The tiebreaker. */
  textSnippet: string
}
```

`resolveCommentAnchor(hint, page)` runs on every load and every re-parse and returns one
of four confidences:

| | Condition | Meaning | Pin renders at |
|---|---|---|---|
| `exact` | `nodeId` still resolves | Nothing moved | the node's live rect |
| `moved` | `indexPath` resolves, `moduleId` **and** `textSnippet` match | The file shifted, structure intact. Rewrite `nodeId` to the fresh one | the node's live rect |
| `drifted` | `indexPath` resolves, `moduleId` matches, text differs | Someone edited the thing being discussed | the node's live rect, flagged |
| `detached` | Nothing resolves | The element is gone | `(dx, dy)`, visibly detached |

This is Studio's "a write must have exactly one honest target" invariant applied to
reads. A pin never silently lies about what it points at; when it no longer knows, it
says so.

**This is the gate on the agent loop.** Any agent action that claims to have *addressed*
a thread must re-resolve the anchor first. `drifted` or `detached` → refuse, and reply in
the thread saying why. An agent editing a rotten anchor edits the wrong element in the
user's source — the single worst failure this feature can have. The refusal shape already
exists: `refuseStructuralEdit` in `src/core/page-tree/sourceStructure.ts`.

---

## 2. File format — `.studio/comments.json`

Its own file, **not** a fifth array inside `boards.json`. Three reasons: a comment
belongs to the project and references a *page*, not to a board; `boards.json` is on a hot
800 ms autosave path that should not carry comment bodies; and a separate file keeps the
git diff of a review legible.

```json
{
  "version": 1,
  "nextSeq": 4,
  "threads": [
    {
      "id": "0f3c…",
      "seq": 3,
      "boardId": "26cc49cd…",
      "anchor": { "frameId": "c77356…", "pageId": "home", "dx": 148, "dy": 302,
                  "node": { "nodeId": "pages/Home.tsx:77:19", "indexPath": [0, 2, 1],
                            "moduleId": "base.text", "textSnippet": "Get started" } },
      "resolved": false,
      "createdAt": "2026-08-31T09:12:04.000Z",
      "comments": [
        { "id": "a91b…", "author": { "userId": "smoke-local-test",
                                     "displayName": "Maher", "kind": "user" },
          "body": "This should use the display face, not body.",
          "createdAt": "2026-08-31T09:12:04.000Z", "editedAt": null }
      ]
    }
  ]
}
```

Notes on the shape:

- **`seq`** is Penpot's `seqn` — the number drawn in the pin. Monotonic per project via
  `nextSeq`, never reused, so "comment 3" stays a stable name in conversation even after
  threads 1 and 2 are deleted.
- **`author` is a denormalized snapshot**, not a foreign key. `userId` is there for
  identity within one install; `displayName` is there so the file is still readable after
  a clone, which is the entire point of putting it on disk.
- **`author.kind: 'user' | 'agent'`** — required by the full-loop decision. An agent's
  reply must be visibly the agent's.
- **Schema-first** (TypeBox, `Static<>`-derived types), unlike `studio-board`'s plain
  interfaces. This file crosses an HTTP boundary in both directions and is read by MCP
  tools; `BoardGuideSchema` already set this precedent inside `studio-board` itself.

---

## 3. Work breakdown

### Phase 1 — the model (M) · pure, no UI, no server

New engine module `src/core/studio-comments/` with a barrel (and therefore a
`no-core-barrel-deep-imports` entry).

| File | Contents |
|---|---|
| `types.ts` | TypeBox schemas + `Static<>` types for `CommentsFile`, `CommentThread`, `Comment`, `CommentAnchor`, `CommentNodeHint`, `AnchorConfidence` |
| `serialize.ts` | `parseCommentsFile` / `serializeCommentsFile`. Tolerant coercion mirroring `studio-board/serialize.ts` — a malformed thread is dropped, never a thrown parse |
| `commentsModel.ts` | Pure `CommentsFile -> CommentsFile` transforms: `createThread`, `addReply`, `editComment`, `deleteComment`, `resolveThread`, `reopenThread`, `moveThread`, `deleteThread` |
| `anchorResolve.ts` | `resolveCommentAnchor(hint, page)`. Pure, takes a `NodeTree` |

Tests: JSON round-trip, `seq` monotonicity across create/delete/create, and all four
confidence outcomes driven off a real fixture page.

> **Land this phase and review it against a real project before building UI on it.** The
> anchor resolver is the whole feature's honesty; everything downstream inherits whatever
> it gets wrong.

### Phase 2 — server (S)

- `server/handlers/studio/commentsStore.ts` — read/write `<dir>/.studio/comments.json`,
  mirroring `boardGeometry.ts`.
- Routes in `server/handlers/studio.ts`, modelled on the existing `/boards` pair:
  `GET /admin/api/studio/comments?dir=` and `POST /admin/api/studio/comments`.

**One deliberate divergence from the boards precedent: POST an *operation*, not the whole
file.** `/boards` does whole-file last-write-wins, which is fine there because board
geometry has exactly one writer — the person dragging. Comments are inherently
multi-writer; that is the entire feature. An op-based endpoint (`{ dir, op: {...} }`,
server applies it to the file it just read) is barely more code and eliminates the
clobber class outright.

**Author identity comes from the session, server-side. Never from the request body.** A
body-supplied `author.userId` would let any Client-role account post as the owner.

Access: any authenticated user who can reach the site editor can read and write comments,
including the **Client** role (`site.content.edit` only — see
`docs/features/auth-and-access.md`). That role is the reviewer persona this feature
exists for; gating comments above it would defeat the purpose.

### Phase 3 — store + canvas (L)

- `commentsSlice.ts` — `comments`, `commentsDirty`, `activeThreadId`, `draftThread`.
  Routes every mutation through Phase 1's pure transforms, exactly as `boardSlice` routes
  through `@core/studio-board`. Autosave effect alongside `useStudioBoardsPersistence`.
- **A comment tool mode.** There is no `activeTool` concept in the store today. Add the
  smallest honest version — `commentToolActive: boolean` plus `C` / `Esc` bindings — not
  a general tool-mode system for a single tool.
- `canvas/BoardCommentsLayer/` — `BoardCommentsLayer.tsx`, `CommentPin.tsx`,
  `CommentThreadPopover.tsx`. Mounted **last** in `StudioBoardLayers` so pins stay
  clickable above every other board layer.

> **This layer does not go inside `CanvasTransformLayer`, unlike `BoardNotesLayer`.** A
> pin must not scale with zoom — at 20% a transformed pin is unreadable and unclickable.
> It mounts as an untransformed sibling and positions through
> `createCanvasOverlayMeasureSession` (`canvasOverlayGeometry.ts`), the same path the
> selection overlay already uses to track elements inside the iframes.

Placement flow: tool active → click → resolve `(frameId, dx, dy)` and the node under the
cursor via `canvasNodeLookup` → open a draft popover → the first submitted comment commits
the thread. A draft abandoned on blur is discarded, as in Figma.

### Phase 4 — Comments panel (M)

- New `comments` entry in `LeftSidebarPanelId` and `PRIMARY_RAIL_ITEMS`
  (`sidebars/PanelRail/PanelRail.tsx`).
- Search field, All / Open / Resolved filter, threads grouped by page, click to fly the
  canvas to the pin. Straight off the Magnific and Framer references.

> **Icon:** `vendor/pixel-art-icons/` has no comment/message/chat glyph, and
> `bun run icons:sync` needs a checkout of the private upstream repo
> (`PIXEL_ART_ICONS_SRC`). If that is not available, draw the glyph in
> `src/ui/components/InspectorIcons/` — `icon-catalog-integrity` Gate 3 permits
> hand-drawn glyphs under `src/ui/`, and the panel-density pass set that precedent.

### Phase 5 — the agent loop (M)

`server/ai/mcp/tools/studio/commentTools.ts`:

| Tool | Capability | Does |
|---|---|---|
| `studio_list_comments` | `studio.read` | Open threads with their anchors and **live** confidence, filterable by page |
| `studio_reply_comment` | `studio.write` | Post a reply authored `kind: 'agent'` |
| `studio_resolve_comment` | `studio.write` | Resolve / reopen |

The full loop needs no new orchestration — it is four existing-shaped calls:
`studio_list_comments` → `studio_apply_edits` → `studio_reply_comment` →
`studio_resolve_comment`.

Two supporting changes:

- **The refusal gate** (§1). `studio_resolve_comment` re-resolves the anchor and refuses
  on `drifted` / `detached`, replying with the reason instead of resolving.
- `pushStudioLiveReload` gains `commentsChanged?: boolean` alongside the existing
  `boardsChanged`, so an agent's reply appears in an open browser without a reload.
  Browser-side handler in `src/admin/pages/site/agent/studioLiveReload.ts`.

### Phase 6 — docs + gates (S)

`docs/features/studio-comments.md` (new); `docs/features/mcp-connectors.md` (three tools);
`docs/features/board-annotations.md` (a pointer saying notes are authoring furniture and
comments are review — they are not the same object); `docs/agent-refs/path-index.md`;
`docs/agent-refs/glossary.md` (the four anchor confidences);
`no-core-barrel-deep-imports.test.ts` (the new barrel); `STATE.md` handoff.

---

## 4. Risks

1. **The anchor resolver is the feature.** If confidence is wrong, the agent edits the
   wrong node in the user's source. Mitigated by landing Phase 1 alone first and reviewing
   its four outcomes against a real project.
2. **Scope tension in the decisions taken.** "Pin + thread + resolve" is a one-PR feature;
   "full agent loop" adds the agent author identity, three MCP tools, the refusal path and
   the live-push flag — roughly one extra phase. Phase 5 is separable and can land as its
   own PR if Phases 1–4 want to ship first.
3. **`indexPath` is only as good as the tree's stability.** Wrapping a section in a new
   `<div>` shifts every descendant's path by one level and will read as `detached` even
   though nothing was really removed. Acceptable for v1 — it fails toward "I don't know",
   which is the safe direction — but worth a second pass later.
4. **Two browser sessions on one project.** The op-based POST in Phase 2 removes the
   clobber risk; without it this inherits `boards.json`'s last-write-wins.

---

## 5. Not in v1, deliberately

Mentions and `@` autocomplete · per-user unread state and rail badges · live SSE sync
between sessions · email notification · reactions · comment attachments · threads on the
published site. Each is additive to the file format above; none is required to make the
feature useful.
