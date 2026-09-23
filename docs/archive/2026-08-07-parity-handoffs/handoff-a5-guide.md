# A5 — Design-system knowledge — handoff

## Scope decision: A5 built in full; A2's "real fix" NOT attempted

A5 fit cleanly. A2's real fix (region-scoped compare, cropping a
viewport-height slice instead of resampling a whole tall frame) is a
different subsystem (`frameDiffEngine.ts`/`renderEvidence.ts`, owned by
`canvas-engineer`/`server-engineer` territory, not `server/ai/**` or
`projectGuide.ts`) and, per the work order's own instruction ("if it turns
out to be larger than it looks, do A5 properly... rather than half-building
it"), was left alone entirely rather than half-built. A2's disclosure half
was already shipped by a prior session (per the work order's own note) — no
further A2 work was attempted here.

## What was wrong

`resolveDesignSystemGuide` (`projectGuide.ts:308-312` pre-change) had a
literal `if (!profile.componentPackages.includes(ALM_PACKAGE)) return
undefined` gate. Any project whose installed component package was NOT
`@alm-design/design-system` — including a project with a fully-typed,
real-world design system (MUI, Chakra, Mantine, shadcn, a private kit) —
got **zero** design-system guidance in `CLAUDE.md`: no "## Use `<pkg>` —
always" section, no `.claude/design-system-components.md`, nothing. Yet
`buildPackageManifest` (`packageManifest.ts`) — a fully generic, non-ALM-
specific `.d.ts`/`.tsx` extractor already proven out by `studio_list_components`
— could read real component/prop data for exactly this case.

## The fix

`server/handlers/studio/projectGuide.ts`:

- `resolveDesignSystemGuide(dir, profile)` no longer checks a package name.
  It loops `profile.componentPackages` (every installed component package,
  in profile order) and, per package, tries two tiers, most-specific first:
  1. **Docs tier** (unchanged mechanism) — `buildDesignSystemGuide(pkgDir,
     pkg)` from `designSystemGuide.ts`, reading the package's own
     `CLAUDE.md`/`design.md`. Nothing here is ALM-specific anymore — ALM
     wins this tier because it ships the convention, not because of its
     name. Any future package that ships the same docs convention gets the
     identical treatment for free.
  2. **Catalog tier** (new) — `resolveCatalogDesignSystemGuide(appRootAbs,
     pkg)`, a new function that builds the SAME `DesignSystemGuide` shape
     from `buildPackageManifest`'s real `.d.ts`/`.tsx` extraction (the
     identical `componentSpecExtract.ts` classifier E1 shared this session,
     including K3's named-union-alias enum resolution — so
     `variant?: ButtonVariant`, the shape MUI/Chakra/Mantine/shadcn all use,
     now renders as a real `enum` in the guide too). No `decisionMap` (no
     intent-level "which component" data can be derived from bare types —
     genuinely docs-only knowledge) and no `icons` (an icon directory
     convention is a layout guess, not something a `.d.ts` states) —
     `buildGuide`'s existing fallbacks ("### What exists" name list when no
     decision map; icons section simply omitted when absent) already handle
     both honestly, unchanged.
  Returns the first package that produces content from either tier.
- Deliberately does **not** also try Figma Code Connect in the catalog
  fallback — that would duplicate `componentCatalogTools.ts`'s own
  enum-reduction logic as a second, harder-to-keep-in-sync copy for a
  generation-time file regenerated at most once per turn. Instead:
- **`studio_list_components`/`studio_find_component` are now named in the
  generated guide**, in two places:
  - Right after "Full props for every component: read
    `.claude/design-system-components.md`" (when a `ds` was resolved,
    either tier) — telling the agent the generated file is a snapshot and
    the tools are the live, Code-Connect-inclusive answer.
  - A brand-new fallback section, "## This project has a design system, but
    its API could not be generated", when `profile.componentPackages` is
    non-empty but NEITHER tier produced anything (no docs, no readable
    `.d.ts`/`.tsx`) — the previous behavior here was silently saying
    nothing at all, which reads as "no design system," which is false.

`E1's actual local-workspace catalog` (`extractLocalComponentCatalog`,
`GET /admin/api/studio/components`) was **not** wired into the guide — on
inspection it catalogs components declared IN the project's own source tree
(`createWorkspaceProject` explicitly excludes `node_modules`), which answers
a different question ("what has this project already built") from A5's
actual gap ("what does the installed design-system PACKAGE offer"). The
right generic data source for the latter is `buildPackageManifest`
(`packageManifest.ts`) — the SAME `.d.ts`/`.tsx` extraction `studio_list_
components` already exposes at runtime, sharing E1's `componentSpecExtract
.ts` classifier (including K3) — which is what `resolveCatalogDesignSystemGuide`
uses. Flagging this explicitly since the work order named the other function;
wiring `extractLocalComponentCatalog` itself into `CLAUDE.md` (a "components
already in this codebase, consider reusing" section) is a real, separate
follow-up, not done here — out of scope for "design-system knowledge."

## Fingerprint / cache correctness (`projectGuideManifest.ts`)

Since `resolveDesignSystemGuide`'s output now depends on EVERY declared
component package (not just ALM's two doc files), the regeneration
fingerprint had to widen too, or a non-ALM project's design-system section
would go stale behind the "nothing changed" fast path the first time it
appeared, and every version bump afterward:

- `almPackageDocsStatWitness` → renamed `componentPackageStatWitness`, now
  loops every `componentPackages` entry and stats each package's own
  `package.json` (any real install/upgrade rewrites the whole extracted
  package tree, so this alone catches "this package changed version" — the
  overwhelmingly common case) plus the same two known doc filenames as
  before. Deliberately does **not** stat every file in a package's
  `.d.ts`/`.tsx` export graph (the catalog tier can walk barrels several
  files deep) — that would cost real, unbounded work on every warm chat
  turn, which the module's own "nearly free" warm-path contract forbids.
  Documented as a deliberate, bounded trade-off in the function's own doc
  comment, same shape as its predecessor's.
- `GUIDE_DEFINITION_VERSION` bumped `7 → 8` with a dated rationale entry —
  every existing non-ALM project with an installed, typed component package
  gets one forced full regeneration to pick up the new section(s), matching
  the module's own established precedent (see entries `4`/`5`/`7`).
- `ALM_PACKAGE` constant deleted — after this change it had zero remaining
  consumers (confirmed by repo-wide grep; `src/modules/alm/register.tsx`
  has its own unrelated local constant of the same name).

## Reachability — proven, not assumed

`generateStudioProjectGuide` (the function whose output this change alters)
is called from `server/ai/drivers/claudeCli.ts:335`, inside the real chat
path, **before every `claude` CLI subprocess spawn** — unchanged call site,
already wired, nothing new needed. Confirmed by reading the call site
directly (not just by the module doc's claim). Also called from
`server/handlers/studio/projectRoutes.ts:127` (project-open path). Neither
call site was touched — this change only alters what content the existing,
already-invoked function produces.

## Tests added — `server/handlers/studio/projectGuide.test.ts`

New `describe('generateStudioProjectGuide — design-system knowledge for a
non-ALM package', …)` block, three tests, each building a REAL fixture
package under `node_modules/` (not calling `resolveDesignSystemGuide` in
isolation — asserting on the actual `CLAUDE.md`/`design-system-components.md`
an agent would read):

1. **Typed package, no docs** (`js-ui-kit`, a `.d.ts` with a real
   `'primary' | 'ghost' | 'danger'` union prop) → `CLAUDE.md` gets
   `## Use \`js-ui-kit\` — always`, `### What exists` (no decision map),
   both tool names; `design-system-components.md` gets the real
   `enum ('primary' | 'ghost' | 'danger')` and a required `string` prop —
   real catalog data, not the ALM constant.
2. **Untyped package** (`js-ui-kit-untyped`, satisfies `detectComponent
   Packages`'s built-JS-entry heuristic so it's a real `componentPackages`
   entry, but its only readable source is an untyped `.tsx`) → the
   component is listed by name with **no** prop line at all — asserts the
   "names known, types unknown" honesty requirement directly (a regex
   asserting no `- \`prop\` —` line exists anywhere in the file).
3. **Neither docs nor readable API** (`bundled-only-kit`, JS-entry heuristic
   only, no `.d.ts`/`.tsx` source, no docs) → no
   `design-system-components.md` is written at all, and `CLAUDE.md` gets
   the new "could not be generated" section naming the package and pointing
   at `studio_list_components`.

All three pass. Full-file run: 26 pass / 5 fail (unchanged pre-existing
Windows path-separator failures in the `legacy artefact sweep` describe
block — `.claude/figma.md` vs `.claude\figma.md`, present before this
change, confirmed by re-running on the untouched baseline first).

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json          # clean
./node_modules/.bin/eslint server/handlers/studio/projectGuide.ts \
  server/handlers/studio/projectGuideManifest.ts \
  server/handlers/studio/projectGuide.test.ts               # clean

bun test server/handlers/studio/projectGuide.test.ts
# 26 pass / 5 fail — the 5 are the pre-existing Windows path-separator
# failures in "legacy artefact sweep", unrelated to this change (verified
# present before editing)

bun test server/handlers/__tests__/packageManifest.test.ts \
         server/handlers/__tests__/componentSpecExtract.test.ts \
         server/handlers/__tests__/components.test.ts
# 33 pass / 0 fail (E1's own suite, untouched, still green)

bun test server/handlers/studio
# 231 pass / 7 fail / 1 error — all pre-existing (5 windows-path in
# projectGuide.test.ts, 1 windows-path in projectSeed.test.ts, 2 network-mock
# issues in remoteAssetFetch.test.ts, 1 SVG-dimension issue in
# turnDesignReferences.test.ts — none touch files this change edited)

bun test server/ai/mcp src/__tests__/architecture/agent-tool-surface.test.ts
# 272 pass / 4 fail — all pre-existing bridge/transport timing issues in
# permissionGate.test.ts / server.test.ts / liveReloadPush.test.ts, none in
# files this change touched

bun test src/__tests__/architecture/agent-tool-surface.test.ts \
  src/__tests__/architecture/ai-tools-typebox-only.test.ts \
  src/__tests__/architecture/ai-tool-schema-ssot.test.ts \
  src/__tests__/architecture/ai-tool-input-object.test.ts \
  src/__tests__/architecture/ai-handlers-capability-gated.test.ts \
  src/__tests__/architecture/module-size-budgets.test.ts \
  src/__tests__/architecture/ai-driver-isolation.test.ts \
  src/__tests__/architecture/ai-mcp-connectors-never-leak.test.ts
# 37 pass / 0 fail — all architecture gates green
```

Did **not** run `bun run build` / `bun run lint` — explicit instruction,
concurrent siblings collide on `dist/`/`.tsbuildinfo`.

## Files touched

- `server/handlers/studio/projectGuide.ts` (134 insertions) — generalized
  `resolveDesignSystemGuide`, added `resolveCatalogDesignSystemGuide` +
  `renderPropKind`/`renderCatalogProps`, added the `studio_list_components`/
  `studio_find_component` mentions and the "could not be generated" fallback
  section. 562 lines total (budget: 700).
- `server/handlers/studio/projectGuideManifest.ts` (60 insertions/deletions)
  — generalized the fingerprint's package stat witness, bumped
  `GUIDE_DEFINITION_VERSION` to 8, deleted the now-dead `ALM_PACKAGE`
  export. 364 lines total.
- `server/handlers/studio/projectGuide.test.ts` (141 insertions) — new
  `describe` block, 3 tests, described above.

No other files touched. Did not edit `componentSpecExtract.ts` (read-only
per instructions), did not edit `designSystemGuide.ts` (not owned; its
existing `buildDesignSystemGuide`/`renderComponentReference`/
`renderIconReference`/`ComponentApi`/`DesignSystemGuide` exports were reused
as-is, no changes needed there), did not touch `STATE.md`.
