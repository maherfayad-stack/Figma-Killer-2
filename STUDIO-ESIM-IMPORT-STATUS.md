# Status — STUDIO-ESIM-IMPORT-PLAN implementation

**As of 2026-07-27.** Companion to `STUDIO-ESIM-IMPORT-PLAN.md`.

**Headline: all nine sections complete. §7 Tier B closed, §6 built, §8 dogfooded
in a browser, §9 written. Full gate run — no failures introduced.**

---

## Where the code is

| | |
|---|---|
| Branch | `feat/alm-figma-killer-studio-shell` |
| Head | `f6b2692 fix(studio): four import-fidelity defects found by driving the board in a browser` |
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
| **§7** | Static value resolution (tiers A→B→C) | ✅ |
| **§8** | Validation on eSIM | ✅ static **and** in a real browser |
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

## Known remaining limitations

All deliberate and documented in `docs/features/studio-import.md`:

- **The app shell is not reproduced.** Studio renders each screen standalone, so
  `App.jsx`'s `.esim-app` wrapper and the `html,body{height:100%}` chain under it
  are absent. A bottom sheet built to fill a fixed-height viewport lays out
  against an auto-height body and can collapse. The content is present and
  correct in the DOM — it just doesn't get the height its CSS assumes. This is
  the largest remaining fidelity gap and the obvious next piece of work.
- No loop expansion (Tier D banned); multi-stage screens collapse to the
  least-nested `return`; computed `className` keeps only its static prefix; only
  the `previewLocale` branch renders; dynamic-SVG detection is `text.includes('{')`
  and over-triggers on a literal `{`; everything §7 resolves is read-only.
- `INLINE_ID_SEPARATOR` is still mirrored rather than imported in
  `fsCodemodAdapter.ts` (importing `@core/page-parser` into browser code drags
  ts-morph in and blows the chunk budget ~10x). **There is still no gate test
  keeping the two constants in sync.** Worth adding.

---

## Gate status

Run in full at `f6b2692`.

| Gate | Result |
|---|---|
| `bun run build` (`tsc -b && vite build`) | ✅ |
| `bun run lint` | ✅ zero errors in `src/` or `server/` |
| `bun test` | 6747 pass / 16 fail |

**None of the 16 are ours.** The identical set failed before this work started;
`module-size-budgets` was the one regression introduced (a doc comment pushed
`cssToStyleRules.ts` to 702 lines) and it was fixed by extracting `cssomSheet.ts`.

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
  has **no `node_modules`**, so `@alm-design/design-system` CSS is absent — the
  admin canvas injects those tokens itself, so this does not affect the result.
- **A local smoke-test account was added to `.tmp/dev.db`** to drive the UI, since
  the existing `dev@localhost.dev` password is not recoverable:
  `smoke@localhost.dev` / `SmokeTest!2026`, role `admin`. Local dev DB only, and
  gitignored. Delete it whenever you like:
  `delete from users where email_normalized = 'smoke@localhost.dev';`
