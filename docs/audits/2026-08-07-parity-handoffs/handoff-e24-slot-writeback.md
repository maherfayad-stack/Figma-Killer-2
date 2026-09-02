# E2.4 — Writeback, two edit kinds — handoff

## Scope (files touched, all under my ownership)

New:
- `src/core/ast-codemods/insertJsxIntoSlotProp.ts` — the `insert-slot` codemod.
- `src/core/ast-codemods/__tests__/insertJsxIntoSlotProp.test.ts` — 15 tests
  (absent/single-element/already-fragment/expression-valued ×4/children
  delegation ×3/not-found/binding-conflict).
- `server/handlers/studioSlotWriteback.ts` — `insert-slot`/`promote-component`
  schemas + `applySlotEdit` dispatch, mirroring `studioStructuralWriteback.ts`'s
  split-module pattern.
- `src/core/page-parser/__tests__/insertJsxIntoSlotPropRoundtrip.test.ts` —
  the required E2.3⇄E2.4 seam proof (see below).

Edited:
- `server/handlers/studioEditSchemas.ts` — folded `SlotEditSchemas` into
  `StudioEditSchema`'s union (now 3rd/last extender this wave, after B1's
  `insert`/`move`/`delete` and B2's `class`; B1b's CSS `create` op was already
  present when I read the file — I did not touch `CssEditSchema` at all).
- `server/handlers/studioWriteback.ts` — dispatch `case 'insert-slot':
  case 'promote-component':`, `isSharedSourceNodeId` (both always shared),
  `dedupeStudioEdits` (both kinds' dedup interaction — see landmine below),
  `StudioEditRefusal['kind']`/`isRefusingEditKind`, `StudioEditApplyOutcome.
  promoteDetail`, `StudioEditBatchResult.promoteDetails` (+ push + return
  wiring). **692/700 lines** — 8 lines of headroom; I am told I am last in
  this wave's `StudioEditSchema` serialization, but flag this margin for
  whoever queues behind me regardless.
- `src/core/ast-codemods/insertJsxElement.ts` — exported 5 previously-private
  helpers (`renderJsxNode`, `validateSubtree`, `collectSubtreeImports`,
  `conflictingBinding`, `indentUnit`) so `insertJsxIntoSlotProp.ts` reuses the
  identical subtree renderer/validator instead of a parallel implementation.
  **Doc-comment-only additions, zero behavior change** (644 → 661 lines,
  61 lines of headroom).
- `src/core/ast-codemods/index.ts` — barrel exports for `insertJsxIntoSlotProp`
  + `InsertJsxNode`/`InsertJsxChildren` (were previously internal-only types).
- `server/handlers/__tests__/studioWriteback.test.ts` — 10 new tests across
  two `describe` blocks (`insert-slot`, `promote-component`).

I did **not** touch `src/core/page-tree/{dnd,sourceStructure,mutations}.ts`,
`src/admin/pages/site/canvas/**`, `src/admin/spotlight/keybindings.ts`,
`src/core/css-codemods/**`, `styleRuleWriteback.ts`, `server/handlers/
studioCss*.ts`, any `PropertiesPanel/**`/`InspectPanel/**`/`uiStateActions.ts`,
`src/core/framework/**`/`tokenExtract*`/`projectTokenIndex.ts`, `src/
__tests__/architecture/**` (read-only, ran the gates), or `server/ai/**`
(read-only, ran its tests to confirm the schema addition doesn't break it).

## The final `StudioEditSchema` shape — all 15 kinds

```
prop | text | style | class | literal | tag | asset | detach | swap
  | move | delete | insert                                    (structural, struct-01/02)
  | insert-slot | promote-component                            (E2.4, this work order)
  | css                                                         (B1/B1b)
```

`insert-slot`/`promote-component` are folded in via `SlotEditSchemas` the
identical way `StructuralEditSchemas`/`CssEditSchema` already are — a plain
array spread into the union, exported from their own module.

### `insert-slot`

```ts
{
  kind: 'insert-slot'
  nodeId: string          // the CALL SITE element's own (plain) location
  propName: string        // a real slot name, or the literal string 'children'
  node: {                 // identical recursive shape to plain `insert`'s InsertNodeSchema
    name: string
    importSpecifier?: string
    props?: Record<string, string | number | boolean>
    children?: string | node[]
  }
  anchorNodeId?: string    // only consulted when propName === 'children'
  position?: 'before' | 'after'
}
```

Dispatches to `insertJsxIntoSlotProp` (`src/core/ast-codemods/
insertJsxIntoSlotProp.ts`) — a **new sibling of `setJsxProp`, not a widening**:
`setJsxProp`'s `buildInitializerText` still only ever writes a scalar. The four
cases from the work order, all implemented and tested:

| Case | Action |
|---|---|
| prop absent | `element.addAttribute({name, initializer: '{<Node/>}' })` — a single JSX value, **no** fragment wrapper (this is the exact pre-E2.3 shape) |
| prop present, single element | `existingAttribute.setInitializer(...)` — wraps BOTH the existing element's own text and the new one in a fragment: `header={<><Existing/><New/></>}` |
| prop **already** a fragment (not explicitly in the work order's table, but the natural extension — a SECOND insert into an already-filled slot) | appends the new element as one more fragment child, proven not to nest fragments (`<>` count stays 1) |
| prop is expression-valued (identifier, call, plain string, valueless shorthand) | refuses **`slot-ambiguous`** — never guesses |
| `propName === 'children'` | delegates the **whole call** to `insertJsxElement` (byte-splice, whole-subtree-per-call) — proven both for a success (reopening a self-closing call site) and for a refusal passing through untranslated (`unsafe-tag`) |

**Not byte-splice, on purpose.** Every other structural codemod in this module
(`insertJsxElement`/`moveJsxElement`/`deleteJsxElement`) promises byte-exact
output because a child-list edit sits among siblings whose formatting must not
move. An ATTRIBUTE value has no such neighbour — same reasoning `setJsxProp`/
`setJsxStyle`/`setJsxClassName` already rely on — so this codemod uses
ts-morph's own structural manipulation (`addAttribute`/`setInitializer`/
`addNamedImport`) throughout for both the attribute and the imports it needs.
The `children` delegation is the one exception, and inherits
`insertJsxElement`'s byte-splice guarantee because IT is doing that write.

**A filled fragment is re-indented, not byte-preserved.** Every existing
fragment child's own JSX text moves verbatim (`.getText()`), but the
whitespace around it is rebuilt at the attribute's own indentation — writing
a new child into a fragment inherently changes it, so there's no "original
formatting" left to protect at the fragment's outer level. Documented loudly
in the module's own doc comment as a deliberate exception to this file's usual
byte-exactness bar.

Refusal vocabulary (`InsertSlotRefusalReason = InsertJsxRefusalReason |
'slot-ambiguous' | 'spread-attribute'`): `not-found`, `unsafe-tag`,
`void-element-children`, `binding-conflict`, `spread-attribute` (defensive,
see landmine below), `slot-ambiguous`, plus — only via the `children`
delegation — `insertJsxElement`'s own `not-a-container`/`not-siblings`/
`stale-source`.

### `promote-component`

```ts
{
  kind: 'promote-component'
  nodeId: string                      // the subtree ROOT's own id, UN-SPLIT
  componentName: string                // caller-chosen, never invented
  existingComponentNames?: string[]    // optional pass-through to the strongest name-taken check
}
```

Dispatches straight to **E2.1's `extractSubtreeToComponent`** — no new codemod
needed, this kind IS the missing caller. One-shot commit, exactly like
`detach`/`swap`: `applyStudioEdit`'s `case 'promote-component'` calls it with
`{...loc, workspaceRoot: dir, componentName: edit.componentName, nodeId:
edit.nodeId, existingComponentNames: edit.existingComponentNames && new
Set(...)}`, translates a refusal to `StudioEditRefusalError`, and on success
returns `promoteDetail: {newFile, componentName, freeVariables}` — surfaced
through `StudioEditBatchResult.promoteDetails` (`(StudioPromoteComponentDetail
& {nodeId})[]`), the identical "extra detail beyond ok/refused" shape
`swapDetails`/`createdStylesheets` already established.

**`nodeId` is passed UN-SPLIT** (never `target.rel`) — this is what lets
`extractSubtreeToComponent`'s own internal `refusePlacement` call still see a
`~` (shared-component) or `#N` (list-row) suffix. Per E2.1's own explicit
integration-gap note.

Refusal vocabulary: `extractSubtreeToComponent`'s own six, reused verbatim —
`list-row`, `shared-component`, `route-chrome`, `code-placed` (all four via
`refusePlacement`, `@core/page-tree`'s published contract), `spread-props`,
`name-taken`.

## Does E2.1's codemod now have a live caller? **YES.**

`extractSubtreeToComponent` is called from exactly one place —
`applyStudioEdit`'s `case 'promote-component'` in `studioWriteback.ts` —
reachable via `POST /admin/api/studio/save` (any `StudioEdit[]` batch
containing a `promote-component` entry) and, **with zero code change**, via
MCP's `studio_apply_edits` tool (`server/ai/mcp/tools/studio/editTools.ts`),
which imports `StudioEditSchema` wholesale and passes it straight to
`applyStudioEditBatch` — the exact same "ride the union for free" mechanism
B2's `class` kind already proved for `setJsxClassName`. Tested end-to-end in
`studioWriteback.test.ts`:
- a plain success (`Card.tsx` minted, call site rewritten to `<Card />`, its
  own import added),
- `freeVariables` surfaced through the batch result (a `{user}` prop forwarded
  as `<Card user={user} />`, never a baked value — trap #4),
- a `name-taken` refusal reported through the batch rather than thrown,
- `isSharedSourceNodeId` always `true` for it (extraction always shifts line
  numbers).

**mcp-tooling landmine (not mine to fix, `server/ai/**` off-limits):**
`editTools.ts`'s hand-written `studio_apply_edits` description string lists
`kind: prop|text|style|class|literal|tag|asset|detach|swap|insert|delete|
move|css` — it does not mention `insert-slot`/`promote-component` (same gap
B2 already flagged for `class`). An agent reading the tool description alone
won't know these two verbs exist yet.

## `applyTreeOperation` — deliberately NOT touched, and NOT the right seam

I read `src/core/page-tree/treeOperations.ts` (D2-owned, did not edit).
`applyTreeOperation` dispatches the **11 named in-memory `NodeTree` mutations**
only (`insertNode`, `moveNode`, …) for `cms.content.tree.mutate` — it never
writes to disk itself; the codemods live entirely outside it. Two independent
pieces of precedent already settled this before I got here:

1. **`detach`/`swap`/`css`/`class` are NOT in `TreeOperation`/
   `applyTreeOperation` either.** B2's own handoff investigated this exact
   question for `class` and concluded: *"`class` lives entirely on the
   SAVE-TIME disk-write side... none of [`prop`/`style`/`text`/`tag`/`asset`/
   `css`] are wired into `applyTreeOperation` either. So 'add it to
   `applyTreeOperation`' would be inventing a new capability outside this
   task's scope."* `insert-slot`/`promote-component` are the identical shape
   — one-shot source writes with named refusals, not in-memory tree
   mutations — so the same reasoning applies without modification.
2. **E2.1's own handoff explicitly warns against forcing `promote-component`
   through the structural gate machinery**: *"`refuseStructuralEdit`'s `kind`
   union does not — and should not — grow to include `'extract'`... The right
   integration is calling the now-exported `refusePlacement` directly,
   bypassing `refuseStructuralEdit` entirely... worth restating loudly here
   since D2/F2 will hit the same fork in the road and might reach for
   `refuseStructuralEdit` by habit."* I hit that exact fork and took the
   documented turn: `promote-component` gates through `refusePlacement`
   **inside `extractSubtreeToComponent` itself** (already built, E2.1's own
   code, unchanged by me) — not through `refuseStructuralEdit`, and not
   through `applyTreeOperation`.

**MCP and plugins already ride the same gate, without `applyTreeOperation`.**
Because both kinds live in `StudioEditSchema`, `studio_apply_edits` gets them
for free (see above) — this IS "plugins/agents ride the same gate" for the
one-shot-commit family; it is a *different* mechanism than the 11-verb
`cms.content.tree.mutate` family, and that difference is the established,
disclosed shape every prior one-shot kind (`detach`/`swap`/`css`/`class`) already
has. If the routing agent still wants a `mutations.ts`/`treeOperations.ts`
registration on top of this, the exact shape needed would be: a 12th
`TreeOperation` kind (`'insertSlot'`/`'promoteComponent'`) that does NOT map to
any existing `mutations.ts` primitive (there's no in-memory "add this to a
prop"/"split this subtree into a file" mutation, and inventing one would
duplicate what the codemod already does authoritatively via re-parse) — I
believe this would be architecturally wrong for the reasons above, but I did
not have permission to make that call inside `mutations.ts` either way.

## Gating — where "refuse before mutating" actually lives for each kind

Neither kind is gated by `refuseMintedNodeInsert` — **see the landmine below,
this was a correction I had to make against my own work order's phrasing.**

- **`insert-slot`**: the write targets the CALL SITE's own attribute, not the
  slot's locked content. The correct client-side pre-check (owned by D2's
  `structuralSourceEdits.ts`, which I did not touch) is
  `refuseStructuralEdit({kind: 'insert', node: callSiteNode})` — asked about
  the call site, **never the `studio.slot` container**. Verified in my
  required-proof test: asking this about an ordinary call site returns `null`
  (not refused); asking the IDENTICAL question about the slot container
  itself (whose `lockReason` is E2.3's `SLOT_LOCK_REASON`) DOES wrongly
  refuse `code-placed` — proving `insertJsxIntoSlotProp`'s location convention
  (call site, never the container) is the one that tears down "wall #3"
  rather than recreating it one level over. **This client-side wiring is not
  built yet — it is E2.5's job**, same as the picker-insert gesture's own
  pre-check already is.
- **`promote-component`**: gates through `refusePlacement` **inside**
  `extractSubtreeToComponent` (E2.1's own code) using the un-split `nodeId` —
  catches `list-row`/`route-chrome` fully, `shared-component` when the caller
  supplies a composite id (which `promote-component`'s wire schema does), and
  `code-placed` only when the caller ALSO supplies `lockReason` — which the
  **server-side dispatcher structurally cannot** (see below), matching
  `detach`/`swap`'s identical, pre-existing limitation.

**Server-side statelessness is not a new gap.** `studioWriteback.ts`'s
dispatcher has no loaded page tree for ANY kind — `detach`/`swap` already
prove this (no `lockReason` reaches them either). The gate that actually
matters — full `lockReason` knowledge — runs client-side, before the edit is
ever constructed, exactly as `struct-01` established for `move`/`delete`/
`insert`. Whoever builds E2.5's promote-to-component UI must pre-check with
the loaded tree's real `lockReason` the same way the picker-insert flow
already does.

## THE REQUIRED PROOF — fragment-valued slot insert vs. the two id-shaped gates

`src/core/page-parser/__tests__/insertJsxIntoSlotPropRoundtrip.test.ts`,
1 test, 22 assertions. I want to be precise about what I actually proved,
because **the literal claim in my work order ("must not trip
`refuseMintedNodeInsert`") turned out to be imprecise once I read
`refuseMintedNodeInsert`'s actual, single call site** — I ran it directly
(`src/core/page-tree/sourceStructure.ts`, read-only) before writing the test
rather than trust the phrasing:

- `refuseMintedNodeInsert` has **exactly one caller**:
  `assertSourceInsertable` in `treeOperations.ts`, which only fires for
  `applyTreeOperation`'s `insertNode` TreeOperation (a plugin/agent handing
  over an ALREADY-BUILT node object with its own, always-minted id). My
  `insert-slot` kind never calls `applyTreeOperation` at all — same as plain
  `insert`/`move`/`delete`/`detach`/`swap`/`css`/`class` — so this gate is
  **structurally irrelevant to my feature's write path**, not something my
  codemod could "trip" even if it wanted to.
- What the id grammar's real-position choice (fragment's own `<`, not a
  minted synthetic id) actually buys, VERIFIED by directly calling
  `refuseMintedNodeInsert`: for a genuinely source-derived container (my
  fragment slot, after re-parse), it **correctly REFUSES**
  `applyTreeOperation.insertNode` (reason `'insert'`) — the right outcome,
  since every node that op carries is minted and a source-derived container
  can never honestly receive one. Had E2.3 minted a synthetic (non-
  `rel:line:col`-shaped) id instead, `isSourceDerivedNodeId` would read
  `false` and `refuseMintedNodeInsert` would **silently ALLOW** the mint
  instead — the actual `struct-01` silent-no-op this whole gate exists to
  prevent. My test asserts both directions plus a negative control (an
  ordinary nanoid CMS-tree parent, which correctly stays unrefused).
- The gate that DOES matter for my actual feature — `refuseStructuralEdit`'s
  `insert` case — is proven in the OPPOSITE direction from the work order's
  framing: asked about the ORDINARY call site, it does not refuse (proving
  `insert-slot` is reachable); asked about the SLOT CONTAINER itself (which
  is what a naive implementation might have done), it WOULD wrongly refuse
  `code-placed` — this is "wall #3" from the plan doc, and the reason
  `insertJsxIntoSlotProp`'s own location convention never targets the
  container.

The test also proves the parser seam itself: write a single-element slot,
call `insertJsxIntoSlotProp` to add a second element (wrapping into a
fragment), re-parse, and confirm E2.3's `studio.slot` container appears with
`fragmentSlot: true`, 2 children, and a decodable `rel:line:col` matching the
fragment's own position — the literal "wrap both in a fragment... round-trips
via E2.3's capture" claim from the work order, now checked end to end rather
than assumed.

## Decisions

Neither kind is a value **resolution** (no `Resolution`/`origin`/`codeProps`
question applies the same way §7's evaluator resolutions do) — both are
writeback verbs, like `move`/`delete`/`insert`/`detach`/`swap`/`class` before
them. Answering the analogous questions anyway:

- **`insert-slot`**: does not touch `locked`/`lockReason` on any node — the
  re-parsed slot container's lock (`SLOT_LOCK_REASON`) comes from E2.3's
  existing, unchanged capture logic. Adds nothing to `codeProps`. No
  `origin` (nothing here is a literal being read). Panel: not mine (E2.5).
- **`promote-component`**: same — extracts markup into a new file the parser
  re-reads as ordinary, unlocked content (unless the SOURCE subtree itself
  had its own structural reasons to lock, which move with it verbatim). No
  `codeProps`/`origin` implications of its own. Panel/review-step for
  `freeVariables`: not mine, and still an open gap E2.1 already flagged.

## Landmines found, not already in the 578-line doc — tell `studio-scribe`

1. **`refuseMintedNodeInsert` has exactly one call site
   (`applyTreeOperation`'s `insertNode`) and is NOT the gate that protects an
   ordinary canvas "insert" gesture** (that's `refuseStructuralEdit`'s own
   `case 'insert':` → `refusePlacement`). My own work order's phrasing
   conflated the two; I verified the actual behavior by calling both
   functions directly before writing the required-proof test rather than
   trust the framing. Worth stating plainly somewhere central (`sourceStructure.ts`'s
   own doc comment already explains `refuseMintedNodeInsert` correctly in
   isolation — the gap is that nothing cross-references it against
   `refuseStructuralEdit`'s `insert` case for someone skimming both).
2. **`ts-morph`'s `sourceFile.addImportDeclaration`/`ImportDeclaration.
   addNamedImport` append a trailing semicolon by default**, even into a file
   whose existing imports have none (`import { Sheet } from './Sheet'` stays
   semicolon-less; a freshly synthesized `import { Icon } from '...'`
   generated by these two APIs gets one). Same class of "ts-morph's own
   default, not something the codemod controls" landmine as B2's #2
   (`setLiteralValue` preserving quote style) — but the opposite direction
   (this one does NOT match the file's existing convention). Affects every
   codemod that calls these two APIs directly rather than hand-rolling text
   (`extractComponentCopy.ts`, `extractSubtreeToComponent.ts`,
   `insertJsxIntoSlotProp.ts` — `insertJsxElement.ts`'s own `resolveImportEdits`
   is unaffected, it hand-rolls the text and therefore controls this).
3. **`element.getAttribute(propName)` can never actually observe a spread
   attribute for a real (non-`"...expr"`-literal) prop name** — identical
   "effectively unreachable" class to `setJsxStyle`'s and `setJsxClassName`'s
   own spread guards (both already flagged by B2's landmine #4). My
   `spread-attribute` refusal in `insertJsxIntoSlotProp.ts` is defensive-only
   for the same reason and, matching those two files' own precedent, has no
   test asserting that specific reason string.
4. **`dedupeStudioEdits`'s existing dedup key only special-cases the literal
   field name `prop`** (from `PropEditSchema`). `insert-slot`'s field is
   `propName`, so without exempting `insert-slot` from dedup entirely (the
   same exemption plain `insert` already has, and for the identical reason —
   its `nodeId` names a CONTAINER, not an overwrite target), a batch filling
   two DIFFERENT slots (`header` and `footer`) on the SAME call site would
   have silently collapsed to one. Caught by writing the test, not by reading
   the existing code — worth a note in `docs/features/studio-import.md`'s
   dedup section once a client actually builds a multi-slot-fill UI.

## Verification run

```
bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio server/handlers/__tests__/studioWriteback.test.ts
  → 567 pass / 0 fail, combined, run LAST (after the tsc-driven `as`-cast
    cleanup in studioSlotWriteback.ts) — includes the 10 new insert-slot/
    promote-component tests (6+4) and the 1 required-proof roundtrip test
bun test server/handlers/studio server/handlers/__tests__
  → 823 pass / 7 fail / 1 error — all 7 fails are in projectGuide.test.ts /
    projectSeed.test.ts (legacy-artefact-sweep / seed-dir override), NOT
    touched by me, matching the pre-existing baseline other agents this wave
    already reported; the 1 error is styleCompile.test.ts's sass worker
    (environment-dependent, unrelated)
bun test server/ai/mcp/tools/studio
  → 165 pass / 0 fail — confirms StudioEditSchema's two new kinds don't
    break the existing MCP tool tests (read-only check, did not edit)
bun test src/__tests__/architecture/module-size-budgets.test.ts
  → 5 pass / 0 fail — studioWriteback.ts 692/700, studioSlotWriteback.ts 191,
    insertJsxElement.ts 661/700, insertJsxIntoSlotProp.ts 305
bun test src/__tests__/architecture/no-core-barrel-deep-imports.test.ts
  → 1 pass / 0 fail
./node_modules/.bin/tsc --noEmit -p tsconfig.json
  → clean, no output
./node_modules/.bin/eslint <every file in Scope above>
  → clean, no errors/warnings
```

Did not run `bun run build`/`bun run lint` (five sibling agents editing
`canvas/**`, `mutations.ts`, `framework/**`, panels, and the architecture
gates concurrently — `dist`/`.tsbuildinfo` collision risk).

## Not committed

Working tree only — no `git add`, no commit, `STATE.md` untouched by me.
