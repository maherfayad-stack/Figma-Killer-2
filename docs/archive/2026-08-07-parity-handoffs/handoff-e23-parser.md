# E2.3 — Parser, three small changes — handoff

## Scope (files touched)

- `src/core/page-parser/parsePageFile.ts` — fragment dispatch in
  `captureSlotProps`'s call site now lives here only as the `kind ===
  'component'` branch call; the capture logic itself moved out (see below).
  **Net effect on this file: 686 → 640 lines** (module-size gate: the initial
  in-place implementation pushed it to 742/700; fixed by extraction, not by
  trimming or grandfathering).
- `src/core/page-parser/slotCapture.ts` — **new**. `captureSlotProps` (moved
  verbatim, doc included) + the new `processFragmentSlot` helper + the moved
  `SLOT_LOCK_REASON` constant. Takes `processElement`/`processChildren` as
  injected function params (not imports) specifically to avoid a circular
  import with `parsePageFile.ts` — those two functions still live there.
- `src/core/page-parser/types.ts` — new `ParsedNode.fragmentSlot?: true`.
- `src/core/studio-sync/parsedPageToSitePage.ts` — threads `fragmentSlot`
  through the `resolveModuleId` Pick type and the object built at the call
  site (same pattern `instanceOf` already established for WS-4.2).
- `server/handlers/studioPageLoad.ts` — `resolveModuleId` checks
  `node.fragmentSlot` **first** (before the `kind`-based dispatch, same as
  `instanceOf`) and returns `'studio.slot'`.
- `src/modules/studio/slot/` — **new module**: `index.ts` (registration),
  `SlotEditor.tsx` (`<>{children}</>`, zero DOM), `props.ts` (empty
  `Type.Object({})` schema). Copied `src/modules/base/instance/` verbatim in
  structure.
- `src/modules/base/index.ts` — added `import '../studio/slot'` next to the
  existing `import './instance'`, so the new module actually self-registers
  (the barrel every eager-imported base module goes through).
- Tests: `src/core/page-parser/__tests__/structuredProps.test.ts` (3 new
  cases), `src/modules/studio/slot/__tests__/SlotEditor.test.tsx` (new, 2
  cases).

I did **not** touch `src/core/ast-codemods/**`, `src/core/page-tree/
sourceStructure.ts`, `src/admin/pages/site/store/**`, `panels/**`,
`canvas/**`, or `server/ai/**` — all still owned by other agents.

## The published id grammar for a `studio.slot` node (E2.4/E2.5 contract)

```
${relFile}:${line}:${col}${idSuffix ?? ''}
```

Identical grammar to every other plain source-derived node id
(`sourceNodeId.ts`'s `SOURCE_LOCATION`/`SOURCE_DERIVED_ID`) — **not** a new
shape, **not** minted. Specifically:

- `relFile`/`idSuffix` are the same `ctx.relFile`/`ctx.idSuffix` every other
  node in the parse uses (so a fragment slot nested inside an expanded
  `.map` row correctly gets a `#<index>` suffix, same as any other node).
- `line`/`col` are `ctx.sourceFile.getLineAndColumnAtPos(fragment.getStart())`
  — the position of the fragment's own `<` character (`JsxFragment.getStart()`
  === `JsxOpeningFragment.getStart()`, verified: for
  `        <>` (8 leading spaces) the id lands at column 9, i.e. the `<`).
  This is `processElement`'s exact convention (`tagNameNode.getStart()`,
  "immediately after `<`") minus the tag name, since a fragment has none.
- Consequences that matter to consumers:
  - `isSourceDerivedNodeId(id)` → `true`, `hasWritableSourceLocation(id)` →
    `true`, `decodeSourceNodeId(id)` → `{ rel, line, col }`. **Verified by
    test** (`structuredProps.test.ts`, "captures a multi-element (fragment)
    slot value…").
  - `refuseMintedNodeInsert` (`sourceStructure.ts`, NOT touched by me) treats
    this id as real — it will **not** refuse an insert into this container
    for the "minted id" reason. Whatever E2.4 decides about inserting into a
    slot, it will be blocked (if at all) by the container's `lockReason`
    (`'slot content — fills a component prop'`, `SLOT_LOCK_REASON`,
    exported from `slotCapture.ts`), not by a bogus "can't write here at
    all" id problem.
  - The node's own `moduleId` is `'studio.slot'` (via
    `ParsedNode.fragmentSlot` → `resolveModuleId`'s new first check).
  - Reachable from the parent's `props` only via the sentinel
    (`studio-slot:<id>`, `studioSlotSentinel.ts`, unchanged) — **not** a
    normal DOM child of the host component, exactly like the pre-existing
    single-element slot case.

## Fragment shapes captured vs. declined

Captured (produces a `studio.slot` container, `fragmentSlot: true`,
`locked: true`, `lockReason: SLOT_LOCK_REASON`):

- Any `JsxFragment` value on a **component** prop `captureSlotProps` reaches
  (i.e. an attribute whose name is not already a resolved scalar/icon/
  structured value): `header={<><Back/><Title/></>}`, including the
  zero-child case `header={<></>}` (produces a container with
  `children: []` — deliberately not special-cased; the fragment genuinely
  exists in source, there's nothing dishonest about representing it empty).
  Its own children walk through the **ordinary** `processChildren` and
  **inherit the slot's lock** (`SLOT_LOCK_REASON`), exactly mirroring how a
  single captured element's children already inherited its lock before this
  change — the two capture paths (single element vs. fragment) are
  structurally identical, just N roots instead of 1.

Unchanged (still the pre-E2.3 single-element path, verbatim — the "zero
parser change" round trip):

- A single `JsxElement`/`JsxSelfClosingElement` value
  (`icon={<Icon/>}`) — still `processElement(expression, ctx, true,
  SLOT_LOCK_REASON)`, no `fragmentSlot` marker, mints one ordinary node.
  **Verified unaffected by a mixed-slot test** (icon + header fragment on
  the same call site, `structuredProps.test.ts`'s third new case) and by
  the pre-existing WS-3.4 test in the same file still passing unmodified.

Declined (unchanged from before — `captureSlotProps` still `continue`s):

- Anything else the attribute's expression could be (a call, a conditional,
  a plain identifier, etc.) — only a `JsxFragment` or a
  `JsxElement`/`JsxSelfClosingElement` are recognized JSX shapes here.
- An attribute whose name `extractProps` already resolved into a scalar,
  the `{svg}` icon shape, or a structured array/object (checked first,
  unchanged).
- `style`/`dangerouslySetInnerHTML` never reach this function at all (their
  values are never JSX / already handled earlier in `processElement`).

## Declared-but-empty slots produce no node — confirmed, no change needed

`captureSlotProps` only iterates the JSX **attributes actually present** on
the call site (`for (const attribute of attributes)`). A component prop the
source's `interface`/type declares but the call site simply does not pass
has **no attribute at all**, so nothing is captured — no sentinel in
`props`, no node in `ctx.nodes`. This was already true before E2.3 (nothing
in my change touches this path) and I added an explicit regression test for
it: `structuredProps.test.ts` → "a declared-but-unfilled slot prop produces
NO node" — asserts `sheet.props.header` is `undefined`, `Object.keys(sheet
.props)` is exactly `['title']`, and the whole parsed page has exactly 1
node (the call site itself, no phantom placeholder). The panel is expected
to learn that a component *has* a `header` slot from E1's catalog
(`componentSpecExtract.ts`/`LocalComponentSpec`), never from a placeholder
node here — I did not touch `componentSpecExtract.ts`.

## `studio.slot` module — zero DOM, actually wired

- `src/modules/studio/slot/SlotEditor.tsx` renders literally `<>{children}
  </>` (copied `InstanceEditor.tsx`'s structure verbatim, including the
  "why not `display:contents`" reasoning in the doc comment).
- `src/modules/studio/slot/__tests__/SlotEditor.test.tsx` renders the
  component directly (not through the full canvas/store, to avoid the
  canvas-engineer's actively-changing files) and asserts
  `container.children.length` equals exactly the number of children passed
  (2, or 0 with no children) — i.e. no wrapper element appears.
- Registration path verified end-to-end (integration-gap protocol): parser
  sets `fragmentSlot: true` → `parsedPageToSitePage` forwards it →
  `resolveModuleId` maps it to `'studio.slot'` → `src/modules/base/index.ts`
  imports `'../studio/slot'` so `registry.registerOrReplace(SlotModule)`
  actually runs on app boot (same barrel every other base/instance module
  self-registers through) → the existing `registerProjectModules.ts`'s
  `revivePropValue`/`NodeRenderer(nodeId)` path (unchanged, not touched)
  renders the node by its `moduleId` like any other.

## Decisions (per CLAUDE.md's "when you add a resolution" checklist)

`fragmentSlot`/the `studio.slot` container is **not a resolved value** — it
carries no `Resolution`, adds nothing to `codeProps` beyond what a slot
already implied, and has no `origin` (it's a structural container, not a
literal read). It follows the exact same structural-lock treatment
`SLOT_LOCK_REASON` already established for the single-element case:
- **Locks the node?** Yes — `locked: true`, `lockReason: SLOT_LOCK_REASON`
  ("slot content — fills a component prop"). Cannot be dragged out of the
  slot structurally. Its children are ordinary (individually inspectable)
  nodes underneath it, same split every other locked node in this parser
  follows.
- **codeProps?** No new entries. The container's own `props` is `{}`.
- **origin?** No — nothing here is a literal being read; it's a structural
  container.
- **Panel?** Not addressed by me (E2.5's job) — but nothing about this
  node needs `CodeValueControl` since it carries no props of its own; its
  children get whatever controls their own shapes earn.

## What E2.4/E2.5 still need to build (explicitly NOT done here)

- Wall #3 (insert into a slot) and wall #4 (slot children invisible in layer
  tree) are untouched, per the work order. The `studio.slot` container's
  `lockReason` is still `SLOT_LOCK_REASON`, which today reads as
  `code-placed` to `refuseStructuralEdit` — E2.4 will need to decide how
  insertion into this specific lock reason is allowed (the id itself is
  real and insertable per `refuseMintedNodeInsert`; whatever gate change is
  needed belongs in `sourceStructure.ts`, which I did not touch).
- E2.4's `insertJsxIntoSlotProp.ts` "present single element → wrap both in a
  fragment" path should produce a shape my `captureSlotProps` fragment
  branch round-trips on the *next* parse (wrapping an existing single
  element in a fragment and adding a sibling): verify this once that
  codemod exists — I did not write or test the codemod side.
- E2.5's `slotOwners` index and layer-tree visibility are untouched.

## Landmines found, not already in the 578-line doc

1. **Module-size budget is tight for `parsePageFile.ts`.** It was already at
   686/700 lines before this change (14 lines of headroom). Any future
   parser change that adds more than ~15 lines of logic directly to that
   file (as opposed to a new sibling module) will trip
   `module-size-budgets.test.ts`. I resolved this by extracting slot capture
   into `slotCapture.ts`, following the exact pattern `branchSelection.ts`/
   `jsxAttributeReaders.ts`/`staticLoopExpansion.ts` already established —
   worth flagging to `studio-scribe` so the next agent budgets for this
   up front instead of discovering it at the end.
2. **Avoiding a circular import between a newly-extracted parser module and
   `parsePageFile.ts` requires dependency injection, not a reverse import.**
   `slotCapture.ts` needs `processElement`/`processChildren` (both still
   defined in `parsePageFile.ts`), so it takes them as function parameters
   rather than importing them — `branchSelection.ts` avoids this problem
   entirely by being one-directional (imported BY `parsePageFile.ts`,
   imports nothing back). A future extraction that needs the tree-walk
   functions themselves (not just types) will hit the same issue and should
   use the same param-injection pattern rather than trying to import across
   the cycle.
3. **`JsxFragment.getStart()` equals `JsxOpeningFragment.getStart()`** (the
   position of `<` in `<>`) — ts-morph has no separate "start of the fragment
   node's own opening token" concern to worry about here, unlike an element
   where `tagNameNode.getStart()` deliberately differs from the element's own
   `getStart()` (which would include the `<`). Worth stating explicitly
   since it's easy to assume you need `getOpeningFragment().getStart()` and
   second-guess whether they differ — they don't.

## Verification run

```
bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio src/modules/studio src/core/studio-sync
  → all pass (see below for exact counts)
bun test src/__tests__/architecture/module-size-budgets.test.ts
  → 4 pass / 1 fail — the 1 failure is server/ai/handlers/chat.ts + server/handlers/studio.ts,
    both outside my diff (git status confirms — modified by concurrent sessions), NOT parsePageFile.ts
bun test server/handlers/__tests__/studio.test.ts server/handlers/__tests__/studioPageLoad.test.ts
  → 109 pass / 0 fail
./node_modules/.bin/tsc --noEmit -p tsconfig.json
  → clean, no output
```

Did not run `bun run build` / `bun run lint` (instructed not to — dist/
`.tsbuildinfo` collisions with concurrent siblings).

## Not committed

Working tree only, per instructions — no `git add`, no commit.
