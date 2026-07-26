# Status — STUDIO-ESIM-IMPORT-PLAN implementation

**As of 2026-07-26.** Companion to `STUDIO-ESIM-IMPORT-PLAN.md`. Work was run
as an orchestrated pipeline of Sonnet 5 workers, one stage-group per worker,
audited between stages.

**Headline: 5 of 7 implementation sections complete, §7 substantially complete
but red, §6 not started. Validation (§8) and documentation (§9) outstanding.**

---

## Where the code is

| | |
|---|---|
| Branch | `feat/alm-figma-killer-studio-shell` |
| Commit | `6213bfc feat(staticEval): implement bounded static evaluator for JSX expressions` |
| Working tree | **Dirty — an unfinished refactor sits on top of that commit.** See "Working tree state" below. |

`6213bfc` is a single squashed commit containing §1–§5 **and** a first cut of
§7. That is not how the work was staged — a worker committed it against
instructions. The commit message describes only §7 and understates its
contents by a wide margin.

### Working tree state — read this before touching anything

The §7 worker was terminated mid-task (monthly spend limit) while splitting an
812-line `staticEval.ts` that busted the repo's 700-line module ceiling. The
split is **finished and working**, but uncommitted:

```
 M src/core/page-parser/parsePageFile.ts
 M src/core/page-parser/staticEval.ts        812 → 72 lines (now a barrel)
?? src/core/page-parser/staticEvalCore.ts    360 lines
?? src/core/page-parser/staticEvalCalls.ts   348 lines
?? src/core/page-parser/resolutionLock.ts     71 lines
?? src/core/page-parser/__tests__/staticEval.test.ts
```

The working tree is **healthier than the commit** — it is what brings
`module-size-budgets` back to green. Do not discard it. It needs a commit.

---

## Section-by-section

| § | Scope | State |
|---|---|---|
| **§1** | Configurable page source (`pagesDir` meta, `.jsx` discovery) | ✅ Complete |
| **§2** | Local-component inlining (2a→2d) | ✅ Complete |
| **§3** | `<svg>` raw capture → `base.svg` | ✅ Complete |
| **§4** | Context-aware element→module resolution | ✅ Complete |
| **§5** | Local asset serving | ✅ Complete |
| **§6** | CSS imports → StyleRules + classIds | ❌ **Not started** |
| **§7** | Static value resolution (tiers A→B→C) | ⚠️ **Tiers A + C green, Tier B red** |
| **§8** | Validation on eSIM | ⚠️ Partial — static only, never dogfooded in a browser |
| **§9** | Verification gate + docs | ⚠️ Gates run; **`docs/` never written** |

### §7 — the precise gap

`bun test src/core/page-parser/__tests__/staticEval.test.ts` → **24 pass / 2 fail**.
Both failures are Tier B, and both trace to the same root cause: §7.3 step 3,
locating `<Ctx.Provider value={…}>` and evaluating its `value` expression.

```
staticEval — Tier B > traces a single provider through useContext…
staticEval — Tier B > resolves the preferredKey branch when configured

  expected: { kind: "literal", value: "Hi Muhammad",
              note: 'dynamic key not statically known — showing the "en" branch' }
  received: { kind: "unresolved", reason: '"value" is not a statically resolvable binding' }
```

The second failure is a cascade, not an independent bug — §7.4's
`preferredKey` branch selection can only run once provider tracing hands it the
dictionary.

**Consequence:** the eSIM corpus's copy comes from `useLanguage()` →
`useContext` → `translations[lang]`, which is exactly the Tier B path. So
§7.9's acceptance criterion — real English copy (`"Hi Muhammad"`,
`"Your booking is confirmed"`, `"Almosafer Points"`) rendering on canvas — is
**not met yet**, even though Tier A and Tier C both work. §7 is the
load-bearing section for whether an import *looks* like the app, and this is
the last mile of it.

---

## Gate status

Measured on the working tree.

| Gate | Result |
|---|---|
| `bun test server/handlers/__tests__` | **129 pass / 0 fail** |
| `bun test src/core/page-parser src/core/studio-sync` | **84 pass / 2 fail** (the two §7 Tier B above) |
| `module-size-budgets`, `boundary-validation`, `no-core-barrel-deep-imports` | **14 pass / 0 fail** |
| `bun run build` (`tsc -b && vite build`) | Passed as of the §2/split audit; **not re-run since the §7 split** |
| `bun test` (full suite) | **Never completed** — takes >10 min; deferred to the final gate that was never reached |

### Pre-existing failures — not caused by this work

`bun test src/__tests__/architecture` on the **pristine** `cd1dd15` commit is
**464 pass / 10 fail**. Verified by stashing. Those 10 (bundle-size budgets,
CodeMirror lazy-load, icon wrapper, publish bus, error boundary, keybindings,
plugin bootstrap freshness, two vendor-icon freshness gates) are inherited and
out of scope.

**Two regressions this pipeline *did* introduce were caught and fixed:**

1. `server/handlers/studio.ts` grew to 855 lines against a 700 ceiling → split
   into four modules (below).
2. `no-circular-dependencies` began timing out. Investigated: **there is no
   actual cycle** — `madge` needs ~12.6s for the ~2,485-file graph and the test
   budget was 15s. Raised to 60s with a comment explaining it is a hang guard,
   not a perf assertion.

A worker initially reported both as "pre-existing". They were not — it had
compared against an already-modified tree rather than `HEAD`. Worth knowing
when reading the other worker reports in this pipeline.

---

## What was built

### New modules

```
server/handlers/studioAsset.ts          86   asset route + traversal guards
server/handlers/studioWriteback.ts     130   StudioEdit, applyStudioEdit, composite-id guards
server/handlers/studioPageLoad.ts      239   parse → inline → convert pipeline
src/core/page-parser/inlineLocalComponents.ts  598   §2
src/core/page-parser/staticEvalCore.ts  360   §7 tiers A/B
src/core/page-parser/staticEvalCalls.ts 348   §7 tier C
src/core/page-parser/resolutionLock.ts   71   §7.6 derived-value locking
```

`server/handlers/studio.ts` went 855 → 503 lines and is now pure HTTP routing,
which is what its own module doc always said it should be.

### Corpus measurements (`studio-workspace/esim-journey/`, 15 screens)

§2 inlining, parse + inline wall clock:

| | nodes | time |
|---|---|---|
| Before | 337 | 38.4 ms |
| After | 1066 | 102.3 ms |

No screen hit `maxDepth` (6) or `maxNodes` (4000); deepest real chain is 4.
After a fix for same-file non-exported helper components, **every remaining
un-inlined `kind:'component'` node across the corpus is a genuine
`@alm-design/design-system` package component** — i.e. correctly left alone,
since those already have real `alm.*` renderers per §0.7.

§7 timings were never measured — the worker died before §7.9.

---

## Deliberate deviations from the plan

Each was justified at the time; flagging them so they are not mistaken for drift.

1. **`INLINE_ID_SEPARATOR` is mirrored, not imported, in `fsCodemodAdapter.ts`.**
   §2.4 says to export it from one place so both sides agree. Importing
   `@core/page-parser` into browser code pulled ts-morph/typescript into the
   client bundle and blew the `AdminCanvasLayout` chunk from ~700 KB to
   **6.9 MB** (measured, not guessed). `fsCodemodAdapter.ts` already mirrors
   `ComponentSource` for exactly this reason and documents it. **Risk: the two
   constants can silently drift — there is no gate test keeping them in sync.
   Worth adding one.**
2. **`renameProjectDisplayName` added** (not in the plan). §1.1's type change
   made the existing `writeProjectMeta(dir, { displayName })` on rename silently
   erase an imported project's `pagesDir`. Fixed at the source.
3. **`projectDisplayName` now uses `basename`.** It split on `/`, so on Windows
   every project's display name came back as its full absolute path. This was a
   pre-existing bug causing 4 red tests; fixed to de-noise the gate for later
   workers. Slightly outside plan scope.
4. **`no-circular-dependencies` timeout 15s → 60s**, per above.

---

## Known limitations already accepted

- **`{children}` splicing** (§2c) does not handle the case where spliced
  content is itself an intermediate inlined id from a deeper nesting level —
  it would produce a dangling reference. Does not occur in the corpus;
  documented in the module rather than solved with general bookkeeping.
- **Dynamic-SVG detection is `text.includes('{')`**, per §3.3 as written. A
  static SVG containing a literal `{` (e.g. an embedded `<style>` block) is a
  false positive and renders as an empty placeholder. Conservative and honest,
  but broader than strictly necessary.
- Everything in the plan's own "Expected residual gaps on eSIM" list (§8) still
  applies: no loop expansion (Tier D banned), multi-stage screens collapse to
  the least-nested `return`, computed `className` keeps only its static prefix,
  only the `previewLocale` branch renders, and all §7-resolved copy is
  read-only on canvas by design.

---

## To finish

In dependency order:

1. **Commit the working tree.** It is the fix for the module-size gate.
2. **Close §7 Tier B** — provider tracing (§7.3 step 3). Two tests, one root
   cause. This unblocks §7.9's acceptance and is what makes imported screens
   show real copy.
3. **Measure §7 load time** against the 102.3 ms §2 baseline (§7.9 requires it;
   the memoized module-namespace cache is the thing being verified).
4. **§6 — CSS imports → StyleRules + classIds.** Entirely unstarted. Note §6.2's
   guidance to inject a `sheetConstructor` into `cssToStyleRules` rather than
   mutating `globalThis` in the Bun server, and §6.5's warning that
   `fsCodemodAdapter.test.ts`'s mock must gain the new required fields or all
   its tests fail on a TypeBox error.
5. **§8 — browser validation.** Nothing has been dogfooded in a real browser;
   per standing instruction, workers ran static gates only. The corpus is
   staged and ready at `studio-workspace/esim-journey/`.
6. **§9 — docs.** `docs/features/` has **no** Studio-import page. Needs the
   pages-dir override, inlining semantics + the lock rule, the asset route, the
   one-way CSS boundary (§6.6 — CSS edits are *not* written back and are lost on
   reload; the plan is explicit this must not be left for users to discover),
   and static value resolution.
7. **Run the full `bun test` + `bun run build` + `bun run lint` gate** (§9). It
   has never been run to completion.

---

## Validation corpus

`studio-workspace/esim-journey/` — a copy of
`github.com/maherfayad-stack/eSIM` → `journey-screens/`, with a hand-written
`.studio/meta.json` (`pagesDir: "src/screens"`, `previewLocale: "en"`) per §8
step 1.

It is **git-excluded** via `.git/info/exclude` (a local-only exclusion, so it
will not follow a clone). It is read-only input: never commit it, never edit it.
