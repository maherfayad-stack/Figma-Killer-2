# Studio pipeline — parse, resolve, render, write back

The load → edit → write loop, compressed for agents. The full, authoritative
version is [`docs/features/studio-import.md`](../features/studio-import.md)
(578 lines) — read that before making a **parser** change. This page is enough
for everything else.

---

## The loop

```
GET /admin/api/studio/load?dir=<abs>            server/handlers/studio.ts
   └─ loadStudioPages()                          studioPageLoad.ts
        1. discoverPageFiles(pagesDir)           studioProjects.ts
        1b. discoverStories + buildStoryRouteEntries
                                                 studio/story{Discovery,Pages}.ts
            W5-3 — Storybook CSF becomes extra route entries. Gated on a
            filename glob, so a project with no `*.stories.*` pays nothing.
            Accepted subset + the named refusals + measured acceptance
            rates: studio-import.md §"Storybook stories as pages".
        2. parsePageFile() per file              page-parser/parsePageFile.ts
        3. resolveComponentSources()             componentSources.ts   local | package
        4. inlineLocalComponents()               inlineLocalComponents.ts
        5. staticEval — resolve values           staticEval*.ts        Tiers A/B/C
        6. staticLoopExpansion — .map            staticLoopExpansion.ts
        6.5 compileProjectStyles (WS-2.1)        studio/styleCompile.ts — runs BEFORE step 2, see below
        7. loadStudioStyles — .css → StyleRule   studioCss.ts
        8. parsedPageToSitePage()                studio-sync/
        9. rewriteStudioAssetSentinels()         → /admin/api/studio/asset URLs
   → editor store  →  board frames  →  iframes

Independently, the CLIENT (`fsCodemodAdapter.ts`'s `loadSite`) calls
`POST /admin/api/studio/tokens` (`tokens-01`, `studio/tokenExtract.ts`) right
after `GET /admin/api/studio/framework` — reads `:root` custom properties out
of the SAME `compileProjectStyles` output step 6.5 already produced (falling
back to a static Tailwind-theme read, then vendor package CSS), classifies
them into `FrameworkColorToken`/`FrameworkSpacingGroup`/
`FrameworkTypographyGroup`, and merges them into `.studio/framework.json`
WITHOUT clobbering anything already there (whole-family merge — a family is
only filled when currently empty). This is what populates the Framework
panel's Colors/Typography/Spacing on a fresh import.

POST /admin/api/studio/save  { dir, edits: StudioEdit[] }
   └─ studioEditLocation()  → { rel, line, col }  (split composite id, keep TAIL)
   └─ applyStudioEdit()     → one ast-codemod per edit
   → { written, skipped, shifted, sharedComponents }
```

---

## The two facts every node carries

**Do not conflate these.** Conflating them once made 45% of a real board
uneditable.

| Field | Means | Consequence |
|---|---|---|
| `locked` / `lockReason` | **Structure**: the source does not simply place this node — a `.map` generated it, an unresolved ternary/`&&`/call the parser could not pick a single branch for, or a spread feeds it | Cannot be moved, deleted, reordered, wrapped |
| `codeProps: string[]` | **Values**: prop names with no writable target, because the source holds an expression, not a literal. Inline styles appear as `style:<property>` | Those props are read-only; **siblings stay editable** |

The structural half has its own predicate, the exact sibling of
`isPropWritableToSource` — `refuseStructuralEdit(...)` in
`src/core/page-tree/sourceStructure.ts`. See "Structural writeback" below.

It runs both ways. A resolved value (`{c.heading}`) records `codeProps` and
`resolution` and **does not lock its node** — `lock-01` deleted that lock, which
was 149 of the 276 locks on the real board (34.4% -> 15.8% locked) and made the
panel tell every one of them "this element can't be moved or deleted", which was
false. `lockReason` is now only ever structural.

A structurally locked node with a real source location **still takes prop, style,
and text edits**. One predicate decides, and every surface asks it:

```ts
isPropWritableToSource(node, propName)   // src/core/page-tree/sourceWritability.ts
```

Surfaces that consult it: `updateNodeProps`, `setNodeInlineStyles`,
`PropertiesPanel`, `InPlaceInspector`, the HTML attributes tab, and canvas
double-click. If you add an edit surface, **ask this function** — do not
re-derive the rule.

---

## Node ids are source locations

```
src/screens/Home.jsx:77:19                         a plain node
src/screens/Home.jsx:77:19~components/Icon.jsx:3:5 an inlined node (call site ~ component)
src/screens/Home.jsx:88:7#2                        the 3rd row of a .map
index:body                                         synthetic root — no source
```

Grammar lives in **one place**: `src/core/page-tree/sourceNodeId.ts`
(`INLINE_ID_SEPARATOR` = `~`, `LOOP_ID_SEPARATOR` = `#`,
`hasWritableSourceLocation(id)`).

**Rules you must not break:**

1. Never build, concatenate, or regex an id by hand.
2. To write back a composite id, **split on `~` and keep the tail.** The naive
   regex matches straight through the separator and yields a path that doesn't
   exist — an arbitrary file write in the worst case.
3. `…#2` has **no writable source location** — one piece of JSX renders every
   row. Its resolved *text* is the only exception (each iteration read a
   different array element; `textOrigin` names the literal).
4. `fsCodemodAdapter.ts` **mirrors** the separator literal instead of importing
   it. That is deliberate: importing the page-parser barrel drags ts-morph into
   the browser bundle and blows the chunk budget. Keep them in sync by hand.

---

## The value evaluator — tiers are the boundary

A **bounded partial evaluator, not a JS interpreter**. Do not blur the tiers.

| Tier | Resolves | File |
|---|---|---|
| **A** | literals, module/cross-file consts, member chains, array indexing, template literals, operators (`+ - * / % **`, `!`, `\|\|`, `&&`, `??`), `Math.*` constants and pure fns, `.length` on a spread-free array, and (parser-08) `{kind:'undefined'}` for a key missing from a **complete** object/array — a real answer, not `unresolved` | `staticEvalCore.ts`, `staticEvalOperators.ts`, `staticEvalValues.ts` |
| **B** | `useLanguage()` → `useContext(Ctx)` → the single `<Ctx.Provider value={…}>`; unwraps `useMemo`; picks a dictionary branch by `preferredKey` (sourced from `.studio/meta.json`'s `previewAxes.locale` — WS-10 §4.2) and records a `note` | `staticEvalCalls.ts` |
| **C** | pure function calls in an explicit envelope: concise body, or bare `if (c) return …` / `return …`; no assignment, loop, `await`, `new`. Whitelist: `String`, `Number`, `Math.*`, `.toFixed`, `.padStart`, `.toUpperCase`, `.toLowerCase`, `.trim`, `.join`, and `cn()`/`clsx()`/`classNames()`/`classnames()` (WS-2.2 — matched by identifier name, implements the join itself, never calls the user's actual function) | `staticEvalCalls.ts` |
| **D** | **BANNED.** *Guessing* a JSX branch, hook state, effects, async. (Selecting a branch from a condition Tier A/B can READ, or from a stated positional heuristic, is `branchSelection.ts`'s job and is not this.) | — |

WS-2.2: `import styles from './Card.module.css'` resolves through `assetImports.ts`'s
`resolveCssModuleImport`, the same "import with no `SourceFile`" mechanism `?raw`
and image imports use — sourced from `StaticEvalOptions.cssModuleClassMaps`,
which `studioPageLoad.ts` populates from `styleCompile.ts`'s `compileProjectStyles`
BEFORE parsing (see the loop diagram's step 6.5).

`.map` over a **fully resolved** array is expanded (not Tier D — no branch to
guess, length comes from source). Guard rails: array *and every item* must
resolve; inline arrow with identifier params; `MAX_LOOP_ITERATIONS` = 100.

**Every guard trip returns `{kind:'unresolved'}`** — never an exception, never a
hang. `parsePageFile` never throws.

Budgets: `maxDepth` 24 (binding hops only) · `maxSteps` 2000 per top-level call ·
`pageBudget` 20 000 per page load · cycle keys per binding/provider.
**A guard-truncated result is never cached** — caching one made "which page
parsed first" decide whether any copy resolved.

---

## Writeback rules

| Rule | Why |
|---|---|
| **Never write a resolved value back as a literal** | `title={c.sheetTitle}` → writing `"Where to?"` deletes the binding |
| **Resolved TEXT is the exception** — it writes to `textOrigin` | The dictionary entry is an ordinary string literal at a known `rel:line:col`. Emitted as `kind:'literal'` |
| **Reload only when `written > 0`** | A reload re-parses and replaces the document. With zero writes it overwrites the user's in-memory edit — the change reverted itself ~2 s after typing |
| **A reload is NARROW by default** | `shifted`/`sharedComponents` used to mean a full `loadSite()`; on an App Router board, shared layout chrome makes `sharedComponents` the common case, so every save reparsed all forty pages. `resyncBoardAfterWrite` (`studioBoardResync.ts`) asks `/reload-scope` which pages the touched files feed and patches only those. It widens whenever it cannot prove the scope — narrowing may never UNDER-reload |
| **A save's resync runs LAST** | It rewrites the same diff baselines `saveSite` advances after its POST; running it inline lets the save's own commit overwrite the fresh disk baseline with the pre-reload document |
| **`skipped > 0` raises a toast** | A refusal the user can't see is indistinguishable from data loss |
| **`applyStudioEdit` returning `false` counts as `skipped`** | It used to increment neither counter, so the client assumed a write happened |
| **`tag` has its own edit kind + codemod** | Routing it through `setJsxProp` added a literal `tag="section"` attribute and left the element a `<div>` — 140 fake controls on one corpus |
| **Path containment in the decoder** | `rel` arrives from the client inside `nodeId`; the save route builds `join(dir, rel)` |
| **`loadSite` keeps the currently-open page** when the incoming site still has its id | Resetting to home mid-edit reads as the canvas moving on its own |

Codemods live in `src/core/ast-codemods/` and preserve the file's quote style
and formatting. Edits apply **bottom-to-top** so earlier writes don't shift
later line numbers.

---

## Structural writeback (`struct-01`)

`StudioEdit` used to carry value kinds only (`prop | text | style | literal |
tag | asset | detach | swap | css`). A move, delete, insert, duplicate or wrap
therefore reached **no** code path at all: the tree changed, the save reported
success, the `.tsx` was untouched, and the change was gone on reload. In Studio
the repository IS the document, so that was a silent no-op.

Six kinds now exist — **`move`** and **`reparent`** (`moveJsxElement`, whose
destination-parent form is W4-1's), **`delete`** (`deleteJsxElement`),
**`insert`** (`insertJsxElement`), **`duplicate`** (`duplicateJsxElement`) and
**`wrap`** (`wrapJsxElement`) — and everything else refuses out loud.

**None of them mints a node; all of them ask the SOURCE to grow one.** Adding a
design-system component from the picker writes `<Button … />` *and* the `import`
that names it into the user's file, then reloads the board — so what appears on
the canvas is an ordinary parsed node with a real `rel:line:col`, not a nanoid
the editor invented. W4-1 generalised that write-then-re-read shape to the last
three Figma verbs, which is why they stopped refusing: a duplicate is the
element's own bytes written in again, a wrap replaces its range with itself
inside a container, and a reparent splices its bytes into a different parent in
the same file. The module declares its own source spelling via
`ModuleDefinition.sourceImport` / `sourceIntrinsic`, so nothing in the store is
coupled to a particular design system. The plugin/agent dispatcher
(`applyTreeOperation`) still refuses — `refuseMintedNodeInsert` for an insert,
`refuseMintedNodeCopy` for a duplicate/wrap/reparent — because those callers
persist a TREE (into a `data_row`), never a `.tsx`, so the write would never
reach the file. A reorder through them mints nothing and stays allowed.

**A wrapper written into the source is legitimate.** The "no wrapper divs" rule
is about the CANVAS inventing DOM the source does not have; a `<div>` in the
`.tsx` is real DOM the user can read, style and delete.

**The gate runs before the mutation, not after.** One pure rule,
`refuseStructuralEdit(...)` in `src/core/page-tree/sourceStructure.ts`, is
asked by the store's structural actions (`structuralSourceEdits.ts`) and by
`applyTreeOperation` (so a plugin or an agent rides the same gate). It answers
from the node id and `lockReason` alone:

| Refusal | Because |
|---|---|
| `list-row` | a `.map` row — one piece of JSX renders every row |
| `shared-component` | an inlined id — the markup is in the component's own file, so a move there moves every instance |
| `route-chrome` | a Next `layout`/`template` — one file, many frames |
| `code-placed` | the parser recorded a structural `lockReason` |
| `insert` | asked about the CONTAINER, not a node — it refuses only when the container itself is a `.map` row / inlined / route chrome / code-placed |
| `reparent` | no container to write into, or one that is not an ordinary element. `duplicate`/`wrap` carry no refusal of their own beyond the four above |
| `multi-select` | several elements REORDERED or REPARENTED at once, or a WRAP of several (one wrapper spanning N ranges). A multi DELETE or DUPLICATE is fine — the batch is ordered bottom-to-top |
| `cross-file` / `no-sibling-anchor` | a reorder is written as "put this before that one", so it needs a plain sibling in the same file; a reparent needs its new parent in that file |

The AST adds the refusals only it can answer: `not-siblings`,
`expression-child` (the element comes out of `{cond && <X/>}`, so its position
is decided at runtime), `mixed-indentation`, `no-jsx-parent` (it is what the
component returns), `stale-source`, `into-own-descendant`, and W4-1's
**`out-of-scope`** — a reparent whose markup reads a binding that does not exist
where it would land (`subtreeFreeVariables.ts`; the refusal names the
variables). It is a static scope walk over the declarations enclosing the
destination, never an evaluation of any of them.

**A refusal reaches the user as an `EditConstraint`, never a bare string.**
`describeStructuralRefusal` (`src/core/page-tree/editConstraint.ts`) dresses
the rule's `{reason, message}` with the two things a person needs next: the
`origin` (`rel:line:col`) the refusal traces to, and its `actions` — zero or
more named ways forward. Every surface renders that one object:

| Surface | What it shows |
|---|---|
| Refusal toast (`toastStructuralRefusal`) | Persistent (`durationMs: null`), deduped by gesture + reason + sentence, with the first runnable action — or the jump to `origin` — as its button |
| Layers context menu | Disabled item + tooltip, plus a `ConstraintNotice` footer carrying `origin` and `actions` |
| Canvas drag | The explanation as a chip beside the refused drop rect, while the pointer is still down (`explainGestureConstraint` → `canvasDnd.ts`'s `invalid.constraint`) |

`ConstraintNotice` (`src/admin/pages/site/ui/ConstraintNotice/`) is the shared
renderer; `resolveConstraintAction` (`@site/store/constraintActions` — beside
the store, because the toast is fired from inside a store action) is the one
kind → handler table. **An action with no honest handler renders as plain
text, not a disabled button** — "Drag them one by one" is advice, not a command
the editor can run. Copy is rendered as the engine authored it; no surface
rewrites it.

A delete is NOT refused for orphaning an import. `pruneOrphanedImports` retires
any binding the removed markup alone was using, once per file after the whole
batch has landed — see `studio-import.md`, "The two codemods".

**A reorder is written against an ANCHOR, never an index.** The editor's child
list and the JSX child list are different lists. `planSourceMove` simulates the
move, finds the neighbour the node lands beside, and sends
`{ nodeId, anchorNodeId, position }`.

**Byte-exactness.** These codemods use the AST only to LOCATE; the write is a
splice of the original bytes (`jsxChildRange.ts`), and it refuses outright if
the text on disk differs from the text ts-morph parsed. An AST rewrite that
reformats an untouched sibling is a defect.

**Commit shape.** Structural edits are one-shot commits
(`commitStudioMove` / `commitStudioDelete` / `commitStudioDuplicate` / … in
`studioStructuralCommits.ts`), like
asset/detach/swap — never the `saveSite` diff, which has no notion of parent or
order. They always reload afterwards: a successful write shifted every
`line:col` below it, and a refused one has to be taken back.

Measured on the 15-page eSIM corpus (787 source-derived nodes): **28.8%
reorder**, **17.0% delete**; the rest refuse, `shared-component` (48.5%) being
by far the largest bucket.

---

## Structure decisions you will trip over

**A call site is an instance, not a wrapper (WS-4.2, shipped).** `<SheetShell/>`
renders SheetShell's own root — a component call emits no element of its
own — but the call site node is now KEPT, as `moduleId: 'studio.instance'`:
its literal/resolved props move to `props.callSiteProps`, and the inlined
subtree becomes its `children`. `NodeRenderer` renders it as a bare React
Fragment (`src/modules/base/instance/`) — **zero DOM elements**, so a leftover
wrapper never happens:
- percentage/flex height chains (`height: 100%` against an `auto` wrapper
  collapses the shell and every `flex: 1` region inside it to 0) — proven
  against the real corpus in a real browser, `tests/e2e/instance-fragment-node.e2e.ts`,
- `>` and `+` combinators crossing the call site.

Call-site literal props ARE now editable, as `ParsedNode.instanceOf.callSiteProps`
→ `PageNode.props.callSiteProps`, writable via the `callSiteProps:<name>`
`codeProps` convention (parallel to `style:<property>`). Detach
(`detachComponent.ts`), its refusal escape hatch (`extractComponentCopy.ts`),
and swap (`swapComponentInstance.ts`) act on the instance node — see
`docs/features/studio-import.md`'s "Detach and swap" section for the full
contract and refusal reasons.

**Imports are followed through barrels.** `resolveExportedDeclaration` walks
`export { X } from './X'` and `export * from './X'` and returns the declaring
name, so `export { Card as PlanCard }` resolves.

**The parser SELECTS one JSX-bearing `return`** — the last one, unlocked
(parser-06). Guard clauses (loading/empty/error) return early; the return
that survives every guard is the "normal" state. The others are recorded as
`label` + source `loc` on the chosen node (`ParsedNode.branchAlternatives`),
never parsed into nodes — cheap, addressable, not rendered. A `return null`
guard contributes nothing and does not count as a branch. A ternary/`&&`
inside JSX gets the same one-branch-chosen treatment (`selectJsxBranch`),
preferring the consequent / `&&`'s right side unless the condition is
statically decidable (Tier A/B), which always outranks the guess. Nothing
here is evaluated to make the choice — only a source POSITION is preferred —
so it stays outside Tier D.

**Locked nodes still show their text.** Withholding it just made nodes blank;
whether the text can be WRITTEN is `codeText`/`textOrigin`'s answer, per-prop.

**Structured props (arrays/objects) reach components only** — an HTML attribute
is a string. A function entry is dropped, never stubbed. One unresolved array
item declines the whole array. A structured value records no `Resolution`, so it
does **not** lock the node.

---

## Element → module mapping

`resolveModuleId` in `server/handlers/studio/moduleMapping.ts`:

| Source | moduleId |
|---|---|
| `kind: 'component'` | `alm.<Name>` |
| `div/section/main/header/footer/nav/article/aside` | `base.container` |
| `img` / `a` | `base.image` / `base.link` |
| anything carrying resolved SVG markup, or `svg` | `base.svg` |
| any tag **with element children** or **with no text** | `base.container` |
| `button` with text, no children | `base.button` |
| a `TEXT_HTML_TAGS` tag with text, no children | `base.text` |
| anything else | `base.container` |

`base.text` and `base.button` are **leaves** (`canHaveChildren: false`) and render
a hardcoded "Text"/"Button" placeholder when empty — right for hand-authored
pages, pure noise on imported ones. Every tag-bearing module keeps its real host
tag or the element is silently rewritten.

---

## Known non-imports (deliberate)

CSS-in-JS beyond the TEMPLATE forms (`styled.x`/`styled(X)`/emotion `css` DO
extract statically — `cssInJsExtract.ts`, W4-4 Phase A, read-only, no writeback;
stitches, emotion object styles, and a `ThemeProvider`-only theme value do not)
· Transform effects (`applyTokens(svg)` loops — falls back to the markup handed
in) · `.map` over props/state/fetch data · a multi-stage screen shows only the
LAST stage by default (the others are addressable via `branchAlternatives`,
not rendered — parser-06) · computed `className` keeps only its static prefix · linked
(`file:`/pnpm) package deps · JSX-valued props that aren't icons · only ONE
locale renders PER FRAME — the board's locale is switchable (WS-10 §4.2, a
real re-parse) but two locale variants cannot sit side by side on one board
yet (§4.4/Phase 4) · an inline `<svg>` attribute depending on state · images
behind hook state · renaming a component reference.

Full list with rationale: `docs/features/studio-import.md` §"What still does not
import". **The V2 plan turns each of these into a machine-readable finding code.**

---

## Before you change the parser

1. Read `docs/features/studio-import.md` end to end.
2. Add a fixture to `src/core/page-parser/__tests__/` — and prefer
   `genericRepoShapes.test.ts`'s discipline: a fixture that shares **nothing**
   with the eSIM corpus, because a suite grown from one repo encodes that repo's
   habits.
3. Never make the parser throw. Every failure resolves to `unresolved`.
4. If you add a resolution, decide explicitly: does it add to `codeProps`? Does
   it carry an `origin`? (It does **not** lock the node — only a STRUCTURAL fact
   about where the source places the element ever does.)
