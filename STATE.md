# STATE

Shared memory for every agent working on this repo. **Read before working, write
before stopping.** Format and rules: [`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md).

Entry ids are `<area>-<nn>`. Areas in use: `parser`, `canvas`, `store`, `panel`,
`server`, `mcp`, `perf`, `sec`, `test`, `docs`, `meta`.

---

## Now

*(nothing in flight — pick up from the roadmap in `STUDIO-IMPORT-V2-PLAN.md`)*

---

## Blocked

### meta-02 — five roadmap decisions await a human call
- **Agent:** —
- **Stage:** blocked
- **Updated:** 2026-07-30
- **Goal:** unblock M1 of `STUDIO-IMPORT-V2-PLAN.md`.
- **Human action needed:** decide the five open questions in §5 of that plan —
  (1) default trust tier for a fresh import, (2) Tier 2 reference-render scope
  (dev server + Playwright vs static build), (3) CSS write-back scope for M3,
  (4) whether `studio.instance` needs a publisher representation,
  (5) where board frame default width lives.
  Each has a stated recommendation; confirming them is enough.

---

## Recently landed

### meta-01 — de-fork cleanup, full rename, agent infrastructure
- **Agent:** main session
- **Stage:** done
- **Updated:** 2026-07-30
- **Goal:** remove everything left over from the upstream CMS fork, rename the
  product throughout, and stand up durable agent docs + a specialist team.
- **Scope:** repo-wide.
- **Done so far:**
  - **Deleted:** 4 superseded plan/status docs, the upstream `CHANGELOG.md`,
    OSS community files (`CODE_OF_CONDUCT`, `SECURITY`, `CONTRIBUTING`,
    `.github/ISSUE_TEMPLATE/`, `FUNDING.yml`), the upstream e2e skill,
    `files/demo/`, `studio-demos/`, the empty `design-system/` submodule
    gitlink, 10 CMS-only feature docs, 11 CMS-only Playwright specs, and 4
    CMS-only e2e docs.
  - **Renamed** the product token across all 368 tracked text files, including
    load-bearing identifiers: `data-instatic-*` → `data-studio-*`,
    `/_instatic/*` → `/_studio/*`, `@instatic/*` → `@studio/*`,
    `INSTATIC_SECRET_KEY` → `STUDIO_SECRET_KEY`,
    `instatic_admin_session` → `studio_admin_session`, storage keys → `studio:`.
    Regenerated the QuickJS plugin bootstrap artifacts (`bun run bootstrap:sync`).
  - **Relocated** `templates/design-system/` → `design-system/` with a README
    stating what actually renders today (the installed npm package, 39
    components) vs what that folder is (a 1-component local scaffold).
  - **Rewired** `playwright.config.ts` — dropped the `dashboard-preflight` and
    `personas` projects whose specs were deleted; `setup` → `e2e` only.
  - **Repaired** every dangling doc link (verified: 0 remaining).
  - **Wrote** `PROJECT-BRIEF.md`, `STATE.md`, `docs/agent-refs/` (6 refs), and
    `.claude/agents/` (14 agents, all Sonnet 5).
- **Next step:** none — see `meta-02` for what unblocks the next milestone.
- **Decisions:**
  - CMS runtime code **kept**, not deleted — Studio's editor store, page tree,
    module engine, canvas, admin shell and auth are all built on it. Only docs
    and dead files were removed.
  - `@alm-design/design-system@1.1.2` stays the installed dependency. The local
    `design-system/` folder is not yet a replacement (1 component vs 39) and
    must not be pointed at until WS-3 lands.
- **Landmines:**
  - `PROJECT-BRIEF.md` and `STUDIO-IMPORT-V2-PLAN.md` were untracked when the
    rename ran, so the script skipped them. Any future repo-wide sed must
    operate on more than `git ls-files` output, or must run after staging.
  - `src/admin/pages/site/studio/fsCodemodAdapter.ts` **mirrors**
    `INLINE_ID_SEPARATOR` and `ComponentSource` as literals instead of importing
    them — importing the page-parser barrel pulls ts-morph into the browser
    bundle and blows the `AdminCanvasLayout` chunk budget. Keep them in sync by
    hand; nothing enforces it.
- **Verification:** `bun run build` pass (exit 0). Studio suites
  (`page-parser`, `studio`, `studio-board`, `admin/.../studio`, `siteImport`)
  **493 pass / 0 fail**. Full `bun test`: 6768 pass / 201 fail — see
  `standing-01`.
- **Human action needed:** none.

---

## Standing notes

### standing-01 — ~200 full-suite failures are pre-existing and Windows-only
Measured 2026-07-30 on `feat/alm-figma-killer-studio-shell`. `bun test` reports
roughly 6768 pass / 201 fail. Sampled causes are all **environmental on
Windows**, not logic:

- `EBUSY` unlinking temp SQLite databases under `%TEMP%\cms-test-*`,
- doubled absolute paths (`src\C:\Users\...`) in architecture gates that join
  paths,
- mixed `\` / `/` separators defeating string comparisons
  (`codemirror-lazy-only.test.ts`, `dispatcher-html-pipeline.test.ts`).

**Triage rule:** before assuming you broke something, run only the suites
covering your change. `bun run build` is the reliable whole-repo signal — it
type-checks everything and is separator-agnostic. Do **not** try to fix these;
they belong to the environment, not to your diff.

### standing-02 — UI changes are dogfooded by the human, not by agents
Do not run browser or Playwright passes to validate UI work. Run the static
gates (`bun run build`, `bun test <your suites>`, `bun run lint`) and end your
handoff with a concrete **Human action needed** line naming the route and the
exact thing to look at. This is a deliberate cost decision.

### standing-03 — the canvas has two known, specced performance defects
Both are diagnosed in `docs/agent-refs/canvas-internals.md` §Perf and specced in
`STUDIO-IMPORT-V2-PLAN.md` WS-5. Do not re-diagnose them:
1. Selection chrome is positioned in the parent document from measurements taken
   inside a zoomed iframe, so error scales with zoom — this is the "menu appears
   far from the selected element" report.
2. Two `useEditorStore` selectors scan every node of every page on **every**
   store change (`PropertiesPanelBody.tsx` `sharedTextOriginCount`,
   `InPlaceInspector.tsx` `findNodeById`).

### standing-04 — `public/runtime/react.js` already solves React identity sharing
The plugin host ships pre-built ESM shims at `public/runtime/{react,react-dom,
react-jsx-runtime,react-jsx-dev-runtime}.js`. WS-3 of the roadmap needs exactly
this mechanism to make bundled npm components share the admin's React instance.
Reuse it rather than inventing an import-map scheme from scratch.

---

## Archive

*(empty)*
