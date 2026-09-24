# Studio pipeline — parse, resolve, render, write back
> **Purpose:** the repo-to-board pipeline: parse, evaluate, inline, lock, write back · **Read when:** touching parsing, evaluation, node ids or codemods · **Trust:** current · **Owner:** parser-surgeon · **Verified:** not yet

The load → edit → write loop, compressed for agents. The full, authoritative
version is [`docs/features/studio-import.md`](../features/studio-import.md)
(578 lines) — read that before making a **parser** change. This page is enough
for everything else.

---

## The loop

```
GET /admin/api/studio/load?dir=<abs>            server/handlers/studio.ts
   └─ loadStudioPages()                          studioPageLoad.ts
        0. workspace fingerprint memo (W9-5)     studio/studioLoadMemo.ts
           Whole-result memo per `dir`, keyed on a `relPath:size:mtimeMs`
           signature of every source-relevant file (plus `.studio/meta.json`,
           which `listWorkspaceFiles` excludes). A hit skips steps 1-9
           entirely: ~26 ms → ~2.5 ms on a 36-page project, which is what an
           agent turn's 4+ redundant loads used to cost. A narrowed load
           (`options.pageIds`) runs the same full compute, stores it, and
           filters `pages` on the way out.
        0b. kept ts-morph Project per dir          studio/workspaceProject.ts
           `withWorkspaceProject(dir, fn)` — ONE `createWorkspaceProject`
           per project directory for the life of the process, synced to the
           disk before every use (a moved `size:mtimeMs` re-reads that file,
           new files are added, deleted and in-memory files removed) and
           serialized per dir so a sync never forgets nodes under a parse in
           flight. Any change also calls `resetParserCaches()` (the four
           cross-file memos in `@core/page-parser`). This is what took the
           resync after a structural write from 1.5–2 s to ~50–100 ms on a
           real project: rebuilding the Project re-parsed and re-bound every
           file for one changed line. Rebuilding it per call again is the
           regression to refuse. A moved `tsconfig.json` stamp REBUILDS it
           (aliases are read once, at construction); an unparseable one
           builds without it and reports `tsconfig-unreadable` (WB-23).
        1. discoverPageFiles(pagesDir)           studioProjects.ts
        1b. discoverStories + buildStoryRouteEntries
                                                 studio/story{Discovery,Pages}.ts
            W5-3 — Storybook CSF becomes extra route entries. Gated on a
            filename glob, so a project with no `*.stories.*` pays nothing.
            Accepted subset + the named refusals + measured acceptance
            rates: studio-import.md §"Storybook stories as pages".
        2. parsePageFile() per file              page-parser/parsePageFile.ts
        3. resolveComponentSources()             componentSources.ts   local | package | design-system
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

`GET/POST /admin/api/studio/framework` carries TWO editor-owned settings bags,
not one (`studio/sidecarSync.ts` owns the client end): `settings.framework` →
`.studio/framework.json`, and `settings.fonts` → `.studio/fonts.json` (the
installed font library). In a POST body each field is OPTIONAL and an absent
field means "no change of that kind" — never "clear it", which would delete the
user's font library on any save that merely didn't touch it. Before this, fonts
had no persistence at all: installing a font mutated the store and nothing
else, so the family picker's "Installed fonts" group was empty again on the
next load.

POST /admin/api/studio/save  { dir, edits: StudioEdit[], expect?: { [nodeId]: fingerprint } }
   └─ studioEditLocation()  → { rel, line, col }  (split composite id, keep TAIL)
   └─ findMovedEdits()      → element-moved refusals, BEFORE any write (P1-A)
   └─ applyStudioEdit()     → one ast-codemod per edit; every decline → a NAMED refusal (WB-12)
   → { written, skipped, shifted, sharedComponents, refusals, fingerprints, … }
      `refusals` is COMPLETE: an edit wrote exactly when no refusal names its
      (nodeId, kind, prop). `skipped === refusals.length`. See `studioEditRefusals.ts`.
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

**A second reader mints the same ids (Track L, `live-03`).** `buildSourceNodeId`
and `toRuntimeStampId` (also `sourceNodeId.ts`) and `classifyJsxTagKind`
(`jsxTagKind.ts`, same folder) are the parser's own id-minting/tag-kind rules,
extracted so `@core/studio-runtime`'s Vite plugin — a Babel walk over one file
at a time, stamping `data-node-id` in a live dev-server frame, no ts-morph —
can mint identical ids without redefining the grammar. A Babel-only stamp can
only ever produce the PLAIN shape (no `~` prefix, no `#n` suffix), so
`liveNodeResolve.ts` resolves a live DOM element back to its real composite/
loop id by pairing the element's occurrence index among same-stamp DOM
elements against that stamp's real ids in tree order — see
`docs/features/studio-import.md`'s "A second reader of the same id grammar"
for the full contract.

---

## Element identity — a position is not an identity (P1-A)

An id says WHERE an element was when the board read the file. When the file
changes under the board — the agent's Edit tool, VS Code, `git pull`, or a
structural write still in flight — the same `line:col` names a different
element, and before P1-A a prop, text or delete edit landed on that neighbour
and reported `written: 1` (WB-1, ERR-4). Every write now says WHO it expects to
find, and the server refuses when someone else is there.

**The fingerprint.** `<label>#<8 hex>` — a `SourceFingerprintSchema` string
(`@core/page-tree`'s `sourceFingerprint.ts`, the wire half):

| Target | `label` | Hashed (FNV-1a 32, whitespace collapsed, and dropped next to `< > = { }`) |
|---|---|---|
| A JSX element | its tag as written (`li`, `Card`, `motion.div`) | the opening tag + the element's DIRECT text: its `JsxText` children and any `{…}` child with no JSX inside |
| A literal (`literal`/`asset` targets) | `literal` | the token's own text, quotes included |

Why exactly that: the opening tag alone cannot tell `<li>One</li>` from
`<li>Two</li>`, which is precisely the neighbour a shifted line lands on; the
whole subtree would change every ANCESTOR's fingerprint on every descendant
edit. With direct text only, a write changes the identity of the element it
targets and nothing else. Whitespace normalisation makes a CRLF checkout, a
re-indent or a formatter breaking a long tag hash the same.

**Minted once, by the parser.** `@core/page-parser`'s `sourceFingerprint.ts`
is the only computation: `processElement` stamps `ParsedNode.fingerprint`
(skipped on a `.map` row — its id has no writable location), `originOf` and
`importSpecifierLocation` stamp `ValueOrigin.fingerprint`, and
`parsedPageToSitePage` carries them to `PageNode.sourceFingerprint` and the
origin objects. The guard reads a position back through
`@core/ast-codemods`' `readSourceFingerprintAt`, which calls the SAME two
functions — a guard that hashed differently would refuse every write.
`sourceFingerprint.test.ts` pins "parser and guard agree at every node".

**The wire.** `POST /save` takes `expect: { [nodeId]: fingerprint }` for any id
an edit names (`nodeId`, `anchorNodeId`, `parentNodeId`, `siblingNodeIds`);
MCP `studio_apply_edits` takes the same field, and `studio_find_nodes` returns
`sourceFingerprint` per match so an agent can send it. Per-id opt-in: an id
with no entry is not checked. The response adds `fingerprints: [{ nodeId,
fingerprint }]` — each landed VALUE edit's target identity AFTER the write.

**The server** (`studioEditIdentity.ts`): `findMovedEdits` reads every named
position BEFORE the batch writes a byte (a prop and a style edit on one element
must not see each other's write as a move) and refuses a mismatch — or an empty
position — with reason `element-moved` (`ELEMENT_MOVED_REASON`), which never
reaches a codemod. `fingerprintAfterWrite` measures a value edit's target right
after that edit, before any edit above it runs, so the original id stays the
right key.

**The client** (`sourceIdentity.ts`) keeps a table: source LOCATION (the id's
tail) → a MUTABLE record. `usePersistence` (and the MCP live-reload path)
feeds it on every board read (`noteBoardRead`: `reset` for a full load,
`merge` for a narrow patch, which drops the files' old positions). A writer
CAPTURES records; `postEdits(edits, identities)` sends their current values as
`expect` and writes the response's `fingerprints` back INTO the captured
records. That object identity is the point: Studio's own value write updates a
capture in place (so a structural gesture captured before a flush that wrote a
prop to the same element still posts the truth), while a re-read REPLACES
records (so a capture taken before a resync still describes the element the
user acted on). Captured at: `commitStructural` entry (the gesture's own
moment), `saveSite` (the diff's moment), `postOneEdit` (a click), and
`deferWhileStructuralCommitInFlight` (see `editor-store.md`).

**Recovery, never an error** (`elementMovedRecovery.ts`). An `element-moved`
refusal re-reads the touched files, waits until the board actually has them
(`waitForBoardRead` — narrow patch or full load), re-finds every named element
by its captured identity (`relocateCapturedIds`: same position, else exactly
ONE match in the same file, else nothing), and re-posts once through the
writer's own path — `commitStructuralBody` again (`replanned: true`), the
autosave's own `postEdits` followed by a resync, or a one-shot's `postEdits`.
Only a second miss is shown: one `warning`, "Not saved — the file changed".

**What is not guarded yet:** `css` (a file + selector, no position) and
`styled` (its template location travels in `styledStyleRuleSources`, not on a
node).

**Re-location (P1-D).** A mismatch is not refused straight away. The server
keeps the last few texts of every file a parse read or a write batch touched
(`sourceTextHistory.ts`); `studioEditRelocate.ts` takes the ones in which the
expected element sits at the id's position, maps the line through a line diff
to the file now (`sourceLineMap.ts` — the earliest AND latest optimal
alignments, column carried across a re-indent), and re-reads the fingerprint
at each proposed position. Exactly one match → the edit is re-addressed there
(`withSourceLocation`) and runs; the response lists it in `retargeted` and
sets `shifted`, and every other field still reports under the id the caller
sent. None or two → `element-moved` exactly as before, and the board's own
recovery above takes over. No history (a server restart) is the same refusal.

**Noticing outside edits (P1-D, ERR-19).** `projectWatch.ts` watches the open
project (retained by the editor bridge stream) and tells Studio's own writes
from everyone else's by whether a file's `mtime` falls inside a project
write-lock hold. An `outside` change to a board input is pushed down the
bridge as `studio_live_reload` with `diskChanged: { files }`; the tab saves
anything pending first (so those edits are re-found server-side), then calls
`resyncBoardAfterWrite(files)` — the same narrow-or-full re-read Studio's own
writes use, which P1-B's follower then maps the selection through.

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

**Every file a value is read out of is reported** (WB-2) into
`StaticEvalOptions.readFiles`, and the load adds it to the route's parse-cache
dependency set. A memo hit replays the files its entry read (`collectReads`,
`evalReadFiles.ts`). A new memo in the evaluator must do the same, or the
second page to read a dictionary never records the module behind it.

---

## Writeback rules

| Rule | Why |
|---|---|
| **Never write a resolved value back as a literal** | `title={c.sheetTitle}` → writing `"Where to?"` deletes the binding. The client's `codeProps` guard declines to send it, AND `setJsxProp` refuses `binding-overwrite` on any initializer that is not a string/number/boolean literal (WB-11) — the server is the boundary every writer, agent included, crosses |
| **Resolved TEXT and origin-backed PROPS are the exception** — they write to `textOrigin` / `resolvedProps[k].origin` | The dictionary entry is an ordinary string literal at a known `rel:line:col`. Emitted as `kind:'literal'` by `nodeDiffWriteback.ts`, before its location guard, for flat props and an instance's `callSiteProps:<name>` alike. P3-C (WB-6): text or a prop a component is HANDED carries the call site's own literal as its origin (`ParsedNode.literalPropOrigins` → `Substitution.origin`), so `<Header title="Where to?"/>`'s `<h2>{title}</h2>` writes the call site, never the component's `{title}`. No origin for a component default, a literal on a call site inside a `.map` row, a computed value, or a numeric literal |
| **A new class's stylesheet is chosen, never asked** (P3-C, ERR-14/15, `cssInsertDestination.ts`) | Co-located with its page, else the only one, else ranked (global over module, last written, nearest, largest, alphabetical — remembered per rule), else created beside the page, else `studio.css` beside the app entry (server, `cssCreateImportTarget`) |
| **Reload only when `written > 0`** | A reload re-parses and replaces the document. With zero writes it overwrites the user's in-memory edit — the change reverted itself ~2 s after typing |
| **A reload is NARROW by default** | `shifted`/`sharedComponents` used to mean a full `loadSite()`; on an App Router board, shared layout chrome makes `sharedComponents` the common case, so every save reparsed all forty pages. `resyncBoardAfterWrite` (`studioBoardResync.ts`) asks `/reload-scope` which pages the touched files feed and patches only those. It widens whenever it cannot prove the scope — narrowing may never UNDER-reload |
| **A save's resync runs LAST** | It rewrites the same diff baselines `saveSite` advances after its POST; running it inline lets the save's own commit overwrite the fresh disk baseline with the pre-reload document |
| **Every edit that does not write is a named refusal** (WB-12, `studioEditRefusals.ts`) | The old anonymous "unexplained skip" became one red "Some changes were not saved" blaming the wrong cause. Now: `mixed-children`, `element-moved` (a locate miss — the board re-reads and retries it silently), `component-tag`, `not-a-literal`, `spread-attribute`, `no-source-location`/`stylesheet-unavailable`/`asset-unavailable` (an `applied: false` outcome), `write-failed` (an exception nobody named; logged server-side). The sentence is written from the reason, never the codemod's message, which carries an absolute path |
| **Baselines commit PER EDIT** (WB-35, `editOutcomes.ts`) | The response used to carry only aggregate counts, so one refused edit held back — and re-sent on every save — the whole batch. Each bump carries its edit's outcome key; the landed ones advance, the refused ones stay in the diff |
| **A save-time refusal is a WARNING with its remedy** (WB-13, `refusalToasts.ts`) | One card per (kind, target, reason) per session, with "Open in code" when the refusal names a source position. Never `kind: 'error'` — the editor declined a write it could not make honestly; nothing broke. Gated by `error-toast-sites.test.ts` |
| **`tag` has its own edit kind + codemod** | Routing it through `setJsxProp` added a literal `tag="section"` attribute and left the element a `<div>` — 140 fake controls on one corpus |
| **Path containment in the decoder** | `rel` arrives from the client inside `nodeId`; the save route builds `join(dir, rel)` |
| **`loadSite` keeps the currently-open page** when the incoming site still has its id | Resetting to home mid-edit reads as the canvas moving on its own |
| **Two instances' `style`/`class` edits MERGE** (WB-7, `studioEditMerge.ts`) | Every instance of a shared component writes to one `line:col`; keeping the last dropped the other instance's declarations/tokens while `written` reported both. A genuine conflict (one prop, two values) is still last-wins, and a merged edit's refusal is reported for every instance behind it |
| **A file that does not parse is never written** (WB-24, `studioSyntaxGuard.ts`) | TypeScript recovers a tree from a broken file; a codemod would locate and splice into a guess. Refused as `syntax-error`, naming the line; the load flags the page in `warnings` |
| **A `literal` edit is shared** | A dictionary key is shared by design; the resync narrows to the routes that recorded the origin file (WB-2) |
| **A write keeps the file's line endings** | The user's repo may be a CRLF checkout (Git's Windows default). `EolPreservingFileSystem` (`@core/page-parser`) hands ts-morph LF-only text and re-applies the file's own ending on write; the CSS codemods do the same at their text boundary. Formatting-preserving includes `\r\n` |

Codemods live in `src/core/ast-codemods/` and preserve the file's quote style
and formatting. Edits apply **bottom-to-top** so earlier writes don't shift
later line numbers.

**Line endings are decided in exactly one place** (`parser-13`). Every
disk-backed ts-morph `Project` Studio opens — `createProject()`
(`ast-codemods/locateJsxElement.ts`), `createWorkspaceProject()` and
`parsePageFile`'s default (`@core/page-parser`) — reads through
`EolPreservingFileSystem` (`src/core/page-parser/eolFileSystem.ts`), which
normalises to `\n` on the way in and restores the file's dominant ending on the
way out. That is what makes a CRLF checkout parse to a **byte-identical page
tree** — `line:col` is unaffected by `\r` either way (TypeScript counts `\r\n`
as one terminator and the `\r` sits after every token on its line), but a
resolved VALUE read out of a multi-line template or JSX text block would
otherwise carry `\r` on Windows and not elsewhere. The pure-string primitives
are `@core/utils/lineEndings` (`detectLineEnding`, `toLf`, `applyLineEnding`,
`splitLines`); anything that reads a user file line-wise uses `splitLines`,
never `text.split('\n')` — in a JS regex `.` does not match `\r` and a non-`m`
`$` only matches end-of-input, which is how a CRLF markdown doc silently parses
to zero headings.

---

## Structural writeback (`struct-01`)

`StudioEdit` used to carry value kinds only (`prop | text | style | literal |
tag | asset | detach | swap | css`). A move, delete, insert, duplicate or wrap
therefore reached **no** code path at all: the tree changed, the save reported
success, the `.tsx` was untouched, and the change was gone on reload. In Studio
the repository IS the document, so that was a silent no-op.

Nine kinds now exist — **`move`** and **`reparent`** (`moveJsxElement`, whose
destination-parent form is W4-1's), **`delete`** (`deleteJsxElement`),
**`insert`** (`insertJsxElement`), **`duplicate`** (`duplicateJsxElement`),
**`wrap`** (`wrapJsxElement`), K3's **`group`** (`wrapJsxElements` — ONE
container around a contiguous run of siblings, ⌘G) and **`ungroup`**
(`unwrapJsxElement` — the container goes, its children take its place, ⌘⇧G),
and D2 G3's **`transplant`** (`transplantJsxElement` — a move whose two ends
are in two different FILES, the write behind dragging an element from one board
frame into another) — and everything else refuses out loud.

**`transplant` is the one kind whose destination is deliberately in another
file**, which is why it has its own server entry (`applyTransplantEdit`) rather
than a branch of `applyStructuralEdit`: that function's second and third
locations are `{ line, col }` pairs only meaningful alongside `loc.file`, and
widening them would make eight same-file kinds read as if they might not be.
`transplant` is excluded from its parameter TYPE, so a misrouted one does not
compile. Its destination id still goes through `studioEditLocation`, which is
where the containment and app-source guards live — only the same-file FILTER is
skipped. The batch's touched-file set gains the destination (or `shifted` would
lie about the file the element landed in), and the existing post-batch import
prune covers a transplant that MOVES, because it orphans an import in the
origin exactly as a delete does; the destination's freshly carried import is
never snapshotted and therefore can never be pruned.

**The same-file refusal is on the REAL path, not on the two strings**
(`sec-17`). `studioEditLocation`'s guard is lexical — it rejects `..`, absolute
paths, drive letters and non-source extensions, but it has no opinion about two
`rel`s that name one file: a case difference on a case-insensitive filesystem,
or a symlink/junction of the kind git itself stores in an imported repo. If
such a pair reached the codemod it would load them as two independent ts-morph
source files, write the destination's spliced text, and then overwrite the
whole file with the origin's — the pre-edit text with the element **cut out**.
The markup would be deleted from the user's repository, land nowhere, and the
batch would report `written: 1`. `transplantJsxElement` therefore compares
`realpathSync.native` of both ends.

**What travels with the markup.** `transplantJsxElement` partitions the
subtree's free variables (`analyzeFreeVariables`): a name the ORIGIN file
resolves at module scope is CARRIED as a mirrored import — following a relative
specifier to the file it actually names and re-resolving it against the
destination's own location, and keeping the style the user wrote it in (a
default import is not re-spelled as a named one). Anything body-local to the
origin's component refuses as **`captured-scope`**, by name. Both files' next
contents are computed in full before either is written, so a refusal leaves two
untouched files and a success writes two complete ones.

**None of them mints a node; all of them ask the SOURCE to grow one.** Adding a
design-system component from the picker writes `<Button … />` *and* the `import`
that names it into the user's file, then reloads the board — so what appears on
the canvas is an ordinary parsed node with a real `rel:line:col`, not a nanoid
the editor invented. W4-1 generalised that write-then-re-read shape to the last
three Figma verbs, which is why they stopped refusing: a duplicate is the
element's own bytes written in again, a wrap replaces its range with itself
inside a container, and a reparent splices its bytes into a different parent in
the same file. **K2 gave `duplicate` a second form**: with a `parentNodeId` the
copy lands INSIDE that container instead of beside the original (Alt+drag),
through the same `jsxChildPlacement` resolver an insert and a reparent use.
That form answers the questions a reparent answers — `cross-file`,
`into-own-descendant`, `out-of-scope` — and a plain in-place duplicate still
answers none of them. The module declares its own source spelling via
`ModuleDefinition.sourceImport` / `sourceIntrinsic`, so nothing in the store is
coupled to a particular design system. The plugin/agent dispatcher
(`applyTreeOperation`) still refuses — `refuseMintedNodeInsert` for an insert,
`refuseMintedNodeCopy` for a duplicate/wrap/group/ungroup/reparent — because those callers
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
| `reparent` | no container to write into, or one that is not an ordinary element. An in-place `duplicate`/`wrap` carries no refusal of its own beyond the four above; a `duplicate` WITH a destination (K2's Alt+drag) asks the reparent question about that destination too |
| `multi-select` | several elements REORDERED or REPARENTED at once, or a WRAP of several (one wrapper spanning N ranges). A multi DELETE or in-place DUPLICATE is fine — the batch is ordered bottom-to-top. A GROUP (K3) of several is fine too, and this is the refusal it gets when the selection is not one run: different parents, or a gap between the members. A multi Alt+DRAG is not: N copies at one drop position have no single order in the code (`planSourceDuplicateTo`) |
| `group` / `ungroup` | K3's members of the "this caller cannot write" family (`refuseMintedNodeCopy`), plus a group whose members mix imported markup with canvas-only nodes |
| `has-behaviour` | K3, AST-decided: the container being ungrouped carries something other than `className`/`style`/`id`/`data-*` (a handler, a `ref`, a `key`, a spread), or it is a COMPONENT rather than an intrinsic element. Removing it would drop behaviour, so the remedy is to open it in code |
| `content-model` | `struct-11`: the container a group would write cannot legally sit where it would land (`<div>` in a `<p>`, anything in a `<ul>`/`<tr>`/`<select>`) or cannot legally hold what it would hold (a wrapper around an `<li>`, a `<td>`, a `<figcaption>`). Decided from `@core/utils/htmlContentModel` — early by `previewStructuralGroup` when the tags are nameable, and always by the codemod against the AST. The remedy is the jump: `origin` is the CONTAINER whose content model forbids it |
| `cross-file` / `no-sibling-anchor` | a reorder is written as "put this before that one", so it needs a plain sibling in the same file; a reparent needs its new parent in that file. **A drag ACROSS frames is not this** — it is a `transplant`, which is allowed, and whose own tree-level rule is `previewStructuralTransplant` (`sourceStructureTransplant.ts`): the four placement reasons on BOTH ends, one element at a time, an honest destination container, and a backstop refusal when the two frames turn out to be two views of one file |

The AST adds the refusals only it can answer: `not-siblings`,
`expression-child` (the element comes out of `{cond && <X/>}`, so its position
is decided at runtime — and, for a group, something the code decides sits
between the members), `mixed-indentation`, `no-jsx-parent` (it is what the
component returns), `stale-source`, `into-own-descendant`, K3's
**`not-contiguous`** (an element the user did not select sits inside the span a
group would wrap) and **`has-behaviour`**, and W4-1's
**`out-of-scope`** — a reparent whose markup reads a binding that does not exist
where it would land (`subtreeFreeVariables.ts`; the refusal names the
variables). It is a static scope walk over the declarations enclosing the
destination, never an evaluation of any of them. D2 G3 adds the two a
CROSS-FILE move can answer that a same-file one cannot: **`captured-scope`**
(the markup reads a binding local to the component it is leaving, so there is no
module the other file could import it from) and **`binding-conflict`** (the
destination already means something else by a name the move would carry).
`sec-17` adds a third: **`unexported-binding`** — the markup reads a helper or
a local component the origin file DECLARES but does not export, so the mirrored
import the destination would receive resolves to nothing. Writing it anyway
(the earlier behaviour, on the reasoning that the compiler would say so) leaves
the markup gone from one file and a broken import in the other, with no undo
entry for either — so it refuses and names the export to add.

**A refusal reaches the user as an `EditConstraint`, never a bare string.**
`describeStructuralRefusal` (`src/core/page-tree/editConstraint.ts`) dresses
the rule's `{reason, message}` with the two things a person needs next: the
`origin` (`rel:line:col`) the refusal traces to, and its `actions` — zero or
more named ways forward. Every surface renders that one object:

| Surface | What it shows |
|---|---|
| Refusal toast/dialog (`presentStructuralRefusal`, née `toastStructuralRefusal`) | `constraint.actions` empty → the old persistent toast (`durationMs: null`), deduped by gesture + reason + sentence, with a jump to `origin` as its button. Non-empty → a modal `RefusalDialog` instead (`store-10`, R2), with real buttons for every runnable action; `detach`/`extract` additionally re-issue the original gesture once their reload lands (see `editor-store.md`) |
| Layers context menu | Disabled item + tooltip, plus a `ConstraintNotice` footer carrying `origin` and `actions` |
| Canvas drag | The explanation as a chip beside the refused drop rect, while the pointer is still down (`explainGestureConstraint` → `canvasDnd.ts`'s `invalid.constraint`) — untouched by R2, deliberately: a modal mid-drag would be worse than the inline chip |

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

**A group is written around a SPAN, an ungroup replaces one.** `wrapJsxElements`
takes the run's endpoints and replaces the bytes between them with themselves
inside one new element — so a comment, a blank line or the text between two
inline tags travels verbatim, because it is inside the span rather than
something the codemod re-renders. It refuses (`not-contiguous`) when the
parent's element children between the ends are not exactly the ones named, and
(`expression-child`) when an expression container sits between them. ⌘G on ONE
element is not this kind: it is the existing `wrap`, unchanged. `unwrapJsxElement`
is the inverse — the children, dedented one level, replace the container's own
range.

**The container's TAG follows the HTML content model** (`struct-11`). It used
to be whatever the caller named, and every caller named `div`
(`base.container`'s `sourceIntrinsic`) — so grouping two inline `<span>`s that
live inside a `<p>` wrote a `<div>` into phrasing content and React reported it
in the user's own console as a hydration error. Studio broke the file it was
editing. The rule is now one table,
`@core/utils/htmlContentModel.ts` — element categories (phrasing / flow /
`positional` / metadata), what each element may contain (void and text-only
elements hold nothing; `a`/`ins`/`video`/… are *transparent* and resolve by
walking up; `ul`/`tr`/`select`/`picture`/`dl` name their own legal children) —
and one decision, `chooseGroupWrapperTag`:

- `div` and `span` are the two interchangeable containers, so a caller naming
  either is asking for "a box" and gets whichever is legal. Any other name
  (`section`, a component) is the caller's own choice: it is CHECKED, never
  re-spelled, and refused if it cannot sit there.
- An all-phrasing run gets a `<span>` wherever one is legal, so a group keeps
  flowing with the text it replaced instead of becoming a block.
- `<dl>` is the one restricted parent HTML lets a `<div>` group inside, and it
  still takes one.

Asked TWICE, from two fact sources, with one rule. `wrapJsxElement` /
`wrapJsxElements` read the real ancestors and members out of the AST
(`wrapperContentModel.ts`) and are the AUTHORITY — nothing else can stop an
agent or a hand-built batch. `previewStructuralGroup` asks the same question
off the page tree first, through an injected `nodeHtmlTag` resolver (the tag
lives in the module registry, which `@core/page-tree` may not import), so an
impossible group refuses BEFORE the round trip, with a dialog and a way
forward. A resolver that cannot name a tag returns `null`, which is read as "no
opinion" and never as a refusal — the early check only ever refuses on positive
knowledge.

**A reorder is written against an ANCHOR, never an index.** The editor's child
list and the JSX child list are different lists. `planSourceMove` simulates the
move, finds the neighbour the node lands beside, and sends
`{ nodeId, anchorNodeId, position }`.

**Byte-exactness.** These codemods use the AST only to LOCATE; the write is a
splice of the original bytes (`jsxChildRange.ts`), and it refuses outright if
the text on disk differs from the text ts-morph parsed. An AST rewrite that
reformats an untouched sibling is a defect.

**The four that CREATE also say where (`store-13`).** `insertJsxElement`,
`duplicateJsxElement`, `wrapJsxElement` and `wrapJsxElements` return
`created: { line, col } | null` alongside `ok: true` — the new element's own
tag-name position, derived from the byte range they spliced
(`createdJsxLocation.ts`) and then VERIFIED by re-locating an element there in
the re-parsed file. `null` means "written, but the position could not be
confirmed", which is deliberately not a guess: a wrong id would select, and let
the user edit, something they never made. `applyStudioEditBatch` mints
`createdNodeIds` from them; see `editor-store.md` for what the board does with
that, and for why the batch pins each one to its distance from the end of the
file rather than to an absolute line.

`store-14` adds the mirror for markup a write MOVED rather than made:
`moveJsxElement` returns `relocated: { line, col } | null` and
`unwrapJsxElement` returns `relocated: { line, col }[]` (an ungroup hands
several children back at once), derived and verified the same way. The batch
mints `relocatedNodeIds` from them. A `transplant` reports through `created`
when it copied and `relocated` when it moved — the two have different undos.
Both id lists are on the `/save` response.

**Commit shape.** Structural edits are one-shot commits
(`commitStudioMoves` / `commitStudioDelete` / `commitStudioDuplicate` /
`commitStudioGroup` / `commitStudioUngroup` / … in
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
`export { X } from './X'`, `export { default as X } from './X'` and
`export * from './X'` and returns the declaration NODE (P3-B — a default export
may have no name to re-find it by), so `export { Card as PlanCard }` and an
anonymous `export default memo(…)` both resolve. A namespace member
(`<UI.Card/>`) follows the same graph; a member tag on a default/named import
(`<Card.Header/>`) is declined, never rendered as `Card`. The barrels on the
route are recorded as the route's dependencies (`CallTarget.via`).

**`memo`/`forwardRef` are the function they wrap** (`getFunctionLikeNode`,
`componentDeclaration.ts`) — only React's own, by import provenance
(`reactImports.ts`). **`<Fragment>`/`<React.Fragment>` is a fragment.** A PAGE
also renders from a class's `render()` or through an unknown HOC (with a note);
any other default export is named in an `unreadable-page-export` load warning
that the frame shows instead of "This page is empty". Full contract:
`studio-import.md` § "A page's default export".

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
| `kind: 'component'`, source `design-system` (resolves inside `<root>/design-system/`) | `alm.<ExportName>` — the built-in design system, a **black box**: never inlined, its CSS never enters `site.styleRules`, its folder never searched for pages/components/assets. See `studio-import.md` §"Local-component inlining". |
| `kind: 'component'`, source `package` | `pkg.<sanitized-package>.<Name>` — every package, no carve-out for any specifier |
| `kind: 'component'`, unclassified (no import, no same-file declaration) | `alm.<Name>` — renders "Unknown module", the honest outcome |
| `img` / `a` | `base.image` / `base.link` |
| anything carrying resolved SVG markup, or `svg` | `base.svg` |
| any tag **with element children** or **with no text** | `base.container` |
| `button` with text, no children | `base.button` |
| any `isTextHostTag` tag with text, no children (`div`, `li`, `label`, `td`, `section`, …) | `base.text` on its own tag — `tag: 'custom'` + `customTag` outside the named list (P3-B, WB-3) |
| anything else (`textarea`, `option`, `title`, `style`, …) | `base.container` |

`base.text` and `base.button` are **leaves** (`canHaveChildren: false`) and render
a hardcoded "Text"/"Button" placeholder when empty — right for hand-authored
pages, pure noise on imported ones. Every tag-bearing module keeps its real host
tag or the element is silently rewritten.

---

## Known non-imports (deliberate)

CSS-in-JS beyond the TEMPLATE forms (`styled.x`/`styled(X)`/emotion `css` DO
extract statically — `cssInJsExtract.ts`, W4-4 Phase A; a declaration's VALUE
writes back into the template (`setStyledDeclaration.ts`, Phase B) and everything
else about a styled rule refuses by name;
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
