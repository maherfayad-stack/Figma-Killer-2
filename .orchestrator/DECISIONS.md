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
