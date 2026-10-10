# Multiplayer (live presence)
> **Purpose:** who else is on the board and where they are looking: the live channel, roster, cursors, selections and follow mode · **Read when:** touching `/admin/api/studio/live`, `@core/studio-live`, `studio/live/`, the peer overlay or the toolbar avatars · **Trust:** current (presence only; see "Not built yet") · **Owner:** server-engineer · **Verified:** not yet

Several people can open the same project and see each other live: an avatar per person in the toolbar, a named cursor on the board, a ring around what a peer has selected, and a click-to-follow on an avatar. **This is presence only.** Edits are not live: they still go to the project's files through the HTTP routes (`/save`, structural, boards, comments), guarded by the route gate, the `expect` fingerprints and the project write lock. The socket never carries an edit, so there is no second write policy. Live edits, per-user undo and conflict messaging are the later MP-3 .. MP-8 bundles of the plan.

## Owner decisions, adopted provisionally (owner to confirm)

| Decision | What shipped |
|---|---|
| Transport (OD-MP-2) | One WebSocket for presence and notifications; edits stay on HTTP |
| Who joins (OD-MP-3) | Anyone with `site.read`, so viewers and reviewers get presence; no separate capability; share-link guests are not in the room yet |
| Room size (OD-MP-9) | 12 members per project (`LIVE_ROOM_CAP`); the 13th is refused with 503 / close 1013 |
| Deployment (OD-MP-10) | One server process per project directory; rooms live in memory, like the write lock |

## The channel

`GET /admin/api/studio/live?dir=<project>` upgrades to a WebSocket. It is declared in `server/handlers/studio/routeCapabilities.ts` (`read: 'site.read'`, no mutate), and `server/index.ts` hands it to `handleLiveUpgrade` (`studio/live/upgrade.ts`) before the normal router, because Bun needs the server object to upgrade.

`routeGate` applies its CSRF Origin rule only to state-changing methods and a handshake is a GET, so the upgrade checks it itself (cross-site WebSocket hijacking): an absent or disallowed `Origin` is a 403. Then the same gate as every Studio route: undeclared path 404, no session 401, no `site.read` 403. The project directory goes through `resolveProjectDir`; anything outside the workspace is a 404 with no path in the body. In development Vite's `/admin/api` proxy cannot carry a WebSocket under Bun (a good upgrade hangs; verified with a probe), so `scripts/dev.ts` and `scripts/e2e-dev.ts` publish `VITE_STUDIO_LIVE_BACKEND_PORT` and the editor connects to the backend directly (page hostname, so the session cookie goes along; the page's origin is on the dev allowlist). Production is same-origin. The room is keyed by the project's **real path** (`lockKey`, the key the write lock uses).

Authority is decided once at the upgrade and re-checked every 30 s from the handshake's own cookie: a user who is demoted or whose session is revoked is closed with 1008.

### Frames (`src/core/studio-live/protocol.ts`, TypeBox)

| Direction | Frame | Notes |
|---|---|---|
| client to server | `hello` | joins the room; nothing else is accepted first |
| | `presence {cursor?, selection?, viewport?}` | partial: absent = unchanged, `null` = clear |
| | `follow {memberId or null}` | a view preference; the server only counts followers |
| | `ping` | heartbeat, every 2 s |
| server to client | `welcome {epoch, rev, you, members, presence}` | the roster and everyone's current cursor/selection |
| | `member-joined`, `member-left` | |
| | `presence-batch {frames}` | coalesced, never echoed to the sender |
| | `followed-by {count}` | tells a target someone follows, so it starts sending its viewport |
| | `rev {rev}` | the project revision moved (a write session ended) |

Every inbound frame is validated against the union, capped at 4 KB by the socket (`maxPayloadLength`), and budgeted (40 presence frames/s, 5 other frames/s). An invalid frame, a binary frame, a frame before `hello` or a budget breach closes the socket 1008/1003. Coordinates are **board space**; each peer draws them through its own pan and zoom.

### Timing

- Heartbeat 2 s; a member silent for more than 5 s (`LIVE_TTL_MS`) is dropped.
- The server forwards at most one frame per member per 33 ms (~30 Hz). A newer field replaces an older one (drop-latest), so memory is bounded by the member count, not the send rate.
- A member's `viewport` is forwarded only to a member following them, and the target sends it (10 Hz) only while `followed-by` says someone does.
- `epoch` is random per server start and `rev` is a counter bumped as each write session ends (`onProjectWriteSessionEnd` in `projectWriteLock.ts`), so revision order is lock order. The client records the epoch; acting on a change ("resync") arrives with live edits.

### Identity

Each member gets an identity colour from the ten accents (`colorIndex` 1..10 maps to `--accent-N`): stable per **user** per room (two tabs of one person share a colour), distinct across the first ten users. The toolbar shows one avatar per person.

## Client

| Piece | File |
|---|---|
| Connection, reconnect (500 ms to 8 s backoff), outbound 30 Hz throttle | `src/admin/pages/site/studio/live/liveClient.ts` |
| Store and the pure protocol reducer | `.../live/livePresenceStore.ts` |
| Mount point (editor body) | `.../live/useStudioLive.ts` |
| Cursor sender (admin window plus each same-origin frame document) | `.../live/useLiveCursorSender.ts` |
| Selection sender (re-announced when `rev` moves) | `.../live/useLiveSelectionSender.ts` |
| Follow, both halves | `.../live/useLiveFollow.ts` (maths in `@core/studio-live` `followViewport.ts`) |
| Toolbar avatars and the "Reconnecting" chip | `.../live/PeerAvatars.tsx` |
| Board overlay (cursors, name labels, selection rings) | `src/admin/pages/site/canvas/BoardPeersLayer/` |

- The overlay is a board layer inside `CanvasTransformLayer`, click-through, **not inside any frame's DOM**. Cursors counter-scale with `--canvas-zoom`. Rings are measured from the peer's node ids in the frame showing that page (`peerSelectionRects.ts`); an id that does not resolve draws nothing rather than something misplaced.
- A peer's selection is hidden while its `rev` is older than ours (node ids are source positions); the peer re-announces after the revision change. This is a heuristic until live edits (MP-3) add a real resync.
- **Follow:** click an avatar. The follower frames the target's visible board rectangle, centred, at the zoom that fits it. Any wheel over the canvas, or any pan/zoom the follower makes (a zoom control, a key, the hand tool), stops following. The target's leaving also stops it.
- If the socket is down the editor is single-player as before and the toolbar says "Reconnecting...". There is no second transport. A 1008 close (forbidden, invalid, over budget) is not retried.
- Cursors are sent while the pointer is over the admin canvas or a same-origin frame; a frame in bridge mode (a cross-origin live frame) reports no pointer to the parent, so the cursor holds its last position there.

## Gates

`server/handlers/studio/live/__tests__/` (room, TTL, coalescing, follow, session re-check, rate limit, upgrade refusals), `src/core/studio-live/__tests__/` (schemas, fuzz, follow maths), `src/admin/pages/site/studio/live/__tests__/` (reducer, client reconnect and throttle), `studio-routes-capability-declared.test.ts` (the route is declared), `studio-live-no-writes.test.ts` (the live handlers import no write path), `no-core-barrel-deep-imports.test.ts` (`@core/studio-live`).

## Not built yet

Live edit fan-out and reconcile, identity-vs-content fingerprints, per-user hunk undo, boards/notes/comments ops, agent as a member, share-link guests, conflict messages (the plan's bundles MP-3 .. MP-8).
