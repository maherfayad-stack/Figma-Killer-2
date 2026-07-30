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
        2. parsePageFile() per file              page-parser/parsePageFile.ts
        3. resolveComponentSources()             componentSources.ts   local | package
        4. inlineLocalComponents()               inlineLocalComponents.ts
        5. staticEval — resolve values           staticEval*.ts        Tiers A/B/C
        6. staticLoopExpansion — .map            staticLoopExpansion.ts
        7. loadStudioStyles — .css → StyleRule   studioCss.ts
        8. parsedPageToSitePage()                studio-sync/
        9. rewriteStudioAssetSentinels()         → /admin/api/studio/asset URLs
   → editor store  →  board frames  →  iframes

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
| `locked` / `lockReason` | **Structure**: the source does not simply place this node — a `.map` generated it, a ternary/`&&` chose it, a spread feeds it, it's one of several `return`s | Cannot be moved, deleted, reordered, wrapped |
| `codeProps: string[]` | **Values**: prop names with no writable target, because the source holds an expression, not a literal. Inline styles appear as `style:<property>` | Those props are read-only; **siblings stay editable** |

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
| **A** | literals, module/cross-file consts, member chains, array indexing, template literals, operators (`+ - * / % **`, `!`, `\|\|`, `&&`, `??`), `Math.*` constants and pure fns | `staticEvalCore.ts`, `staticEvalOperators.ts` |
| **B** | `useLanguage()` → `useContext(Ctx)` → the single `<Ctx.Provider value={…}>`; unwraps `useMemo`; picks a dictionary branch by `previewLocale` and records a `note` | `staticEvalCalls.ts` |
| **C** | pure function calls in an explicit envelope: concise body, or bare `if (c) return …` / `return …`; no assignment, loop, `await`, `new`. Whitelist: `String`, `Number`, `Math.*`, `.toFixed`, `.padStart`, `.toUpperCase`, `.toLowerCase`, `.trim`, `.join` | `staticEvalCalls.ts` |
| **D** | **BANNED.** JSX branch selection, hook state, effects, async. | — |

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
| **`skipped > 0` raises a toast** | A refusal the user can't see is indistinguishable from data loss |
| **`applyStudioEdit` returning `false` counts as `skipped`** | It used to increment neither counter, so the client assumed a write happened |
| **`tag` has its own edit kind + codemod** | Routing it through `setJsxProp` added a literal `tag="section"` attribute and left the element a `<div>` — 140 fake controls on one corpus |
| **Path containment in the decoder** | `rel` arrives from the client inside `nodeId`; the save route builds `join(dir, rel)` |
| **`loadSite` keeps the currently-open page** when the incoming site still has its id | Resetting to home mid-edit reads as the canvas moving on its own |

Codemods live in `src/core/ast-codemods/` and preserve the file's quote style
and formatting. Edits apply **bottom-to-top** so earlier writes don't shift
later line numbers.

---

## Structure decisions you will trip over

**A call site is replaced, not wrapped.** `<SheetShell/>` renders SheetShell's
own root — a component call emits no element of its own. `spliceReference`
replaces the call-site node. A leftover wrapper silently breaks:
- percentage/flex height chains (`height: 100%` against an `auto` wrapper
  collapses the shell and every `flex: 1` region inside it to 0),
- `>` and `+` combinators crossing the call site.

The cost: call-site literal props are not editable as a node. *(WS-4 of the V2
plan fixes this with a fragment node that renders zero DOM.)*

**Imports are followed through barrels.** `resolveExportedDeclaration` walks
`export { X } from './X'` and `export * from './X'` and returns the declaring
name, so `export { Card as PlanCard }` resolves.

**Every JSX-bearing `return` renders**, all locked. Choosing a branch is Tier D.
A `return null` guard contributes nothing and does not lock the screen.

**Locked nodes still show their text.** `locked` carries the "not editable"
meaning; withholding text just made nodes blank.

**Structured props (arrays/objects) reach components only** — an HTML attribute
is a string. A function entry is dropped, never stubbed. One unresolved array
item declines the whole array. A structured value records no `Resolution`, so it
does **not** lock the node.

---

## Element → module mapping

`resolveModuleId` in `studioPageLoad.ts`:

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

Transform effects (`applyTokens(svg)` loops — falls back to the markup handed
in) · `.map` over props/state/fetch data · multi-stage screens render every
stage stacked · computed `className` keeps only its static prefix · linked
(`file:`/pnpm) package deps · JSX-valued props that aren't icons · only the
`previewLocale` branch · an inline `<svg>` attribute depending on state · images
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
4. If you add a resolution, decide explicitly: does it **lock** the node? Does it
   add to `codeProps`? Does it carry an `origin`?
