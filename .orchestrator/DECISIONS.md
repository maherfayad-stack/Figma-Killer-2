# DECISIONS — Architectural Decision Records (ADR)

ADR format. Numbered, dated. Alternatives-rejected required. Standing positions from playbook §5 are pre-decided; log only exceptions.

---

## ADR-0001 — Pin tldraw to ^5.2.4
**Date:** 2026-07-13 · **Status:** Accepted (pin) / license open (see ADR-0005)
**Decision:** Use tldraw `5.2.4` (latest on npm as of today). Kept behind `packages/canvas` abstraction per playbook §5.4 so a swap/fallback stays cheap.
**Rationale:** Playbook mandates workers never pin from memory; 5.2.4 verified from `registry.npmjs.org/tldraw/latest`. Major 5.x is current.
**Alternatives rejected:** Older 3.x/4.x (behind current, and 4.0 already introduced the license-key requirement so no licensing benefit to pinning back); custom canvas now (premature — only the §5.4 fallback if license terms force it).

## ADR-0002 — Pin ts-morph to ^28.0.0
**Date:** 2026-07-13 · **Status:** Accepted
**Decision:** `ts-morph 28.0.0` (verified npm latest). Core of `packages/ast-engine`.
**Rationale:** Current major; ts-morph is the boring-proven choice for format-preserving TS manipulation (playbook §5). Pair with prettier for output (never AST default printer).
**Alternatives rejected:** jscodeshift/recast (weaker TS-type awareness); Babel-only (loses TS type info needed for prop-schema extraction in P4); hand-rolled AST (reinventing).

## ADR-0003 — Pin Vite to ^8.1.4
**Date:** 2026-07-13 · **Status:** Accepted
**Decision:** `vite 8.1.4` (verified npm latest) for studio app + each file-app dev server + the `vite-plugin-source-uid`.
**Rationale:** HMR is load-bearing for the whole edit loop; latest major. Plugin API stable.
**Alternatives rejected:** Next.js for file-apps (playbook wants standalone Vite+React+TS per-folder apps; Next adds framework weight & routing assumptions); Webpack (slower HMR).

## ADR-0004 — Pin @supabase/supabase-js to ^2.110.2
**Date:** 2026-07-13 · **Status:** Accepted (P6 scope)
**Decision:** `@supabase/supabase-js 2.110.2` (verified npm latest) for the Phase 6 backend.
**Rationale:** Playbook §4/P6 names Supabase; boring-stack tie-breaker. Not needed until P6 — pin recorded now to prevent memory-pinning later.
**Alternatives rejected:** Raw Postgres + custom auth (more surface, no gain for v1); Firebase (weaker SQL/git story).

## ADR-0005 — tldraw licensing → RESOLVED: watermark for now
**Date:** 2026-07-13 · **Status:** Accepted (human decision 2026-07-13)
**Resolution:** Build on tldraw Hobby/Trial with the "made with tldraw" watermark shown; revisit the $6,000/yr Business License before public launch. Keep `packages/canvas` abstraction tight so upgrade-to-paid or §5.4 custom-camera fallback stays cheap. No spend approved now.
**(original escalation below)**
**Context:** tldraw SDK ≥4.0 requires a license key to run in production; without a Business License the "made with tldraw" watermark is shown (Hobby) or use is dev/trial-only (100-day trial). Business License ≈ **$6,000 USD/yr per team** (tldraw.dev/pricing).
**Why escalated:** Cost + license implication — explicitly outside orchestrator autonomous authority (operating model §1 Advisor). Also touches playbook §5.4 (fallback plan).
**Options presented:** (a) buy Business License; (b) ship watermarked under Hobby; (c) start on Trial and defer; (d) build custom camera fallback (§5.4, ~2–4 wks, no fee, more risk).
**Blocks:** P1 completion (not P0 start). Decision recorded here once made.
**Sources:** tldraw.dev/pricing, tldraw.dev/legal/tldraw-sdk-3-x-license, tldraw.substack.com license updates.

## ADR-0006 — Almosafer DS IS the imported design system → RESOLVED
**Date:** 2026-07-13 · **Status:** Accepted (human decision 2026-07-13)
**Context:** `./design-system/` is a clone of `github.com/tajawal/design-system` (Almosafer DS): tokens, variables, React components, icons, an MCP server.
**Resolution:** The Almosafer DS is the design system *imported inside the software* — by default it is the source for tokens, variables, and components that user file-apps consume. The playbook's `templates/design-system` scaffold MUST mirror the Almosafer DS's token/component format so the real one drops in cleanly. Studio UI chrome is explicitly NOT built from it (see ADR-0007).
**Consequence:** `packages/tokens` (P4) must parse the Almosafer DS token format; `ComponentsPanel` (P4) reads its components; seed/e2e project's `design-system/` = Almosafer DS.

## ADR-0007 — Studio UI chrome mirrors Penpot, NOT the Almosafer DS
**Date:** 2026-07-13 · **Status:** Accepted (human decision 2026-07-13)
**Decision:** The studio *application's own UI* (workspace shell, sidebars, inspector, toolbar, dashboard — `apps/studio` + `packages/ui`) must be **as close as possible to Penpot's UI/UX**. It is NOT built from or themed by the Almosafer DS. The Almosafer DS is for the *content the user designs*, not the tool.
**Overrides:** Playbook §2.7 / §5 "dogfood our own tokens" for chrome. `packages/ui` = Radix/shadcn styled to resemble Penpot's look-and-feel; Almosafer DS tokens do not theme the chrome.
**Rationale:** Human directive. Penpot is the UX north star (playbook §2 already maps every Penpot UI file to ours); the human wants visual fidelity to it, cleanly separated from the design content layer.
**Alternatives rejected:** Dogfooding Almosafer DS in chrome (rejected by human — conflates tool and content); generic shadcn default look (loses Penpot fidelity).

## ADR-0008 — Studio monorepo at repo root; existing ./design-system treated as reference clone
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator)
**Decision:** Init git + the pnpm/turborepo monorepo at the current working-dir root. The existing `./design-system` folder is its own git repo (tajawal/design-system) — do NOT move, delete, or nest it as studio source in P0. Gitignore it at the studio level; use it as the format reference for `templates/design-system` and, later, as the seed project's imported DS (ADR-0006).
**Rationale:** Avoids embedded-git-repo tangles in P0; keeps the real DS pristine; templates stay standalone (playbook §4/P0 pitfall).
**Alternatives rejected:** Moving DS under templates/ (mutates a real repo); git submodule (premature ceremony for P0).

## ADR-0009 — packages/protocol freeze v1: resolutions to P0 change-requests
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator, Advisor)
**Context:** P0 infra worker raised CRs on protocol shapes with no full playbook spec. Protocol freezes at end of P0; resolving now.
**Decisions:**
- **wrap-node `wrapper.tag`** stays literal `"div"` for v1 (matches Appendix B + §4/P3 exactly; smallest surface). Widening to a `div|span|section` allowlist is a deliberate later change requiring a new ADR (breaking schema edit).
- **DaemonEvent `file-changed`** added to the union (Appendix B's 7 + this) — accepted; reconciles Appendix B with §4/P0 prose. Not a silent change.
- **TreeNode** shape `{uid, kind, tag, dynamic, component?, children}` authored fresh (no playbook spec) — accepted as frozen v1. P2 (bridge) and P5 (LayersPanel) owners MUST build against it; if they need fields, that is a CHANGE-REQUEST to me, not a silent edit.
- **FrameMeta.comments / .zoomBookmarks** item shapes kept minimal for v1. P7 (Comments) may extend `comments[]` **additively** (playbook §7 anchor: `{file, frameName, nodeUid|frameXY}`) without re-freeze; removing/renaming existing fields needs an ADR.
**Rationale:** Boring/proven, smallest reversible step; keep Appendix B authoritative; make every future change explicit.

## ADR-0010 — Token source of truth = Almosafer DS format; DTCG is interop only
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator) — deviates from playbook §4/P4
**Context:** Playbook §4/P4 assumes tokens live in DTCG `tokens.json`. The real Almosafer DS (ADR-0006) stores tokens as CSS custom properties + a JS mirror, NOT DTCG.
**Decision:** `packages/tokens` (P4) treats the Almosafer DS token format (CSS custom props + JS mirror) as the PRIMARY parse/emit target. DTCG import/export becomes an interop feature layered on top, not the core storage model. The build pipeline (tokens → CSS vars + Tailwind preset consumed by file-apps) is unchanged.
**Rationale:** ADR-0006 makes the real DS the imported design system; forcing it into DTCG would fork it from upstream. Deviation is scoped and additive (DTCG still supported for import).
**Alternatives rejected:** Convert Almosafer DS to DTCG at P0 (mutates a live upstream repo; ADR-0008 forbids touching it); DTCG-only (breaks the real DS import).

## ADR-0011 — Almosafer DS is untyped .jsx with no per-component metadata → P4 prop-extraction risk
**Date:** 2026-07-13 · **Status:** OPEN — decide at P4 planning; flag to human (scope/effort)
**Context:** Playbook §4/P4 ComponentsPanel uses ts-morph TYPE extraction on typed `.tsx` (`meta.ts propsSchemaFrom:'types'`). The real Almosafer DS is ~40 UNTYPED `.jsx` components with zero metadata files. Type extraction cannot work as specified.
**Options (to decide before P4 build):** (a) hand-author `meta.ts` + prop schemas for each real DS component; (b) add a JS/PropTypes/runtime fallback extraction path in `packages/tokens`/ComponentsPanel; (c) generate `.d.ts` types for the DS upstream. Likely (a)+(b) combined.
**Impact:** P4 effort + fidelity. Not blocking now (P4 is downstream of P3). Will present options to human at P4 kickoff.

## ADR-0012 — Daemon↔studio transport interface (frozen for P1)
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator) — freezes the P1 cross-boundary surface
**Decision:** The sync-daemon exposes to the studio app:
- **Control WebSocket** at `ws://127.0.0.1:<daemonPort>` (localhost-bind ONLY, playbook §5.8). Server→client carries `DaemonEvent` (frozen protocol union). Client→server carries `CanvasOp` (queued; actual AST apply is P3 — in P1 the daemon may no-op/echo ops) plus control requests.
- **One Vite dev server per file-folder** (portpool from 5200+). Each frame renders at `http://127.0.0.1:<frameServerPort>/?frame=<Name>` — direct HMR connection, NOT proxied through the daemon (playbook §1/P1 pitfall).
- **Bootstrap handshake:** on ws connect the daemon sends project info: `{ frames: [{ framePath, name, devServerUrl }], daemonPort }`.
**Additive protocol extension (APPROVED):** the sync-daemon worker MAY add a `ProjectInfo`/bootstrap-message zod schema + type to `packages/protocol` **additively**. The frozen types (CanvasOp, DaemonEvent, FrameMeta, TreeNode, NodeUid) MUST NOT change. `project-info` is a control/handshake message, deliberately NOT a `DaemonEvent` variant (events = state changes only).
**Runtime coordination file:** `<projectRoot>/.studio/daemon.json` (ports/pids only) is permitted — it holds NO design/scene state, is gitignored, ephemeral. Auditors: this is not a One-Rule violation.
**Rationale:** Freezing this now lets P1's daemon and canvas workstreams integrate deterministically; keeps HMR direct; honors localhost-only security.
**Alternatives rejected:** Proxying HMR through daemon (playbook pitfall, kills HMR perf); adding project-info to DaemonEvent (pollutes the frozen event union with non-events).

## ADR-0013 — sync-daemon P1 CR resolutions + control-ws wire format (frozen for canvas worker)
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator, Advisor)
**Context:** P1 sync-daemon worker raised 4 CRs; the canvas worker must build to a concrete wire format ADR-0012 only specified at a high level.
**Decisions:**
- **Control-ws wire format FROZEN** (canvas builds to this exactly):
  - First message per connection = bare `ProjectInfo` `{frames:[{framePath,name,devServerUrl}], daemonPort}` (no `t` field).
  - Subsequent server→client = bare `DaemonEvent` (always has `t`).
  - Client→server op: `{kind:'canvas-op', opId, op:CanvasOp}` → daemon replies `{t:'op-rejected', opId, reason}` in P1 (real AST apply = P3).
  - Client→server geometry: `{kind:'set-geometry', fileFolder, framePath, x,y,w,h}` → no direct reply; debounced (~250ms) persist + broadcast `{t:'file-changed', file:'<fileFolder>/.studio/canvas.json'}`.
- **Path conventions:** `FrameMeta.framePath` / `NodeUid` = file-folder-relative (frozen). Daemon wire paths (`DaemonEvent.file`, `ProjectInfo.framePath`) = project-root-relative. Canvas maps between them via the fileFolder segment / `devServerUrl`. Accepted (one daemon spans multiple file-folders).
- **frame add/remove signalling:** ACCEPTED for P1 as generic `file-changed` on the frame path; canvas infers add vs remove via `existsSync`. Edits additionally emit `hmr-update`; add/remove do not. Dedicated `frame-added`/`frame-removed` DaemonEvent variants are DEFERRED — add additively in P2/P3 when uid-remap plumbing lands, only if the generic signal proves too coarse (revisit ADR).
- **Geometry-write → watcher duplicate `file-changed`:** accepted as cosmetic for P1; add a generation-counter/self-write suppression before P3 if noisy.
- **design-system tokens-changed vs components-changed heuristic:** accepted (no P1 consumers); P4 must revisit.
**Rationale:** Freeze the exact interface the next serialized worker needs; keep additive-only; smallest reversible step; defer speculative event variants.

## ADR-0014 — Close P1 interface gaps before tag: additive daemon create-frame + get-canvas-json APIs
**Date:** 2026-07-13 · **Status:** Accepted (orchestrator, Advisor) · _(re-logged 2026-07-13 after an external edit dropped the first append; AUDIT-3 finding #1)_
**Context:** P1 canvas worker met all four acceptance criteria (HMR<1s, drag→canvas.json, new-frame, 20 frames ~118fps) but flagged two interface gaps (CR1/CR2): (1) no daemon `create-frame` control-ws API — the production `onCreateFrame` threw; new-frame was demonstrated only via a dev-only HTTP `create-frame-server`; (2) no daemon way to fetch a file-folder's `.studio/canvas.json` — canvas read it via an undocumented `GET <viteOrigin>/.studio/canvas.json` static-serve reliance.
**Decision:** The daemon MUST be the sole filesystem-writer (P3 git checkpoints, P6 locks depend on this). Closed both gaps with ADDITIVE control-ws APIs BEFORE tagging `phase-1-complete`:
- `{kind:'create-frame', fileFolder, name}` → daemon writes `src/frames/<Name>.tsx` (from template), patches `src/frames.ts`, appends the `.studio/canvas.json` entry — inside the existing per-file `FileOpQueue`, atomic — then broadcasts `file-changed`. Rejects path-traversal / duplicate / unknown-folder names (tested).
- `{kind:'get-canvas-json', fileFolder}` → returns the file-folder's FrameMeta (reply `get-canvas-json-result`; errors via `control-error` keyed by requestId). Removes the Vite-static-serve reliance.
- New request/reply shapes live in additive `packages/protocol/src/control-messages.ts`; frozen types (CanvasOp, DaemonEvent, FrameMeta, TreeNode, NodeUid, ProjectInfo) unchanged.
**Authorized scope exception:** ONE P1-integration worker was allowed to touch BOTH `packages/sync-daemon` (add APIs) AND `packages/canvas` (wire production `onCreateFrame` + canvas.json read; production path no longer uses the dev-only HTTP server — the dev harness keeps its own copy for standalone runs only). Normal one-package boundary resumes after.
**CR3 (empty file-folder has no learned origin):** deferred — real only for a brand-new zero-frame file-folder; revisit when dashboard/file-create lands (P5/P6).
**Verification:** AUDIT-3 (P1 gate) reproduced (c) through the real daemon `create-frame` API (dev HTTP server unused by production + e2e); protocol freeze intact; One Rule clean (canvas makes zero direct fs writes).

## ADR-0015 — P1 defect fix: native tldraw duplicate/copy-paste create fileless "phantom" frames → implement real file-backed duplicate
**Date:** 2026-07-13 · **Status:** Accepted (human decision 2026-07-13, found via dogfooding)
**Context:** P1 left tldraw's built-in duplicate/copy/paste enabled. They create canvas shapes with NO backing `.tsx`; the frames→shape reaper (`StudioCanvas.tsx:377-381`) deletes any frame shape lacking a record on the next sync (triggered by moving a frame → `setFrames` → sync effect). User sees the phantom copy vanish. Root cause: native tldraw shape ops violate the file-is-frame model. The P1 e2e covered create/drag/HMR but not duplicate → audit gap.
**Decision:** Implement REAL file-backed duplicate (human chose this over safe-disable): duplicating a frame issues a daemon op that COPIES the source `.tsx` to a new frame file (unique name), patches `src/frames.ts`, appends a `.studio/canvas.json` entry offset from the source — all via FileOpQueue, atomic — producing a real, persistent, record-backed frame. Native tldraw duplicate/copy/paste/cut for `ccs-frame` shapes must be intercepted/disabled so they can never create fileless phantoms.
**Scope note:** This pulls the P5 context-menu "duplicate" feature forward as a P1 correctness fix. Justified: the current behavior is data-loss-feeling and the fix is small (create-frame + source copy). Still within "finish P1 correctly," not "start P2."
**Authorized scope exception:** ONE worker may touch `packages/sync-daemon` (add `duplicate-frame` handler), `packages/canvas` (intercept native ops → daemon duplicate; guard reaper against in-flight duplicates), and `packages/protocol` (additive `duplicate-frame` request/reply in control-messages.ts). Frozen types unchanged.
**Regression requirement:** e2e must cover: duplicate → new `.tsx` exists on disk with copied content → move EITHER frame → BOTH persist (none vanish); native copy/paste/cut no longer create phantom frames.

## ADR-0016 — P2 kickoff: hard-stop lifted; freeze the Selection-Bridge interface before spawning
**Date:** 2026-07-14 · **Status:** Accepted (human go "continue with the rest of the phases", 2026-07-14)
**Context:** Human lifted the post-P1 hard stop and authorized running the remaining pipeline (P2→P8), gated per phase. P2 (Selection Bridge) has two coupled workstreams: (WS-A/ast) `packages/vite-plugin-source-uid` + `packages/bridge`, and (WS-B/canvas) edit-mode + selection overlay. P1's biggest win was pre-freezing the daemon↔canvas wire format (ADR-0012/0013) so serialized workers had zero interface churn. Do the same here before spawning.

**Decision — freeze two contracts, additive-only over the FROZEN protocol (NodeUid, UidRemapEvent already exist):**

### 1. `data-uid` derivation (vite-plugin-source-uid emits; ast-engine consumes in P3)
- Every `JSXElement`/`JSXFragment` gets `data-uid="<relPath>:<astPath>"` where `relPath` = file-folder-relative source path (e.g. `src/frames/Hero.tsx`), matching frozen `NodeUidSchema` (`.+\.tsx:.+`).
- `astPath` is derived **purely from AST structure (JSX nesting position), never byte offsets** — HMR-stable across whitespace/formatting/comment edits (playbook §P2 pitfall). Recommended encoding: dot-separated positional segments from the module root through the JSX tree (e.g. `d0.1.2` = default-export component → child index 1 → child index 2); exact string is the worker's call **but MUST** be (a) deterministic, (b) whitespace/format/comment-invariant, (c) resolvable back to the node in P3, (d) NodeUid-regex-valid.
- **CRITICAL to avoid two-parser divergence (babel here vs ts-morph in P3):** the derivation MUST live in ONE shared, exported, golden-tested module (`packages/vite-plugin-source-uid` public API, e.g. `deriveUidPath()` / a documented spec), so P3's ast-engine consumes the identical algorithm rather than reimplementing it. This is a hard requirement, not a suggestion.
- `data-dynamic="true"` on any JSX node inside a `CallExpression` map / conditional (ternary) / logical (`&&`,`||`) expression → the editable-surface contract (§0) locks these.
- `data-component="<name>"` on JSX whose tag resolves to an imported component; prefix `ds:` when the import source resolves into `design-system` (e.g. `data-component="ds:Button"`).
- Plugin runs **only in studio dev mode** (guarded by an env/flag the daemon sets); production/standalone file-app builds are untouched (P0 standalone contract preserved).

### 2. Bridge ↔ Studio postMessage protocol (canvas overlay ↔ file-app iframe) — FROZEN
All messages carry `source: 'ccs-studio' | 'ccs-bridge'`. Request/reply pairs carry a `requestId`. **Origin validation is mandatory (§5.8):** studio accepts only messages whose `source==='ccs-bridge'` from its known iframe (localhost dev-server origins); bridge accepts only `source==='ccs-studio'` from `window.parent`. All coordinates are **iframe CSS-pixel space**; studio transforms iframe→frame-shape→canvas space (worker owns the transform; test at multiple zooms).
- studio→bridge `{type:'hit-test', requestId, x, y}` → `{type:'hit-test-result', requestId, hit: {uid, rect, dynamic:boolean, component:string|null, breadcrumb:[{uid,name}]} | null}` (`rect={x,y,width,height}`; nearest `data-uid` ancestor of `elementFromPoint`).
- studio→bridge `{type:'report-rects', requestId, uids:string[]}` → `{type:'rects-result', requestId, rects: Record<uid, rect|null>}`.
- studio→bridge `{type:'subscribe-rects', uids:string[]}` / `{type:'unsubscribe-rects'}` → bridge streams `{type:'rects-update', rects}` on scroll/resize/DOM-mutation, **rAF-throttled**, while subscribed (playbook: stream rect updates while selected).
- studio→bridge `{type:'set-hover', uid:string|null}` / `{type:'set-selection', uids:string[]}` → optional in-iframe highlight (no reply); primary selection/hover rendering is the studio canvas-space overlay.
- bridge→studio (unsolicited) `{type:'ready', frame:string}` handshake once injected + DOM-ready; `{type:'rects-update', rects}` while subscribed.
- HMR: selection lives in the studio zustand store (WS-B owns). After HMR the daemon emits frozen `uid-remap`; studio re-resolves selection through the map (unmapped-but-present uid → keep; absent → mark detached). Bridge is stateless w.r.t. remap.

**Workstream split & sequencing (serialize A→B, per P1 lesson):**
- **WS-A (ast, Sonnet 5 medium):** plugin + bridge, headless sub-acceptance provable ALONE — golden tests for data-uid/data-dynamic/data-component (incl. Arabic/RTL fixture round-trip) + a jsdom/happy-dom test where bridge `hit-test` returns the correct nearest uid + breadcrumb and `report-rects` returns rects. Wire plugin+bridge injection into the file-app template behind the studio-mode flag.
- **WS-B (canvas, Sonnet 5 medium):** double-click frame → edit mode (camera lock, iframe `pointer-events:auto`); zustand selection store; studio overlay draws hover(blue outline+name tag)/selection rects in canvas space via transformed bridge rects; breadcrumb in top bar; dynamic node → lock badge; Esc exits; selection survives HMR via `uid-remap`. Real-daemon Playwright e2e as acceptance.

**Rationale:** Freeze exactly the interface the next serialized worker needs; additive-only over the frozen protocol; the shared-derivation-module rule kills the babel/ts-morph divergence risk before P3 depends on it; smallest reversible step.

**ADR-0016 addendum — instrumentation MUST NOT break the standalone contract:**
The file-app template must keep **ZERO `@ccs/*` runtime/dev deps** (P0 standalone contract, AUDIT-1: "0 @ccs deps, 0 symlinks into packages/"). Therefore `vite-plugin-source-uid` + bridge are **layered in by the daemon at studio-boot only**, NOT added to the file-app `package.json`. Approach (worker owns exact wiring): the daemon boots the file-folder's Vite with a studio-provided config that `mergeConfig`s the file-folder's own `vite.config.ts` and adds the source-uid plugin + bridge-injection (resolved from the MONOREPO's node_modules via the daemon side, e.g. `--config <studioConfig>` and/or an env flag like `CCS_STUDIO=1`). HARD invariant: standalone `pnpm dev` in a `files/<name>` (no studio env/config) must serve byte-identically to P0 — no data-uid attrs, no bridge. This makes WS-A a two-package change (vite-plugin-source-uid + bridge, plus a minimal additive daemon boot hook); still no @ccs dep leaks into templates/files.

## ADR-0017 — P2 WS-A ratifications: Babel version pin + shared-derivation is a golden CORPUS, not shared code
**Date:** 2026-07-14 · **Status:** Accepted (orchestrator)
**Context:** WS-A (vite-plugin-source-uid + bridge + daemon studio-boot hook) landed green (plugin 23/23, bridge 23/23, sync-daemon 117/118 — the 1 is a pre-existing chokidar timing flake, verified 5/5 in isolation; whole-monorepo typecheck 12/12). Two CRs need an orchestrator ruling.

**Decision 1 — Babel version pin (CR1):** ratified. `@babel/{core,traverse,parser,types}` (+types) and `jsdom` pinned to the versions ALREADY resolved transitively via `@vitejs/plugin-react` (@babel 7.29.x), NOT npm-latest 8.x. Rationale: a second Babel major in the tree fractures the JSX toolchain the source-uid plugin must run *before* (`enforce:'pre'`). The ADR-0001..0004 "npm-view latest" discipline is for NET-NEW top-level runtime choices; aligning to the toolchain's own transitive major is the safer move. Revisit when @vitejs/plugin-react itself moves to Babel 8.

**Decision 2 — the shared derivation is a CORPUS, not a function (CR3, amends ADR-0016):** ADR-0016 required the astPath derivation to live in "ONE shared module" so P3's ts-morph can't diverge from P2's babel. WS-A correctly showed a *literal* shared function is impossible across two parser APIs. Resolution: the source of truth is (a) the 8 numbered semantic rules documented in `packages/vite-plugin-source-uid/src/uid-path.ts`, AND (b) a **golden conformance corpus** — a set of input `.tsx` fixtures → expected `{node → uid}` maps — that BOTH implementations must satisfy. **P3 acceptance now REQUIRES ast-engine's ts-morph uid resolver to pass this exact corpus** (byte-identical uid strings to the babel plugin's output on every fixture, incl. Arabic/RTL + dynamic-lock cases). WS-A should have emitted this corpus as a shared fixture; if it did not, the P3 worker's FIRST task is to extract it from the plugin's output and freeze it as the conformance suite. This converts the divergence risk from "hope the port matches" to "a test fails if it doesn't."

**Decision 3 — astPath encoding accepted as frozen:** `d<rootIndex>` roots in source order; each node `<nearestJsxAncestorPath>.<siblingIndex>` skipping non-JSX constructs. Matches ADR-0016's recommended shape; whitespace/comment/format-invariant (proven by stability test). `JSXFragment` limitation (counted in numbering, cannot carry a DOM `data-uid`) accepted and documented — fragments render no DOM node, so they are never hit-test targets; breadcrumbs skip them.

**Carry-forward (P8 hardening):** `sync-daemon/src/watcher.test.ts` (and a port-timing test) flake under full-parallel test load though green in isolation — deflake (fake timers / higher tolerance / serialize) before they erode the CI gate. Out-of-monorepo `projectRoot` node-resolution assumption in `studio-vite-config.ts` → revisit at P6 (cloud/remote projects).

## ADR-0018 — P3 kickoff: freeze the AST Write-Back interface before spawning (the critical path)
**Date:** 2026-07-14 · **Status:** Accepted (orchestrator) · Builds on FROZEN `CanvasOp` (protocol/ops.ts), FROZEN `UidRemapEvent` (protocol/events.ts), P0-frozen golden harness, ADR-0017 conformance corpus.
**Context:** P3 makes canvas ops mutate real source files: format-preserving, undo-able, deterministic. Two workstreams: (WS-A/ast) `packages/ast-engine` pure lib; (WS-B/daemon) op-queue write-through + uid-remap + git checkpoints + undo/redo. Serialize A→B (B needs `applyOp`). Freeze the contract now (the P1/P2 lesson).

**FROZEN interface (additive over the P0 stub + frozen protocol):**
1. **`applyOp(sourceText: string, op: CanvasOp, opts?: {prettierConfig?}): { newText: string; uidRemap: Record<NodeUid,NodeUid> }`** — pure, ZERO IO (from P0 stub; keep exactly). ts-morph manipulations + prettier — NEVER the AST default printer (§P3 pitfall #1). Success returns `{newText, uidRemap}`.
2. **Refusals throw a typed `ApplyOpError { code, message }`** (additive new export). Codes (frozen): `dynamic-locked` (target is data-dynamic — inside map/ternary/logical, §0), `not-editable` (prop value is an expression/spread, not literal|template-string — "edit in code"), `uid-not-found`, `unsupported`. The daemon catches → replies frozen `op-rejected` with `reason`. Success shape unchanged.
3. **uid resolver MUST pass the ADR-0017 golden CONFORMANCE CORPUS** — ast-engine parses sourceText with ts-morph and resolves each op uid's astPath to a node using the IDENTICAL encoding the babel plugin emits (`d<root>.<idx>...`, structure-based). **WS-A's FIRST task:** extract that corpus from `@ccs/vite-plugin-source-uid` output (input.tsx → {node→uid} maps, incl. Arabic/RTL + dynamic-lock cases) and freeze it as a shared conformance suite that ast-engine's resolver must pass byte-identically. This kills the babel↔ts-morph divergence risk by test.
4. **`uidRemap`** = old→new NodeUid for every SURVIVING node whose astPath shifts due to the op (insert/delete/move shift sibling indices; wrap adds a parent level). Deleted nodes are absent. Daemon emits it as the FROZEN `uid-remap` DaemonEvent `{t:'uid-remap', file, map}`.
5. **`UidRemapEvent.file` = file-folder-relative** (matches NodeUid's embedded relPath) — RATIFIES the P2 WS-B CR (c). Frozen.
6. **Editable-surface enforcement (§0) is computed from AST structure**, not the DOM — same rule as `vite-plugin-source-uid/src/dynamic.ts` (inside CallExpression callback / ternary / logical). Every op refuses a dynamic target with `ApplyOpError('dynamic-locked')`. `set-prop` refuses non-literal/non-template-string values with `not-editable`.
7. **prettier = shared config.** ast-engine embeds the root `.prettierrc.json` options as a constant (a test MUST assert it matches root `.prettierrc.json` so they never drift), applied to every output; `opts.prettierConfig` may override. Keeps applyOp pure (no file reads).
8. **set-classes Tailwind conflict groups** — setting `bg-red-500` removes other `bg-*`; comprehensive group table (bg/text/p/m/flex/grid/rounded/border/…), golden-tested. `cn()`/`clsx()` → touch only the FIRST string-literal arg; fully-dynamic className → `not-editable` (§P3 pitfall #2).
9. **Undo/redo stack lives in the DAEMON (WS-B), not ast-engine.** Inverse computed BEFORE apply against the pre-image; `delete-node` inverse stores the removed JSX text (an `insert-node`-like restore). ast-engine MAY expose `invertOp(sourceText, op): CanvasOp`-style helper; daemon owns the stack. Undo must return the file BYTE-IDENTICAL to before (acceptance).
10. **Concurrent IDE-edit guard (§P3 pitfall #3):** daemon snapshots file hash/mtime before apply; if the on-disk file changed since the AST snapshot → re-parse before applying, or reject with `op-rejected` reason "file changed, retry". All writes via the existing per-file `FileOpQueue` + atomic rename (daemon is sole fs-writer, One Rule).
11. **git checkpoints:** daemon auto-commits the file-folder's OWN git repo (`git init` if absent — nested repo inside the monorepo-gitignored `files/`, no interference) every N ops OR 30s idle, message `studio: <op summary>`. Local only; remote push is P6.
12. **`{token}` set-prop value (TokenRefSchema):** P3 handles literals/null fully; a `{token}` value may be MINIMALLY handled or refused `unsupported` for now — full token→class/var mapping is P4 (where the token pipeline exists). Flag, don't guess.

**Workstream split & sequencing (serialize A→B):**
- **WS-A (ast, Sonnet 5 medium):** `packages/ast-engine` — `applyOp` for all 7 ops + `ApplyOpError` + uid resolver (passes ADR-0017 corpus) + embedded prettier + Tailwind conflict table + `invertOp`. Sub-acceptance provable ALONE (zero IO): ≥60 golden cases (incl. all §P3-listed: existing spread, self-closing conversion, cn()/clsx, move-with-leading-comments, insert into empty fragment, tailwind conflict groups, unicode/RTL byte-exact) + conformance corpus + an in-memory PROPERTY test (apply N random valid ops → still parses, prettier-stable/idempotent, every op's inverse restores byte-identical). NO daemon, NO files.
- **WS-B (daemon, Sonnet 5 medium):** wire `handleCanvasOp` → applyOp → FileOpQueue atomic write-through; emit `uid-remap`; concurrent-edit guard; daemon undo/redo stack; git checkpoints. Full file-based acceptance: apply 500 random valid ops to a real file-app → still typechecks + builds + renders; diffs prettier-stable/minimal; undo returns byte-identical file. Real-daemon e2e/integration test.

**Rationale:** freeze exactly what the serialized workers need; additive-only over frozen protocol; the corpus rule converts the highest architectural risk (two-parser uid divergence) into a failing test; keep the daemon the sole fs-writer + sole git-committer.

## ADR-0019 — P3 WS-A ratifications (ast-engine core)
**Date:** 2026-07-14 · **Status:** Accepted (orchestrator) · ast-engine landed green (128 tests, 64 golden, conformance corpus byte-identical vs real babel plugin, 240-op property test; typecheck 12/12; no rogue commit; protocol + vite-plugin zero-diff).
**CRs ruled on:**
1. **`synckit` dep + prettier→dependencies — ACCEPTED (with a WS-B watch).** ADR-0018 froze `applyOp` SYNC (P0 stub + golden-runner call it synchronously); prettier v3 `format()` is Promise-only. `synckit` (same mechanism eslint-plugin-prettier uses) runs prettier in a persistent worker thread + `Atomics.wait` — no fs/network of its own, so zero-IO-in-the-fs-sense holds. Preserving the frozen sync contract over changing it was the right priority. **WATCH for WS-B:** `Atomics.wait` blocks the calling thread for each format (~ms); the daemon must call `applyOp` inside the per-file `FileOpQueue` task and the 500-op acceptance must show no pathological daemon stall. If it stalls, revisit (worker-pool offload or async-signature amendment).
2. **`InverseOp` extension (`restore-node`/`unwrap-node`) + `applyInverseOp` — ACCEPTED.** The frozen 7-op `CanvasOp` union can't losslessly express delete's inverse (arbitrary captured JSX) or wrap's inverse (unwrap). These are ast-engine-internal undo types, NOT wire protocol — `@ccs/protocol` untouched. WS-B's undo stack uses `invertOp`/`applyInverseOp`.
3. **Tailwind conflict groups are FLAT, not a cascade hierarchy — ACCEPTED (carry-forward).** Covers the playbook's requirement (`bg-red-500` evicts other `bg-*`) and 22 group families, golden-tested. Does NOT model `px-4` vs `p-2` interaction (tailwind-merge does). Refine toward tailwind-merge semantics in P4/P8 if users hit it.
4. **`invertOp` refuses (not silently lossy) — ACCEPTED, good discipline.** Refuses when set-text original isn't plain text; set-prop/set-classes target spread/dynamic; insert-node targeted a self-closing parent (one-way container conversion).
5. **"Required props defaulted" for ds-component insert NOT implemented — ACCEPTED, deferred to P4.** Pure zero-IO ast-engine can't see the DS prop schema (that's P4's ts-morph type extraction). insert-node emits a bare self-closing tag + auto-added `design-system` import. **Carry-forward P4:** default required props once the component prop schema exists; until then inserted DS components may render with missing required props.
6. **`{token}` set-prop value → `unsupported` — ACCEPTED, deferred to P4** (needs the token→class/var pipeline).
**Note (process win):** the property test caught 5 real bugs pre-audit, incl. a mixed static/dynamic children index-vs-uid desync — exactly the silent-addressing-corruption class §5#3 warns about. Keep property tests mandatory for ast-engine changes.

## ADR-0020 — P3 gate security hardening: file-folder write-boundary containment (AUDIT-6/6b/6c)
**Date:** 2026-07-15 · **Status:** Accepted (orchestrator; forced by 3 adversarial audit rounds)
**Context:** P3 makes control-ws `CanvasOp`s write real source files. `NodeUid`'s relPath half is attacker-controlled (arrives over the socket). AUDIT-6 proved a crafted uid (`../../outside/target.tsx:d0`) escaped the file-folder sandbox and wrote an arbitrary file — the daemon never validated containment. AUDIT-6b then proved a SECOND escape via a pre-existing symlink inside the folder (pnpm projects are symlink-heavy; not exotic). Both directly violate One-Rule "daemon = sole fs-writer, scoped to its file-folder" + §5.8.
**Decision — containment enforced at the fs-write TRUST BOUNDARY (daemon), NOT by mutating the FROZEN `NodeUid` schema:**
- `packages/sync-daemon/src/safe-path.ts` `resolveContainedPath(root, relPath)` is the ONE shared check, called at every op→path site (`daemon.ts resolveFileFolderForOp` both branches + `op-apply.ts` write boundary):
  1. Lexical: reject empty/blank, absolute, and `..`-escape (`path.resolve` + `startsWith(root+sep)` — the `+sep` defeats prefix-sibling `/x/demo` vs `/x/demo-evil`).
  2. Realpath: resolve the REAL (symlink-free) path of both target (via `realpathNearestExisting` — lstat, walk to nearest existing ancestor if absent) and root, assert real target ⊆ real root. Follows symlink chains; realpath BOTH sides (macOS /var→/private/var). **Fail-closed** on realpath error (broken symlink/ELOOP/permission).
- WebSocket **Origin gating** in `ws-server.ts` (`verifyClient`/`isAllowedOrigin`): reject non-localhost Origins at handshake; allow no-Origin (native clients) + `http(s)://(127.0.0.1|localhost)[:port]`. Stops a malicious webpage the user has open from driving the daemon (localhost bind alone doesn't sandbox against browsers).
**Why NOT tighten `uid.ts`:** validation belongs where paths become real fs writes (the sole-writer daemon), keeping the protocol frozen; the schema can't know a file-folder root anyway.
**Residual (accepted, carry-forward):** TOCTOU symlink-swap between check and write — unreachable via the op API (no symlink-creation op); only a co-resident local process could race it, and per §5.8 that process already has the user's fs privileges. Optional `O_NOFOLLOW`/fd-verify write-path hardening deferred to P6 (cloud/container) / P8.
**Verification:** AUDIT-6c PASS — all lexical + symlink (direct/chained/relative/prefix-sibling) escapes rejected, legit symlinks not false-rejected, fail-closed on broken/loop, 45+ security regression tests, protocol zero-diff.

## ADR-0021 — P4 prop-extraction: manual meta.ts per component, authored FROM Code Connect + .jsx (resolves ADR-0011)
**Date:** 2026-07-15 · **Status:** Accepted (HUMAN decision 2026-07-15)
**Context:** ADR-0011 feared the Almosafer DS was untyped `.jsx` with no prop metadata. Inspection found MORE than feared: 39 components (`design-system/src/components/*.jsx`), of which **29 ship Figma Code Connect files** (`*.figma.tsx`, typed, declaring prop→variant schemas e.g. `Badge.variant: enum{Alert,New}`), and every `.jsx` exposes prop names + defaults via destructuring (`Badge({variant='alert', count, max=99, ...})`). Human chose **manual `meta.ts` per component** over auto-extraction (fidelity/control over convenience).
**Decision:** P4 authors a typed `meta.ts` for each of the 39 components (playbook's `components/*/meta.ts` convention: `{name, description, category, props: Record<name,{type:'enum'|'string'|'boolean'|'number'|'node', enum?, default?, control, required?}>}`). **Author them FROM the existing sources** — read each component's `.figma.tsx` Code Connect (enum values/variants) + `.jsx` destructuring (prop names/defaults) so the hand-authored schema is accurate, not guessed; JSON `control` fallback for un-inferable props (generics/unions, playbook pitfall). A drift test asserts each meta.ts's prop names ⊆ the component's actual destructured props. Where a component lacks Code Connect (10), derive from `.jsx` + a manual pass.
**Consequence for P3 carry-forward:** ds-component insert now CAN default required props — done CLIENT-SIDE (P5 ComponentsPanel emits `insert-node` then follow-up `set-prop` ops for each required default from meta.ts), NOT via a protocol change (CanvasOp frozen).

## ADR-0022 — P4∥P5 partition + FROZEN design-system engine API (parallel-safe)
**Date:** 2026-07-15 · **Status:** Accepted (HUMAN chose parallel; orchestrator partitions)
**Context:** P4 (tokens+components) and P5 (studio chrome) both touch studio UI in the playbook — collision risk if run in parallel. Partition to make them genuinely independent (the P1/P2/P3 pre-freeze lesson).
**Decision — split by DATA vs CHROME:**
- **P4 = design-system ENGINE (no studio chrome):** `packages/tokens` (parse Almosafer `design-system/src/tokens/tokens.js` JS-export shape [ADR-0010] → emit CSS custom properties per theme light/dark + a Tailwind preset; file-app template consumes the preset); daemon `design-system/**` watch → rebuild token outputs → HMR ripple to all file-apps; `meta.ts` authoring (ADR-0021) + a component-catalog lib reading them; additive daemon control-message for token CRUD writes (daemon = sole fs-writer). Fully parallelizable — zero studio-UI dependency. Sub-acceptance: edit a token → emitted CSS/preset changes → a file-app consuming the preset updates <1s via daemon HMR; catalog API returns correct prop schema (Badge.variant enum); DTCG import/export round-trips.
- **P5 = studio CHROME (all UI):** `apps/studio` + `packages/ui` (Radix/shadcn primitives with the studio's OWN Penpot-grade chrome styling — NOT the Almosafer DS; ADR-0006/0007/0008: Almosafer DS is the IMPORTED DS for user content, the studio chrome is its own thing). Dock/layout, LayersPanel (virtualized JSX tree from daemon tree-snapshots), Inspector (§2.3 sections, controls emit P3 ops), Toolbar, ComponentsPanel + TokensPanel (UI), context menu, keyboard map, Dashboard. Consumes P1 canvas (`@ccs/canvas` StudioCanvas), P2 selection store, P3 ops (control-ws). Sub-acceptance: Playwright builds a small landing page using ONLY the UI → git diff clean/prettier/builds.
- **FROZEN engine API (the P4↔P5 seam; P5 mocks it until P4 lands):** `@ccs/tokens` (or `@ccs/design-system`) exports: `TokenModel` (sets, themes, tokens `{name,value,type,group}`, alias resolve); `listComponents(): {name,category,description}[]`; `getPropSchema(name): {props: Record<name,{type,enum?,default?,control,required?}>}`; `tokensForProperty(cssProp): TokenRef[]` (token-aware inputs). Token edits + component inserts flow through EXISTING mechanisms (daemon token-CRUD control-message; P3 `insert-node`+`set-prop` ops) — no CanvasOp/protocol-frozen change.
- **Studio chrome mirrors Penpot** (ADR-0007); studio UI must support RTL (`dir="rtl"`, CSS logical properties) from day one (§P5 pitfall, GCC market).
**Sequencing:** spawn P4-engine + P5-chrome workers now, both to the frozen API. Each gates independently (own audit) but both must land before P6. Integration wiring (real P4 API into P5 panels) is a small pass after both cores.
