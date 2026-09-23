# E2.1 — `extractSubtreeToComponent.ts` — handoff

## Scope (files touched, all under my ownership)

New:
- `src/core/ast-codemods/extractSubtreeToComponent.ts` — the codemod itself.
- `src/core/ast-codemods/subtreeFreeVariables.ts` — free-variable analysis (`analyzeFreeVariables`).
- `src/core/ast-codemods/importReconcile.ts` — shared import-mirroring (`addReconciledImports`, `removeImportIfLastUsage`, `relativeSpecifier`, `topLevelBindingNames`).
- `src/core/ast-codemods/__tests__/extractSubtreeToComponent.test.ts` — 21 tests.

Edited:
- `src/core/page-tree/sourceStructure.ts` — exported `refusePlacement` (was private), extended its doc comment to state it is now a published contract for E2.1/D2/F2. **No behavior change** — `refuseStructuralEdit` calls the same function it always did.
- `src/core/page-tree/index.ts` — barrel now re-exports `refusePlacement`.
- `src/core/ast-codemods/index.ts` — barrel now exports the new module's public API.
- `src/core/ast-codemods/detachComponent.ts` — removed its private `relativeSpecifier`/`addReconciledImports`/`removeImportIfLastUsage` (moved to `importReconcile.ts`, same call sites, same arg order, no behavior change). 517 → 398 lines.
- `src/core/ast-codemods/extractComponentCopy.ts` — replaced its private `importSpecifierFor` with the shared `relativeSpecifier`; replaced `repointImport`'s inline "still used" check with the shared `removeImportIfLastUsage` (strictly more thorough — also catches a bare-identifier reference, not just a JSX tag). 173 → 146 lines.
- `src/core/ast-codemods/swapComponentInstance.ts` — same dedup: removed its own near-duplicate `topLevelBindingNames`/`relativeSpecifier`/`removeImportIfUnused` (that file had an explicit comment admitting the duplication was "kept local" — fixed it while I was in the neighborhood, since CLAUDE.md forbids leaving duplication once found and I was already restructuring this exact area). 250 → 202 lines. Behavior unchanged; `removeImportIfLastUsage` is a superset check of the old `removeImportIfUnused` (also drops a bare-identifier-only reference, not just a JSX tag) so this is strictly more correct, not just a rename.

All 5 new/changed ast-codemods files are 146–398 lines — nowhere close to the 700-line `module-size-budgets` ceiling. I did not touch any of the 2 modules that gate currently flags (`DepsSection.tsx`, `fsCodemodAdapter.ts`) — not mine, left alone.

## The published contract: `refusePlacement`

```ts
// @core/page-tree
export function refusePlacement(
  node: { id: string; lockReason?: string },
  gesture: string,
): StructuralRefusal | null   // { reason: StructuralRefusalReason; message: string } | null
```

- Pure, string-based. No AST, no HTTP, no access to a loaded page tree.
- Answers exactly 4 of `StructuralRefusalReason`'s 12 members: `list-row` (no
  writable source location — `.map` iteration suffix or non-source id),
  `shared-component` (`~`-composite/inlined id), `route-chrome` (filename is
  `layout.tsx`/`template.tsx` at any depth — **derivable from the id alone,
  no parse needed**), `code-placed` (`node.lockReason` is truthy — this is
  the one that needs the CALLER to supply it; nothing here can re-derive a
  parser's own structural verdict).
- `gesture` is a past-tense verb spliced into all 4 messages (`"Extracted a
  row of a list…"`). Reuse it verbatim rather than inventing new wording per
  verb — that's the whole point of lifting it.
- **What a caller must supply to get all 4 answers**: the node's OWN
  (possibly composite, possibly `#N`-suffixed) studio node id, and
  `lockReason` from the loaded `ParsedNode`/`PageNode` (structurally
  identical to what `structuralSourceEdits.ts` already does for
  reorder/delete via `refuseStructuralEdit({kind, node})` — `node` there
  IS a tree node with `.id`/`.lockReason`, so the SAME object can be handed
  to `refusePlacement` directly). **Do not go through `refuseStructuralEdit`**
  for a NEW gesture kind (extract, promote, …) — its `kind` switch only knows
  `reorder|reparent|delete|insert|duplicate|wrap` and will throw hitting an
  unhandled case for anything else. Call `refusePlacement` directly with your
  own gesture-appropriate verb string.
- D2 and F2: this is now the ONE place these 4 reasons/messages live. Don't
  re-derive `list-row`/`shared-component`/`route-chrome`/`code-placed`
  yourselves — ask this function. If your verb needs a 5th/6th reason (like
  my `spread-props`/`name-taken`), extend your OWN codemod's refusal union
  the way I did (`YourReason = StructuralRefusalReason | 'your-new-reason'`),
  don't touch `StructuralRefusalReason` itself unless the new reason is
  ALSO meaningful for reorder/delete/insert.

## The full refusal vocabulary `extractSubtreeToComponent` produces

Checked in this order, all BEFORE free-variable analysis or any write:

1. **`list-row`** — via `refusePlacement`, either from a caller-supplied
   `nodeId` with no writable source location, OR (when no `nodeId` was
   supplied) an AST-only safety net: `root` sits inside a `.map()` callback.
   The safety net re-asks `refusePlacement` with a synthetic
   `${id}${LOOP_ID_SEPARATOR}0` id instead of hand-writing the message a
   second time, so the wording never drifts from the real thing.
2. **`shared-component`** — via `refusePlacement`, only when the caller
   supplies a `~`-composite `nodeId`. **Not independently AST-derivable** —
   this codemod has no way to know, from bare `file/line/col`, that the
   element it's looking at came from an INLINED component expansion. A
   caller with no parsed tree gets no protection here; document this
   loudly to whoever wires the UI (see "Integration gap" below).
3. **`route-chrome`** — via `refusePlacement`, filename-derivable, works
   even with no caller-supplied `nodeId` (built from the real `file` path).
4. **`code-placed`** — via `refusePlacement`, only when the caller supplies
   `lockReason`. Same caveat as `shared-component`.
5. **`spread-props`** — AST-only, always checked regardless of caller info:
   any `JsxSpreadAttribute` anywhere in the subtree (`{...rest}` on the root
   OR any nested element). Refuses because the new component's `interface`
   would have to assert a shape this codemod cannot enumerate.
6. **`name-taken`** — checked last (the only one touching the filesystem/
   workspace scan): (a) `<dir>/<ComponentName>.tsx` already exists on disk,
   (b) the name collides with an import/declaration already in the PAGE
   FILE's own top-level scope, (c) `existingComponentNames` (if the caller
   passed one) contains it, or — fallback when no catalog was passed — a
   lightweight scan of the whole workspace `Project` for an existing
   function/class/variable declared under that exact name.

Also: **`extractSubtreeToComponent` throws** (does not return a refusal) for
a `componentName` that isn't `^[A-Z][A-Za-z0-9]*$` — that's a caller-contract
violation (the picker UI's job to prevent), not a legitimate refusal a user
needs explained, matching `findJsxElementAtLocationOrThrow`'s own precedent
of throwing for a bad `(file,line,col)`.

## Free-variable analysis — what's handled vs. what's refused/left as a gap

Full model and rationale is in `subtreeFreeVariables.ts`'s module doc. Summary:

- **Nothing inside the moved subtree is ever rewritten.** `{user.name}`,
  `{cond ? a : b}`, a template literal — all move byte-for-byte via
  `root.getText()`. This is why the round-trip tests pass trivially: there
  is no substitution step to get wrong.
- **Only the ROOT identifier of each reference matters.** For `user.name`,
  only `user` is classified; `.name` is excluded (it's a property-access
  name, not a binding reference) via a position-based exclusion check
  (`isReferenceIdentifier`), not text splitting.
- **JSX tag names are classified separately** (`collectTagNameOpenings` +
  the `isComponentTag` flag), because a dotted tag (`<Foo.Bar/>`) needs its
  ROOT segment (`Foo`) treated as the reference and `.Bar` excluded — the
  general identifier walk explicitly excludes anything inside a tag-name
  node's own range (`isWithinTagName`) so tag names are never double-counted
  by the general walk.
- **Module-scope names (import, or a page-level top-level const/fn/class)**
  become `kind: 'import'` — mirrored into the new file via
  `addReconciledImports`, and the PAGE file's own import is dropped via
  `removeImportIfLastUsage` if the extracted subtree was its last usage.
- **Everything else** (destructured props, hook results, function-body
  consts) becomes `kind: 'prop'`, forwarded at the call site as `name={name}`
  — the plain identifier, never an evaluated value (trap #4).
- **A name bound INSIDE the subtree itself** (a `.map`/arrow callback's own
  parameter, a `const` in a nested block) is excluded entirely via
  `isLocallyBound`, which walks from the reference up to `root` checking
  every intermediate function-parameter/block/catch-clause scope — NOT via
  the type checker, purely syntactic (consistent with this module's
  existing "never the type checker" convention).
- **A handful of well-known JS globals** (`Math`, `String`, `console`, …)
  are whitelisted and get neither an import nor a prop.
- **Every generated prop is typed `unknown`**, except a JSX-tag-only
  reference, typed `ComponentType` (with a conditionally-added
  `import type { ComponentType } from 'react'`) — there is no type checker
  in this pipeline to infer anything better, and `unknown` is the honest
  answer, not a guessed one.
- **`freeVariables: FreeVariable[]`** is returned on success, in
  first-reference order, as the ONLY record of what was inferred — see
  "Integration gap" below for who is expected to show it for correction.

**What this does NOT attempt** (documented gaps, not silent failures):
- No attempt to give a resolved-value-shaped type (e.g. inferring
  `user: { name: string }` from usage) — would need the type checker, which
  this module's siblings (`detachComponent.ts`, `componentSpecExtract.ts`)
  deliberately avoid too.
- No de-duplication of two DIFFERENT free expressions that happen to want
  the same synthesized name — doesn't arise in this design since every prop
  name IS the original identifier's own name (never synthesized), so a
  collision here would mean the SAME name is already used twice for two
  different bindings in the ORIGINAL source, which can't happen (JS scoping
  rules already prevent it).
- **JS-only projects get a `.tsx` file regardless of the source file's own
  extension** (`.jsx`/`.js`). Deliberate, matching the work order's literal
  "emit plain TSX including the `interface`" instruction, but it IS a real
  limitation: a pure-JS (no TypeScript at all) project's toolchain may not
  consume the new file. Not detected/refused — that would need a probe-level
  "is this project TypeScript-capable" signal this module doesn't have.
  Flag for `studio-scribe` to add to `docs/features/studio-import.md`'s
  "What still does not import"-style honest-gap list once the UI entry
  point exists.

## `importReconcile.ts` API (new, shared by 3 callers now)

```ts
relativeSpecifier(fromFileAbs: string, toFileAbs: string): string
topLevelBindingNames(sourceFile: SourceFile): Set<string>
addReconciledImports(destinationFile: SourceFile, originFile: SourceFile, identifiers: ReadonlySet<string>): void
removeImportIfLastUsage(sourceFile: SourceFile, localName: string): void
```

- `addReconciledImports(destination, origin, names)`: for each name, if
  `destination` already has it in top-level scope, skip (trusted as-is —
  documented gap, unchanged from `detachComponent.ts`'s original wording);
  else if `origin` imports it, mirror an equivalent import into
  `destination` (following the import to whatever it names, re-resolving a
  relative specifier against `destination`'s own location); else if `origin`
  declares it directly at its own top level, import it FROM `origin`; else
  (a global, or untraceable) leave it alone.
- **Direction is symmetric and caller-chosen**: `detachComponent.ts` calls
  it `(pageFile, componentFile, …)` (component → page); I call it
  `(newComponentFile, pageFile, …)` (page → new component). Same function,
  reversed roles — this is exactly why extracting it was worth doing.
- `removeImportIfLastUsage(file, name)`: drops `name`'s import if no JSX tag
  or bare-identifier reference to it remains ANYWHERE in `file`. Used by
  `detachComponent.ts` (drop the inlined component's own import),
  `extractSubtreeToComponent.ts` (drop a module-scope name's import from the
  PAGE once the subtree that used it has moved out), and now
  `extractComponentCopy.ts`/`swapComponentInstance.ts` too (both previously
  had their own narrower, JSX-tag-only version).

## Integration gap (per the protocol — I own the codemod, nobody owns the wiring yet)

**Nothing calls `extractSubtreeToComponent` yet.** No store action, no HTTP
handler, no MCP tool. This wave's task was explicitly "the foundation" — the
codemod — not the UI entry point (owned by other agents this wave, none of
whom were listed as touching this). Whoever builds that entry point (a
future `server/handlers/studio/extractSubtree.ts`, modeled closely on the
existing `server/handlers/studio/extractComponent.ts` — read that file, it's
the closest real precedent) MUST:

1. Decode the incoming composite `nodeId` via `studioEditLocation` (same as
   `extractComponent.ts` does) to get `{ rel, line, col }` for the
   `file`/`line`/`col` params — **but ALSO pass the ORIGINAL, un-split
   `nodeId` through to `extractSubtreeToComponent`'s own `nodeId` param**
   (do NOT reuse `target.rel` there — that's already tail-split and would
   silently defeat the `shared-component` check, which needs to see the `~`).
2. Look up the node's `lockReason` from the currently-loaded page tree (the
   live site document the studio load pipeline already holds — this is
   server-state the HTTP handler will need access to that
   `extractComponent.ts` doesn't need, because that codemod's target is
   always an ALREADY-vetted `studio.instance` call site).
3. Call `GET`-equivalent `extractLocalComponentCatalog` (already landed,
   `server/handlers/studio/componentSpecExtract.ts`) and pass its names as
   `existingComponentNames` for the strongest `name-taken` check — my
   fallback scan (own-Project, existence-only) is honest but narrower.
4. Surface `result.freeVariables` back to the client for the "each
   inference shown for correction, never silently applied" requirement —
   this codemod computes and returns the full inference but does NOT pause
   for review itself (no such mechanism exists at this layer). A future
   panel-designer surface renaming a prop or fixing a wrong `ComponentType`
   guess is a review step that has to live above this function, reading
   `freeVariables` as its input.
5. Client-side: on success, reload (this is `shifted: true`, exactly like a
   structural move/delete — every `line:col` id below the call site shifted).

## Tests

`bun test src/core/ast-codemods/__tests__/extractSubtreeToComponent.test.ts`
— 21 tests: basic extraction, no-free-variable case (no interface/param
emitted), 3 verbatim-round-trip tests (`{user.name}`, ternary, template
literal), 5 free-variable-partitioning tests (module import mirrored + drop
when last usage / kept when still used elsewhere / locally-bound `.map`
param excluded / module-scope component import mirrored not forwarded /
body-local component reference forwarded as `ComponentType` prop), 10
refusal tests (spread-props, name-taken ×3 shapes, list-row via AST alone,
list-row via caller nodeId, shared-component via caller nodeId, route-chrome
via filename alone, code-placed via caller lockReason, invalid-name throws),
and 1 "shares nothing with the eSIM corpus" fixture (arrow component, typed
props via `FC<Props>`, no default export).

Also ran and confirmed green (all pre-existing, none touched by me):
`bun test src/core/ast-codemods` (167/167), `bun test src/core/page-tree`
(27/27), `bun test src/core/page-parser src/__tests__/studio` (278/278),
`bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio`
combined (445/445), `server/handlers/studio/__tests__` (61/61).
`./node_modules/.bin/tsc --noEmit -p tsconfig.json` — clean, no errors.

Full architecture suite (`src/core/page-tree src/__tests__/architecture`)
has 5 pre-existing failures, NONE in files I touched: CodeMirror lazy-load
gate, publish.* dispatcher pipeline gate, `main.tsx` path resolution
(Windows path bug in the test itself), keybindings-registry gate, and
`module-size-budgets` flagging `DepsSection.tsx`/`fsCodemodAdapter.ts` (both
pre-existing, explicitly called out as "not yours" in the work order).

## Landmines found that the 578-line doc does not already say

1. **`swapComponentInstance.ts` already carried a documented duplication
   debt** ("Duplicated in spirit from `detachComponent.ts`'s identical
   helper — kept local") for `topLevelBindingNames`/`relativeSpecifier`/
   `removeImportIfUnused`. I paid it down while I was in the neighborhood
   doing the SAME extraction the work order asked for on `detachComponent.ts`.
   Tell `studio-scribe`: if `docs/features/studio-import.md`'s "Detach and
   swap" section or any other doc names these three functions as living in
   `detachComponent.ts`/`swapComponentInstance.ts`, it needs to say
   `importReconcile.ts` now.
2. **`refuseStructuralEdit`'s `kind` union does not — and should not —
   grow to include `'extract'`.** It is a closed switch over the SIX
   existing structural gestures; extending it for extract/promote would
   force it to answer questions (`multi`? an `anchor`?) that make no sense
   for those verbs. The right integration is calling the now-exported
   `refusePlacement` directly, bypassing `refuseStructuralEdit` entirely —
   this is NOT stated anywhere in `sourceStructure.ts`'s pre-existing prose
   because until this change `refusePlacement` had no callers outside that
   one function. I added this to `refusePlacement`'s own doc comment, but
   it's worth restating loudly here since D2/F2 will hit the same fork in
   the road and might reach for `refuseStructuralEdit` by habit.
3. **`ts-morph`'s `ParameterDeclarationStructure.name` and
   `FunctionDeclarationStructure.statements` both accept arbitrary raw TEXT,
   not just a simple identifier/structured statement list** — confirmed by
   reading `ts-morph`'s own printer source
   (`node_modules/ts-morph/dist/ts-morph.js`, `ParameterDeclarationStructurePrinter`).
   This is how I generate `{ user, onSave }: RowProps` as a single parameter
   and `return (\n<jsx/>\n)` as a function body without ts-morph fighting
   the destructuring pattern or the pasted JSX. Not documented anywhere in
   this codebase before now — worth a one-line mention in
   `docs/features/studio-import.md` or wherever ast-codemods conventions are
   recorded, since the NEXT codemod that needs to emit a destructured
   parameter will otherwise reach for something more convoluted.
