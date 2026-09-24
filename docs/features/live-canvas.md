# Live canvas (Tier 2 frames)
> **Purpose:** how a board frame shows the user's real running app: the dev server, the live origin, the in-frame runtime and the frame adapter · **Read when:** touching a live frame, `devServer.ts`, `server/liveOrigin.ts`, `@core/studio-runtime`, or any canvas code that talks to a frame's document · **Trust:** current · **Owner:** canvas-engineer · **Verified:** 2026-09-23

At trust tier `run-project` (Tier 2, the default: [`trust-tiers.md`](trust-tiers.md)), a board frame is the project's **own dev server** rendering the page, in a cross-origin iframe, with Studio's selection, hover, resize and editing drawn inside it by a small runtime module. Typing, navigation, hover states and JS animation behave as they do in the app. Every edit still goes through the same AST writeback as a static frame; the dev server's HMR then shows the result.

---

## TL;DR

- **One dev server per project**, spawned from the project's own `dev` (else `start`) script, only when that script invokes `vite` (`server/handlers/studio/liveCapability.ts`). Manager: `server/handlers/studio/devServer.ts`.
- **A second, cookie-free listener** (`server/liveOrigin.ts`, `LIVE_PORT`, default `PORT + 1`) proxies `/p/<projectKey>/*`, HTTP and WebSocket, to that dev server. The user's code never runs on the admin origin and never sees the admin session.
- **The Vite plugin** (`src/core/studio-runtime/vitePlugin.ts`) stamps `data-node-id` on every JSX element with the same id the parser mints, and injects the in-frame runtime (`src/core/studio-runtime/runtime.ts`).
- **The editor never touches a live frame's `Document`.** Every canvas feature talks to a frame through `FrameDocumentAdapter`: `PortalFrameAdapter` for static frames, `BridgeFrameAdapter` (TypeBox-validated `postMessage`) for live ones.
- **A live frame shows its static render until the runtime says `ready`**, then swaps (`LiveBoardFrame.tsx`). A frame whose dev server fails stays on the static render.
- Non-Vite projects never go live; the Live pill says "Live needs Vite".

## Architecture

```text
admin origin (PORT)                              live origin (LIVE_PORT)          project dev server
────────────────────────────────                 ───────────────────────          ──────────────────
BoardFrameView ──trust=run-project──▶ LiveBoardFrame
  ├─ static fallback (BreakpointFrame / poster)
  └─ IframeFrameSurface documentMode='bridge'
       src = <LIVE_ORIGIN>/p/<key>/__screen/<page> ──▶ server/liveOrigin.ts ──proxy──▶ vite (base /p/<key>/)
       BridgeFrameAdapter ◀──── postMessage ────────────────────────────────────▶ runtime.ts (in frame)
                                                                                     stamps via vitePlugin.ts
useDevServerPrewarm ──POST dev-server/start──▶ devServer.ts ──spawn──────────────────▶ (Tier 2 + vite only)
```

## The pieces

| Piece | File | Job |
|---|---|---|
| Dev-server manager | `server/handlers/studio/devServer.ts` | One reused, idle-timed subprocess per project, keyed by the resolved app root. Routes `GET dev-server/status`, `POST start` (both behind `requireTrustTier(dir, 'run-project')`), `POST stop` (ungated). The wire status carries `phase` (`stopped` / `booting` / `ready` / `failed`), `pid`, `startedAt` and a capped log, never the dev server's own URL |
| Capability check | `server/handlers/studio/liveCapability.ts` | `capable` only when the dev script invokes `vite`; otherwise `reason: 'not-vite'` |
| Live origin | `server/liveOrigin.ts` | Second `Bun.serve` listener. Resolves `<projectKey>` to a containment-checked project directory, forwards the full path (including `/p/<key>`) to a dev server whose `base` is `/p/<key>/`, strips `Set-Cookie`, and sets a CSP that allows framing only by the editor's origins |
| Config | `server/config.ts` | `resolveLivePort` (`LIVE_PORT`, else `PORT + 1`, never equal to `PORT`) and `resolveLiveOrigin` (`LIVE_ORIGIN`, else `http://localhost:<livePort>`). A tunnelled or self-hosted deployment must set `LIVE_ORIGIN` |
| Id stamping + runtime entry | `src/core/studio-runtime/vitePlugin.ts`, `idStamp.ts` | Stamps `data-node-id` with the parser's id and serves `virtual:studio-runtime`. Returns two plugin objects: the config/`resolveId`/`load` half runs in `vite build` too (the generated `main.jsx` imports the virtual module unconditionally); the stamping `transform` is `apply: 'serve'` only |
| In-frame runtime | `src/core/studio-runtime/runtime.ts` (+ `messages.ts`, `gestureForwarding.ts`, `hmrState.ts`, `inlineTextEdit.ts`, `resizeHandles.ts`, `dropCandidates.ts`, `optimisticDomOps.ts`, `optimisticStyle.ts`) | Draws rings and handles, measures nodes, forwards pointer/wheel/text events, applies optimistic DOM and style changes, preserves input and scroll state across HMR. A resize is the portal drag's: the same shared rule modules size it (Fixed companions from the stored markers the parent sends) and snap it (the tree peers and zoom the parent sends), and its guides paint in the parent |
| Shell bootstrap | `server/handlers/studio/prototypeShell/runtimeBridgeShellFile.ts`, `shellFiles.ts` | Ships the runtime as `prototype/studioRuntimeBridge.generated.js` and serves `/__screen/<key>`: the screen component alone at the top of the document, so the runtime can see and measure it. The bridge boots only when the frame is embedded and a parent origin is configured |
| Frame adapter | `src/admin/pages/site/canvas/frameAdapter/FrameDocumentAdapter.ts`, `BridgeFrameAdapter.ts`, `PortalFrameAdapter.ts` | The only interface canvas code uses to reach a frame's document |
| Live frame | `src/admin/pages/site/canvas/BoardFramesLayer/LiveBoardFrame.tsx`, `resolveLiveFrameSrc.ts` | Mounts the static fallback and the bridge iframe together and swaps on `ready` |
| Client hooks | `src/admin/pages/site/studio/useLiveOrigin.ts`, `useDevServerReadiness.ts`, `useDevServerPrewarm.ts`, `devServerRequests.ts` | Learn the live origin, poll readiness, start the dev server as soon as a Tier-2 canvas mounts |
| Parent-side consumers | `BoardFramesLayer/useBridgeFrameInteraction.ts`, `canvas/useBridgeSelectionChrome.ts`, `canvas/useBridgeFrameDiagnostics.ts` | Turn runtime messages into the same selection, pan, resize and text-edit calls a static frame makes; surface runtime errors |
| Mount policy | `src/admin/pages/site/canvas/BoardFramesLayer/framePool.ts` | Which frames hold a live iframe: every on-screen frame, plus recently seen frames up to a budget of 8 for live frames (a live frame costs two documents and a dev-server client until `ready`) |
| Status pill | `src/admin/pages/site/canvas/LiveRuntimePill.tsx` | Shows `Static` / `Live` / `Live needs Vite`, and holds "Back to static" |

The message catalogue (every runtime message, its in-frame source and its parent consumer) is in [`docs/agent-refs/canvas-internals.md`](../agent-refs/canvas-internals.md) → "A Tier 2 bridge frame: what crosses the wire, and who consumes it".

## Lifecycle of a live frame

1. The canvas mounts a project at Tier 2. `useDevServerPrewarm` calls `POST dev-server/start`; `devServer.ts` spawns the dev script with `minimalSubprocessEnv()` plus the project key, the editor's parent origin and `STUDIO_LIVE_BASE_PATH`.
2. `devServer.ts` tails the child's log file (the child writes to a file, never a pipe, so it survives an API restart) until Vite prints its `Local:` URL, then marks the entry `ready` and records `{ pid, baseUrl, projectKey }` under `.tmp/dev-servers/`. A restarted API process adopts a still-running child from that record instead of spawning a second one.
3. `BoardFrameView` renders `LiveBoardFrame`: the static render is visible, the bridge iframe loads `<LIVE_ORIGIN>/p/<key>/__screen/<page>` hidden.
4. The runtime boots in the frame and posts `ready`. `BridgeFrameAdapter` validates it; `LiveBoardFrame` shows the bridge iframe and unmounts the fallback.
5. The user edits. The inspector's style commit is previewed in the frame at once through `optimistic.style` (`speed-01`); structural gestures run `optimisticDomOps` (and a write the server refuses, or never answers, is taken back in the frame with `optimistic.revert`, since no HMR follows it); the writeback lands in source; Vite's HMR updates the frame; `hmrState.ts` restores input values, focus, scroll and open dialogs by node id.
6. A demotion to `static` (the pill) stops the dev server (`trustTier.ts`'s `enforceTierOnRunningProcesses`) and the frame returns to the static render.

## Why a separate origin

A same-origin proxy under the admin origin would have run the user's code, and every dependency it imports, with the admin session cookie attached to every fetch, able to call `/admin/api/*` as the user. Tier 2 is permission to run the project, not to hand it the account. The browser never attaches admin-origin cookies to a cross-origin request, so a second listener on a different port cannot read the admin cookie jar at all. `server/liveOrigin.ts` must not import the admin router or any session helper, gated by `src/__tests__/architecture/live-origin-isolation.test.ts`.

The cost of that choice is the adapter boundary: the parent cannot reach into a cross-origin document, so everything the editor did by touching a frame's DOM became a message.

## Ids inside a live frame

The Vite plugin stamps the **same id the parser mints** (`src/__tests__/studio-runtime/idParity.test.ts` parses the fixture corpus both ways and asserts identical id sets). Two shapes differ between the DOM and the tree and are resolved by `src/core/studio-runtime/liveNodeResolve.ts`:

- **Inlined components.** The parser mints a composite `callSite~component` id; the DOM carries the component's own `components/X.tsx:l:c`. The resolver walks up to the nearest stamped ancestor with a call-site id.
- **`.map` rows.** The DOM repeats one id; the parser mints `…#n`. The resolver uses the sibling index among same-id siblings (`occurrenceIndex` on the wire).

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Reading or writing a frame's `Document` from canvas code | A `FrameDocumentAdapter` method. Only `PortalFrameAdapter` holds a `Document` |
| A second trust check inside `server/liveOrigin.ts` | Trust the dev-server registry: a project only reaches `ready` if `devServer.ts` let it boot. A second copy of the gate drifts |
| Stripping `/p/<key>` in the proxy | Forward the full path; the dev server's `base` expects it |
| Closing the proxy's outbound WebSocket to Vite on browser disconnect | Leave it open (see the `close(ws)` handler in `server/liveOrigin.ts`): Bun's client close crashes Vite's HMR server with an unhandled `ECONNRESET` |
| Keying an optimistic style rule on a class name | Key it on the node's own stamped element: Studio's parsed class name is not the hashed name Vite's CSS-modules plugin put in the live DOM |
| Sending the dev server's own URL to the browser | Keep it server-internal; the browser only ever loads the live origin |

## Limitations

- **Vite only.** A project whose dev script is not a `vite` invocation (Next.js, CRA, a custom server) never goes live at any tier.
- **No poster after `ready`.** `useFramePosterCapture` cannot read a cross-origin document, so a live frame keeps the last poster its static render produced.
- **State a component derives from a fetch or a timer resets on HMR.** `hmrState.ts` restores form values, checked state, scroll, focus and open dialogs by node id, and nothing else.
- **An optimistic class edit previews on the edited node only.** Other elements that share the class update on the next HMR.
- **Package components still go through `componentBundle.ts` on Tier-2 boards**, although the dev server already serves them; removing that branch is ROADMAP §13 (LIVE-CANVAS L9).
- **The Tier-2 budgets are partly unmeasured.** Warm reopen to first live paint, save to HMR, and memory per live frame have no committed baseline (`docs/audits/2026-09-13-live-frame-memory-baseline.md` is a placeholder).

## Related

- [`trust-tiers.md`](trust-tiers.md): why a project is Tier 2 and how the gates work
- [`canvas-iframe-per-frame.md`](canvas-iframe-per-frame.md): the static (portal) frame this replaces at Tier 2
- [`docs/agent-refs/canvas-internals.md`](../agent-refs/canvas-internals.md): the message catalogue, and how drag, selection and text edit cross into a bridge frame
- [`docs/server.md`](../server.md): the server process and its listeners
- [`docs/deployment/README.md`](../deployment/README.md): `LIVE_PORT` / `LIVE_ORIGIN` for deployments
- Source of truth: `server/handlers/studio/devServer.ts`, `server/liveOrigin.ts`, `src/core/studio-runtime/`, `src/admin/pages/site/canvas/frameAdapter/`
- Gate tests: `src/__tests__/architecture/live-origin-isolation.test.ts`, `src/__tests__/studio-runtime/idParity.test.ts`, `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` (`@core/studio-runtime` is barrelled)
