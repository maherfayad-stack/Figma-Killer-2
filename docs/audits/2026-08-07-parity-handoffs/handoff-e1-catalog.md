# E1 — The component catalog — handoff

## Scope (files touched)

- `server/handlers/studio/packageManifest.ts` — trimmed to the package-specific
  concerns (entry resolution, `createPackageProject`, `manifestFromEntry`,
  `buildPackageManifest`). `classifyPropType`/`resolvePropsTypeNode`/
  `extractPropsFromMembers`/`buildComponentSpec`/`resolveTypeNodeToMembers`/
  `findNamedTypeMembers`/`isComponentCandidate`/`pascalCaseFromFileBase`/`toPosix`
  **moved**, not copied, to `componentSpecExtract.ts`.
- `server/handlers/studio/componentSpecExtract.ts` — **new**. The shared,
  package-agnostic extraction module: everything above, plus K3 (named
  union-alias resolution) and `extractLocalComponentCatalog` (the new
  whole-workspace local-component walk) + `LocalComponentSpecSchema`.
- `server/handlers/studio/components.ts` — **new**. `GET
  /admin/api/studio/components` sub-router.
- `server/handlers/studio.ts` — added one import + one entry to
  `STUDIO_SUB_ROUTERS` (`tryServeStudioComponents`) + one doc-comment entry.
  Did **not** touch the shared `if (pathname === …)` route table — that's the
  actual collision-prone surface `standing-05` warns about; the sub-router
  array is the designed low-collision seam every other work order already
  registers through the same way.
- Tests: `server/handlers/__tests__/packageManifest.test.ts` (updated —
  `classifyPropType` import moved + new signature `(project, name, typeNode)`;
  added a `K3: named union type alias` describe block), `server/handlers/
  __tests__/componentSpecExtract.test.ts` (new — local-catalog walk),
  `server/handlers/__tests__/components.test.ts` (new — the HTTP route).

Nothing under `src/admin/pages/site/**`, `src/core/ast-codemods/**`, or
`server/ai/**` was touched.

## The published contract — `LocalComponentSpec`

```ts
// server/handlers/studio/componentSpecExtract.ts
export const LocalComponentSpecSchema = Type.Object({
  name: Type.String(),          // display name (recovered from file base for an anonymous default export)
  file: Type.String(),          // POSIX path relative to the WORKSPACE ROOT (not a package root)
  exportName: Type.String(),    // 'default' for a default export, else === name
  isDefaultExport: Type.Boolean(),
  props: Type.Array(PropSpecSchema),  // PropSpecSchema/PropKindSchema unchanged, from packageManifestSchema.ts
})
export type LocalComponentSpec = Static<typeof LocalComponentSpecSchema>
```

`PropKind` (unchanged, `packageManifestSchema.ts`): `string | number | boolean
| enum{values} | color | image | node | handler | unknown`. `handler`-kind
props are dropped before reaching a spec, never stubbed (unchanged rule).

Endpoint: `GET /admin/api/studio/components?dir=<abs>` → `{ components:
LocalComponentSpec[] }`, sorted by `file` then `name` then `exportName`.
Never throws; an empty/missing project yields `{ components: [] }`.

## K3 — what now resolves vs. still `unknown`

Extended `classifyPropType`'s `TypeReference` case
(`resolveNamedUnionAlias`, `componentSpecExtract.ts`):

**Now resolves to `enum`:**
- A named union alias in the SAME file (`type ButtonVariant = 'a'|'b'`, prop
  `variant?: ButtonVariant`).
- A named union alias in a DIFFERENT file in the same `Project` — same
  unimported, by-name scan `findNamedTypeMembers` already used for the
  object-shape path; no `import` statement required to be in scope.
- An alias-to-alias chain (`type A = B; type B = 'x'|'y'`), bounded to depth 3
  (same bound `findNamedTypeMembers` already uses).

**Still `unknown` (honest, not a guess):**
- A generic type reference this extractor doesn't unwrap (`Record<string,
  string>`, `Array<Foo>`, any reference with type arguments).
- A named alias whose body is NOT a union (`type Id = string`) — no scalar
  re-classification was added; scope was kept to exactly what the work order
  named (a union of string literals), not silently widened.
- A union alias with a non-literal member (`type Mixed = 'a' | number`) —
  never emits a partial/guessed enum.
- Anything requiring the type checker (never used anywhere in this module —
  still fully syntactic, per the module's own long-standing invariant).

Perf note on K3: the alias-name → type-node index (`typeAliasIndex`) is
memoized per `ts-morph Project` via a `WeakMap`, built by one full scan on
first use and reused for every subsequent `TypeReference` prop in that
`Project`. Unmemoized, K3 would cost O(props × files) on the whole-workspace
local catalog (which scans every file, unlike `packageManifest.ts`'s narrower
per-package `Project`) — this keeps it O(files) amortized.

## Local-catalog walk — design decision, stated explicitly

`extractLocalComponentCatalog` deliberately does **not** use
`getExportedDeclarations()`'s export-graph walk (what `componentSources.ts`'s
`resolveExportedDeclaration` and `packageManifest.ts`'s `manifestFromEntry`
both use) — that walk is barrel-aware but its cost is paid once per **file**
here (a catalog wants every component in the workspace, whether or not any
page currently imports it), which would be materially more expensive than
paying it once per **named import** the way `resolveExportedDeclaration`
does today. Instead it scans each file's own top-level declarations directly
(`getFunctions()`/`getClasses()`/an exported `VariableStatement`'s
declarations, plus a separate `export default <identifier>` lookup for a
component declared earlier in the file and exported by reference). A pure
re-export barrel (`export { Card } from './Card'`) creates no declaration
node in the barrel file at all, so this naturally attributes every component
to the file that actually declares it — no double-counting, and no barrel
walk needed. Tested explicitly (`does NOT double-count a component through a
barrel re-export`).

**Deliberately not built:** pages are not excluded from the catalog (a page
file's own default-exported function is a component like any other — no
special-casing was added, and nothing in the work order asked for it).
Untyped JS-only props stay `props: []` (not a param-name-only fallback) —
matches the existing, accepted behavior of `packageManifest.ts`'s own `.tsx`
source-fallback tier; the work order's rule 4 note about `buildParamBindings`
describes an EXISTING fallback used by the detach/swap flow, not a new
requirement for this endpoint.

## Cost — measured

The real `studio-workspace/maherfayad-stack-eSIM` corpus this work order asks
about is **not present in this sandbox** (only `studio-workspace/
__canonical-fixture`, `untitled`, `untitled-2` exist here, 0–8 files each) —
could not measure against it directly. Measured instead:

- Tiny fixtures (7–8 files): `createWorkspaceProject` ~8–58ms,
  `extractLocalComponentCatalog` ~371–373ms. The walk cost is dominated by a
  largely FIXED overhead (not visibly file-count-dependent at this scale) —
  almost certainly TypeScript's lazy Program/binder pass, triggered the first
  time `isExported()`/`isDefaultExport()` (`ExportableNode` mixin) is called
  on any declaration in a freshly-built `Project`.
- Synthetic 300-file workspace (300 components, each with its own union-alias
  prop — built specifically to stress K3): `createWorkspaceProject` ~268ms,
  first `extractLocalComponentCatalog` ~488ms (≈755ms total, cold). A SECOND
  walk on the SAME already-bound `Project` (simulating in-process reuse, not
  a second HTTP request): ~59ms — confirming the ~400ms+ is a one-time
  binder cost, and the walk itself scales cheaply once that's paid.

**No cross-request caching was added.** This matches the existing, accepted
precedent: `loadStudioPages` (the `/load` route) also calls
`createWorkspaceProject(dir)` fresh on every request with no Project-level
cache across requests (`pageParseCache.ts` caches per-page PARSE results, not
the `Project` itself). Adding cross-request Project caching (keyed by
mtime/file-set fingerprint, `.studio/cache`-style) is a real, bounded
follow-up if this endpoint's real-world call frequency proves it matters —
flagging it here rather than either building unrequested infrastructure or
silently leaving it unmeasured. Given the ~750ms ballpark for a
few-hundred-file project, an on-demand "open the Swap picker" or "open the
project guide" caller is fine; a caller in a hot per-keystroke path would not
be.

## Reachability — proven, not assumed

Per the integration-gap protocol: confirmed the route is dispatched through
the REAL top-level `tryServeStudio` (not just the sub-router function called
directly in isolation) — built a fixture project under `studio-workspace/`,
called `tryServeStudio(req, undefined, url, pathname)` with
`/admin/api/studio/components?dir=<fixture>`, got `200` with a correctly
K3-classified `enum` prop back. See `components.test.ts` for the same proof
as a permanent test (`tryServeStudioComponents` called directly + via
`studio.test.ts`'s existing route-table coverage, which still passes
unchanged after the `STUDIO_SUB_ROUTERS` addition).

**No consumer wires this endpoint yet** — by design, per the work order
("None of the three consumers land in this work order"). Named explicitly, so
this isn't mistaken for "shipped and working":
- Swap picker (`InstanceCallSiteView.tsx`'s `openSwapPicker`) still scans only
  the loaded board.
- `controlForCallSiteValue` still guesses a control from the runtime value's
  type instead of a fetched `PropKind`.
- Nothing yet offers "add a prop the call site doesn't pass" using this
  catalog.

## Verification run

```
bun test server/handlers/__tests__/packageManifest.test.ts \
         server/handlers/__tests__/componentSpecExtract.test.ts \
         server/handlers/__tests__/components.test.ts
# 33 pass, 0 fail

bun test server/handlers src/core/page-parser src/core/ast-codemods src/__tests__/studio
# 1356 pass, 7 fail, 1 error — all 8 pre-existing and unrelated to this change:
#   - projectGuide.test.ts ×5 (Windows path separator: '\' vs '/' in an
#     asserted array — not a file this change touches)
#   - projectMcpApprovals.test.ts (missing module './agentRosterMcpTools' —
#     unrelated in-flight work from another session)
#   - projectSeed.test.ts (Windows path: 'C:\tmp\custom-seed' vs '/tmp/custom-seed')
#   - remoteAssetFetch.test.ts / styleCompile.test.ts (subprocess/mock
#     plumbing issues, unrelated files)
```

Did **not** run `bun run build` / `bun run lint` per explicit instruction
(concurrent siblings; orchestrator runs the full gate once).

## For studio-scribe

`docs/features/studio-import.md` doesn't cover this endpoint yet (it's a new
Track E1 surface, not part of the import/writeback pipeline it documents) —
recommend a short new section once a consumer actually calls it, rather than
documenting an unconsumed endpoint prematurely. One landmine worth recording
regardless: **`ExportableNode.isExported()`/`isDefaultExport()` triggers a
full TypeScript Program/binder pass on first call on a freshly-built
`Project`**, even though `packageManifest.ts`'s whole module doc insists on
staying syntactic-only / never touching the checker. This module still never
calls `type.getType()` or asks the checker to RESOLVE a type — but
`isExported()`/`isDefaultExport()` are apparently NOT free syntactic checks
the way `getFunctions()`/`getClasses()`/`getTypeNode()` are; they cost a
few-hundred-ms fixed overhead the first time either is called on a `Project`
this size. Not a correctness problem (still 100% syntactic in what it
reads), but a real, measured perf landmine for anyone adding an
`isExported()`/`isDefaultExport()` call to a hot path — worth a line in
`studio-import.md`'s guard/cost section since nothing there currently
documents it.
