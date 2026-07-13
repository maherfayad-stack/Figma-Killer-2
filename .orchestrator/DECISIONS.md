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
