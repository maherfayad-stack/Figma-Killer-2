# Status — STUDIO-ESIM-IMPORT-PLAN implementation

**As of 2026-07-28.** Companion to `STUDIO-ESIM-IMPORT-PLAN.md`.

**Headline: all nine sections complete, plus four rounds of browser dogfooding.**
Rounds 1-3 found nine defects the green gates had missed, the largest structural:
a phantom wrapper div at every component call site, and `.map` lists never being
expanded. Round 4 closed the five gaps that snapshot listed as remaining, all of
which came down to the same thing — the parser throwing away content it had
already read.

Read [Round 4](#round-4--closing-the-five-remaining-gaps) first; it is the current
state. [Round 2 findings](#round-2--what-three-more-passes-in-a-browser-found) is
the history behind it.

---

## Where the code is

| | |
|---|---|
| Branch | `feat/alm-figma-killer-studio-shell` |
| Head | see `git log` — Round 4 lands as one commit on top of `36c6bac` |
| Working tree | Clean (apart from the `design-system` submodule, which is not ours) |

Four commits land the remaining work:

```
062545a fix(staticEval): close Tier B provider tracing and stop caching truncated results
83dac66 feat(studio): import a workspace's CSS as style rules and classIds
347a9c5 refactor(siteImport): extract CSSOM acquisition out of cssToStyleRules
f6b2692 fix(studio): four import-fidelity defects found by driving the board in a browser
```

---

## Section-by-section

| § | Scope | State |
|---|---|---|
| **§1** | Configurable page source (`pagesDir` meta, `.jsx` discovery) | ✅ |
| **§2** | Local-component inlining (2a→2d) | ✅ |
| **§3** | `<svg>` raw capture → `base.svg` | ✅ |
| **§4** | Context-aware element→module resolution | ✅ (extended — see below) |
| **§5** | Local asset serving | ✅ |
| **§6** | CSS imports → StyleRules + classIds | ✅ |
| **§7** | Static value resolution (tiers A→B→C) | ✅ — plus bounded `.map` expansion, which the plan had filed under the Tier D ban ([why](#round-2--what-three-more-passes-in-a-browser-found)) |
| **§8** | Validation on eSIM | ✅ static, and in a real browser across **four** passes |
| **§9** | Verification gate + docs | ✅ `docs/features/studio-import.md` |

---

## §7 — Tier B, and the bug behind it

Tier B was red on two tests. The stated cause (provider tracing) was real but
was one of three defects, and the third was the dangerous one.

1. The provider's `value` expression was evaluated with `EMPTY_LOCALS`, so the
   near-universal `value={value}` shape — a `const` in the provider component's
   body — never resolved. Scope now comes from the enclosing function.
2. `useMemo` was only unwrapped when written inline in the `value` attribute,
   not when reached through an identifier. Moved into the shared call
   dispatcher: any `useMemo(() => X, deps)` evaluates as `X`.
3. **`maxDepth` conflated data nesting with binding hops.** A realistic i18n
   dictionary reached through an alias (`const c = t.bookingConfirmation`) blew
   the limit of 12. Object/array members now evaluate at the literal's own depth
   — finite source text cannot diverge — and the default is 24.

**The order-dependence was the real hazard.** A depth-truncated `translations`
object was written into the module-const memo, so every page parsed *after* the
first one read back a dictionary whose leaves were all `unresolved`. Whether any
copy appeared at all depended on which screen happened to be parsed first.
Guard trips now mark `Budget.truncated`, and neither the module-const nor the
provider-trace cache stores a truncated result. The provider cache is also keyed
by `preferredKey` (it decides the locale branch) and guarded against a provider
that reads its own hook.

Corpus result: **188 resolved nodes, identical in either parse order.**
"Hi Muhammad", "Your booking is confirmed", "Almosafer Points", "Round-trip |
RUH to CAI" all render. §7.9's acceptance criterion is met.

### §7 cost (§7.9's measurement)

| | createWorkspaceProject | parse + inline | first page | remaining 14 |
|---|---|---|---|---|
| evaluator off | 64 ms | 812 ms | 761 ms | 51 ms |
| evaluator on | 57 ms | 764 ms | 700 ms | 64 ms |

The evaluator costs ~13 ms across 1081 nodes. The ~760 ms first-page cost is
cold ts-morph module resolution and is present with the evaluator **disabled**
too — the previous status doc's 102 ms §2 baseline was measured on a warm
project, so this was never a §7 regression.

---

## §6 — imported CSS

`collectEntryStylesheets` + `collectPageStylesheets` (`@core/studio-sync`) decide
which files and in what order; `server/handlers/studioCss.ts` parses them through
the existing `cssToStyleRules` engine and maps `className` → `classIds`.

Three decisions worth knowing:

- **`GlobalWindow`, not `Window`.** Bun has no CSSOM, so happy-dom's constructor
  is injected via a new `CssToStyleRulesOptions.sheetConstructor`. It must be
  `GlobalWindow` — happy-dom's CSS parser reports selector errors through
  `this.window.SyntaxError`, and with a plain `Window` *every* stylesheet fails
  with "undefined is not a constructor". Injection rather than assigning browser
  globals onto a long-lived server process.
- **Deterministic ids** — `sc-${sha1(kind|name)}`, not `nanoid()`. Studio reloads
  the whole site document on reload and on a `shifted` save; random ids would
  churn selection, undo, and every `classIds` entry on every load.
- **CSS is one-way.** There is no writeback codemod. An edit in the CSS Classes
  panel is lost on the next reload. Documented in the feature doc rather than
  left for a user to discover by losing work.

Corpus: **420 rules (class + ambient), 786 of 1081 nodes styled, ids identical
across reloads, no leftover `className` props, no measurable load-time cost.**

---

## §8 — what the browser found that the gates did not

Static gates were green and the endpoint returned correct-looking JSON. Loading
the board in a real browser found four defects anyway. All four measure zero now
and are covered by `server/handlers/__tests__/studioModuleMapping.test.ts`.

| Defect | Before | After |
|---|---|---|
| Nodes rendering the literal word "Text" | 154 | 0 |
| Nodes rendering the literal word "Button" | 21 | 0 |
| Buttons silently dropping their children | 10 | 0 |
| Inline `<span>` / `<h1>` rewritten to block `<p>` | 33 | 0 |
| Global stylesheets (tokens, resets) collected | no | yes (365 → 420 rules) |

The fourth is the one a test would never have caught by itself: design tokens
live in `src/index.css` and `src/App.css`, imported by `main.jsx`/`App.jsx` —
files that contribute no nodes to any page, so a page-only walk never saw them.
Every `var(--space-lg)` in a screen's own CSS resolved to nothing.

**Verified in the editor:** 15 screens on one board, real English copy, imported
CSS applied (197 KB of style tags per frame, `hp-header` computing
`display:flex; flex-direction:column` from the imported sheet), zero placeholder
labels, `<span>`s preserved as spans.
---

## Round 2 — what three more passes in a browser found

§8 shipped with green gates and a board that *looked* loaded. Three further
passes, each starting from "open the board and compare a screen to the running
app", found nine defects. None was catchable by a unit test written against the
parser's own output, because every one of them was about what the **browser** did
with correct-looking JSON.

```
7e18229 fix(studio): render inline SVG icons and design-system overlays
808e6de feat(studio): make shared-component elements editable, and stop baking resolved values into source
7a79bc1 fix(studio): render an imported screen's full body — drop the phantom call-site wrapper, give % heights a basis, unit numeric styles
11badcc fix(canvas): stop the frame-height flicker and runaway; fit frames so nothing inside scrolls
64e9cc0 feat(studio): expand `.map` over resolved arrays, and stop blanking locked nodes' text
```

### Corpus, measured at each step

| | after §8 | after `808e6de` | after `7a79bc1` | now |
|---|---|---|---|---|
| Nodes | 1081 | 1081 | 955 | **1062** |
| Locked | 874 | 318 | 247 | **329** |
| Styled (carry `classIds`) | 786 | 786 | 773 | **868** |
| Icons with real markup | 42 | 62 | 60 | **78** |
| Text nodes with content | — | — | — | **163** (0 empty) |
| Style rules | 420 | 420 | 420 | **420** |
| Dangling child refs | 0 | 0 | 0 | **0** |
| Tallest frame | — | — | 100342 px | **1707 px** |

Node count falling to 955 and rising to 1062 is two real changes, not noise:
126 phantom wrappers removed, then 107 genuine list rows added. Locked rising
from 247 to 329 is the expanded rows, which are derived and therefore read-only.

### The nine defects

| # | Symptom in the browser | Root cause |
|---|---|---|
| 1 | 20 of 62 icons blank | `import icon from './x.svg?raw'` — the specifier can't match an extension test *through* the `?raw` query, and ts-morph has no `SourceFile` for a `.svg`, so the identifier resolved to nothing |
| 2 | "Unknown module" boxes for `Snackbar` et al. | `register.tsx` did `continue` **before** `registerOrReplace` for 5 overlays, so they were never registered at all — the intent was only to hide them from the insert palette |
| 3 | 874 of 1081 nodes uneditable | Inlining locked every node it produced. The writeback target (the composite id's tail) is a real, valid source location; what it is not is *isolated* |
| 4 | — (found by inspection, never shipped) | `setJsxProp` bakes a resolved value over its expression: verified `data-x={svg}` → `data-x="<svg>…</svg>"`. Unlocking on top of a full-rewrite save would have destroyed bindings across the whole board |
| 5 | Header renders, entire body blank | **A phantom wrapper div at every call site.** `<SheetShell/>` emits no element of its own, but inlining nested the expansion *under* the call-site node |
| 6 | Same screen, still collapsed | Design frames set `body { height: auto }`, so every authored `height: 100%` chain degraded to `auto` |
| 7 | Icons at wrong size, overflowing badges | `width: 44` was emitted as the string `"44"` — invalid CSS, dropped by the browser in the canvas **and** in published HTML |
| 8 | Sections flickering in and out indefinitely | Self-inflicted by the fix for #6: pinning body to the *measured* height closes a loop, because content height depends on the pin |
| 9 | One frame at 100342 px; lists showing one empty row | An `inset: 0` overlay anchored to the grow-to-content frame it fed; and `.map` was never expanded |

### Findings worth carrying forward

**A green gate plus a correct-looking payload is not evidence the board renders.**
Nine defects, three passes, and every single one needed a browser. The endpoint
returned complete, valid JSON in every case — the failures were in wrapper
elements, CSS units, percentage bases, and layout feedback loops. This is the
third time this project has learned it; treat "the tests pass" as the start of
verification, not the end.

**The canvas DOM has to be the DOM React renders.** Defect #5 is the whole
lesson. One structurally-reasonable extra `<div>` — the call-site node kept as a
container around its expansion — broke two unrelated things silently: percentage
and flex height chains (the shell collapsed to its own content, and the `flex: 1`
scroll region inside computed to 0, clipping 1447px to nothing), and every
direct-child or sibling combinator crossing the call site. `IframeFrameSurface`
already says this about `display: contents` NodeWrapper divs; the inliner had
reintroduced the same class of bug one layer up.

**Measured feedback is the recurring hazard in frame sizing.** Three of the nine
were the same shape: a value derived from content, feeding something that changes
content.

| Loop | Break |
|---|---|
| `vh` measured against a frame sized from content | Pin the viewport to a constant (`resolveViewportUnits`, pre-existing) |
| body pinned to measured height, `%` children resize content | Pin to a constant; grow only, never shrink; budget the passes |
| `inset: 0` overlay anchored to the initial containing block | Make body the containing block, so the anchor is the constant |

The general rule this project keeps rediscovering: **a canvas measurement may
never be an input to the thing it measures.** When it must be, make it monotonic
and budget it.

**`locked` was doing two jobs, and the second one was wrong.** It correctly
means "no writeback path". It was *also* being read as "don't show the content" —
`text` was withheld from locked nodes, so `.map` rows, `{cond && <span>Saved</span>}`,
and every spread-bearing element rendered as an empty box while their text sat in
plain sight in the source. §7 had already settled this the other way (a resolved
value sets `text` **and** locks), so the codebase held both rules at once.
Withholding content doesn't make a node less editable; it makes it blank.

**The Tier D ban was drawn at the wrong place.** It banned "loop expansion"
alongside hook state, effects, and async. But `.map` over a resolved array
literal executes nothing: the length is in the source, every item is a value read
out of declarations, and there is no branch to guess. The ban is now drawn at
**executing code**, which keeps the part that matters — branch selection stays
banned, because rendering one state of a stateful screen can look right and be a
lie about the source. Expanding bounded loops recovered 107 nodes and 18 icons.

**One mechanism per value path beats one per call site.** Defect #1 was fixed in
the §7 evaluator rather than the parser, so a single change covered reading a
`?raw` import directly, aliasing it through a `const`, and passing it as
`<Icon svg={checkSvg}/>` for substitution into a component. The same held for
defect #7: `cssValueForProperty` put the number→`px` rule in one place shared by
the canvas and the publisher, instead of at each emitter.

### Two things I broke

Recorded because both are the kind of thing that is invisible later.

1. **I corrupted a real file of yours.** While testing, the editor auto-loaded
   the previously-active `my-workspace` project and autosaved it. The old
   save path rewrote *every* prop of every node, which baked
   `variant="gpay-card"` → `variant="payment"` (the alm enum default) into
   `studio-workspace/my-workspace/pages/About.tsx`, and moved note positions in
   `.studio/boards.json`. Both restored with `git checkout --`. The root cause is
   fixed in `808e6de`: saves now diff against a load-time snapshot and write only
   what the user actually changed.
2. **I introduced the flicker** (defect #8) in `7a79bc1` and fixed it in
   `11badcc`. The reasoning error is documented in `resolveFrameFitHeight`'s
   header: I checked that growing body would fix the collapse, and did not check
   what happens when the thing being measured depends on the measurement.

---

## Round 4 — closing the five remaining gaps

The Round 2 snapshot ended with a list ordered by visibility. All five items on it
are now closed. Every one turned out to be the same failure mode: **the parser had
already read the content and then dropped it** — because the type it was carrying
it in was too narrow, because a resolution route was missing, or because it picked
one branch out of several and discarded the rest.

| # | Gap | Fix | Corpus effect |
|---|---|---|---|
| 1 | Array/object props dropped, so `<ActionSheet actions={[…]}/>` rendered its title alone | `ParsedPropValue` through parser → converter → panel | 3 components populated (2 sheet actions, 5 tabs, 2 segments) |
| 2 | ~23 design-system icons resolved to nothing | `resolveRawTextImport` walks `node_modules` | 78 → 95 icons with real markup |
| 3 | `applyTokens(svg)` loop left 9 illustrations blank | fall back to the transform's input | 95 → 104 |
| 4 | `icon={<Icon/>}` skipped — a React element has no JSON form | capture `{ svg }`; `reviveIconProps` rebuilds the element | 15 icon props, 4/4 Cells now show their icon |
| 5 | Multi-branch components collapsed to the shallowest `return` | every JSX-bearing `return` renders, locked | 1062 → 1154 nodes, 161 → 181 with text |

### Measurements

Same corpus (`studio-workspace/esim-journey/`, 15 screens), same script, before → after:

| | Round 2 | Round 4 |
|---|---|---|
| Nodes | 1062 | **1154** |
| Locked | 329 | **479** |
| Nodes with text | 161 | **181** |
| Icons with real SVG markup | 78 | **104** |
| Structured props captured | 0 | **18** |
| `base.svg` nodes with no markup | 0 | **0** |

Locked went up by 150 and that is the intended trade: the +92 new nodes are
conditional branches, which are visible-but-not-editable by the same rule a
ternary's two sides already followed.

### What the browser confirmed

Driven with gstack `/browse` against `http://localhost:5173/admin/site?studio`.
A 1400x2600 viewport mounts all 15 frames at once (the board virtualises, and
programmatic `scrollTop` does not re-trigger it — resize the viewport instead).

- **DevicePickerSheet** — the screen the user reported as a heading over empty
  space — now renders `Where do you want to install this eSIM?` plus both
  `ios-dialog__btn` buttons, `This device` and `Another device`.
- **HomepageScreen** — `[role=tab]` × 5: Home, Explore, My Trips, Top offers,
  Profile. All 25 SVGs have real geometry; 10 carry the source's own hex fills,
  the documented signature of the transform fallback.
- **SelectPackageSheet** — `Data` / `Days` segments render.
- **BookingConfirmationScreen** — 4 of 4 `.cell`s have an icon SVG.
- **BookingDetailsScreen** — 4 `.ec-ring`s *and* 5 `.ec-icon-img`s, i.e. both
  branches of `EsimAddonIcon`. The ring had never rendered before.
- **No inner scrolling anywhere.** All 15 frames report `body.scrollHeight -
  clientHeight <= 0`.
- **No flicker.** 60 consecutive `requestAnimationFrame`s sampling every frame's
  height yielded **1** distinct state.

### Two judgement calls worth re-reading

1. **A structured prop does NOT lock its node.** Every other resolved value does.
   The reason locking exists is to protect a *writeback target*, and a structured
   value is never one — `setJsxProp` writes scalars, and the save path filters to
   scalars before reaching it. Locking would have cost the user the ability to edit
   `ActionSheet`'s `title` to protect an `actions` array they could never edit.
   The panel's `StructuredValueControl` is what closes the hazard instead.
2. **`?raw` containment is checked on the REAL path, after `realpathSync`.** That
   deliberately breaks linked (`file:`/pnpm) dependencies, and the alternative was
   worse: a workspace can arrive from `/import-github`, git stores symlinks, so a
   textual check would read any file the server user can and inline it into a page.
   Note the root is realpath'd too — without that, macOS's `/var` → `/private/var`
   made every read under `os.tmpdir()` look like an escape (it broke 6 tests
   before I spotted it).

### Still open

- **Only the `previewLocale` branch renders**; RTL is not applied.
- **A multi-stage screen is now as tall as all its stages stacked.** Honest, but
  `ActivationFlowScreen` is 6468px. If this becomes a usability problem the answer
  is a branch *picker* in the editor — never branch selection in the parser.
- **Frames can be taller than their content** (`MAX_SELF_RESIZES` staleness).
  Pre-existing, cosmetic, unrelated to the fit logic.
- **No gate test keeps `INLINE_ID_SEPARATOR` in sync** across its three mirrored
  copies (`fsCodemodAdapter.ts`, `SharedComponentNotice.tsx`) — importing
  `@core/page-parser` into browser code drags ts-morph in and blows the chunk
  budget.
- **Dynamic-SVG detection is `text.includes('{')`** and over-triggers on a literal
  `{`.
- **One empty icon remains** on BookingConfirmationScreen: `ADD_ONS[0]` has an
  `image` and no `icon`, and both ternary branches render by design, so the
  `<Icon>` branch for that row genuinely has no markup. Correct, not a defect.

---

## Gate status

Run in full after Round 4.

| Gate | Result |
|---|---|
| `bun run build` (`tsc -b && vite build`) | ✅ |
| `bun run lint` | ✅ zero errors in `src/` or `server/` (188 overall, all in the `design-system` submodule and `templates/`) |
| `bun test` | 6820 pass / 16 fail |

**None of the 16 are ours** — the identical set was confirmed failing at `36c6bac`
with this work stashed, including `ClassPropertyRow`, which sits close enough to
the touched `property-controls/` folder to be worth checking rather than assuming.
Two regressions were introduced and fixed along the way, both caught by the gate:

- `module-size-budgets` twice. `cssToStyleRules.ts` hit 702 lines (fixed by
  extracting `cssomSheet.ts`); `inlineLocalComponents.ts` hit 737 (fixed by
  extracting `componentSubstitution.ts` — the structural half never reads a prop
  and the value half never moves a node, so the seam was already there).
- `no-native-browser-dialogs` — a new test used the payload
  `'expression(alert(1))'`, and the gate greps for `alert(` in source. Changed the
  payload, not the gate.

Six test expectations were deliberately inverted, each because the behaviour they
encoded was the defect: locked nodes now keep their `text`; a call site no longer
leaves a `base.container`; design-frame body is pinned rather than `auto`, does
not clip, and is `position: relative`.

The two bundle-size failures were verified pre-existing by rebuilding at
`74f0bcc`: `AdminCanvasEditorBody` was already **1,516.18 kB** against a 761.7 kB
budget, byte-identical to now. This work added zero bundle weight — the ts-morph
hazard the plan warned about was avoided.

The rest (SettingsModal ×5, Toolbar ×2, ClassPropertyRow, SettingsButton, Zustand
selector stability, icon wrapper, two vendor-icon freshness gates) belong to the
parallel studio-shell/rebrand work in `magical-humming-moth.md`.

`bun run lint` reports 188 errors overall, all inside the `design-system`
submodule and `templates/` — neither is ours.

---

## Local environment notes

- **Validation corpus** is re-staged at `studio-workspace/esim-journey/` (a copy
  of `github.com/maherfayad-stack/eSIM` → `journey-screens/`, with a hand-written
  `.studio/meta.json`: `pagesDir: "src/screens"`, `previewLocale: "en"`). It is
  git-excluded via `.git/info/exclude`. Read-only input: never commit it. Note it
  **now has a local `node_modules/@alm-design/design-system`** — a real copy of the
  package already installed at the repo root, put there so the ~23 package `?raw`
  icon imports resolve (`npm install` inside the corpus does the same thing). It is
  inside the git-excluded path, so nothing about it is committed. A **symlink would
  not work by design** — see Round 4's second judgement call.
- **A local smoke-test account was added to `.tmp/dev.db`** to drive the UI, since
  the existing `dev@localhost.dev` password is not recoverable:
  `smoke@localhost.dev`, role `admin`. Its password was reset during Round 2 to
  `LocalSmoke!2026` (the earlier one was no longer working). Local dev DB only,
  and gitignored. Delete it whenever you like:
  `delete from users where email_normalized = 'smoke@localhost.dev';`
- **The `Zustand selector stability` failure is a bug in the test, not the code.**
  It fails to URL-decode the repo path, and this checkout contains a space
  (`Figma%20Killer%202`), so it scans nothing and reports a violation. Worth
  fixing if it ever blocks someone.
- **Browser verification** used the gstack `/browse` headless Chromium against
  `http://localhost:5173/admin`. The useful measurements were taken by reaching
  into `iframe.contentDocument` and reading `getBoundingClientRect()` /
  `scrollHeight` / `getComputedStyle` — screenshots alone would have missed the
  height chain, the units, and the oscillation. Sampling 80 consecutive
  `requestAnimationFrame`s and counting distinct states is what proved the
  flicker fixed.
