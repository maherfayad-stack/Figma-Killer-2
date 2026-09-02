# Audit 10 — CSS classes vs inline styles

Read-only audit. Repo: `c:\Users\Admin\Documents\GitHub\Figma Killer 2`, branch `feat/alm-figma-killer-studio-shell`.

---

## PART 0 — THE CAPABILITY MATRIX

### 0.1 Where a style can live, and what Studio can do with it

| # | Style home | Example | Studio can READ it? | Studio can WRITE it? | Evidence |
|---|---|---|---|---|---|
| 1 | **Inline `style={{}}` object literal, literal values** | `<div style={{ color: 'red' }}>` | ✅ Yes — flattened into `node.inlineStyles`, rendered by `NodeRenderer` | ✅ Yes — `kind:'style'` edit → `setJsxStyle`, merges into the existing literal | `jsxAttributeReaders.ts:386` `extractInlineStyles`; `parsedPageToSitePage.ts:226`; `fsCodemodAdapter.ts:436-446`; `setJsxStyle.ts:62-132` |
| 2 | **Inline `style={{}}`, non-literal values** | `style={{ width: w }}` | ⚠️ Partial — resolved via evaluator if possible, else absent | ❌ No — recorded as `codeStyles` → `codeProps` `style:<prop>` → `isStyleWritableToSource` false | `jsxAttributeReaders.ts:411-415`; `sourceWritability.ts:62-64`; filtered at `fsCodemodAdapter.ts:440` |
| 3 | **Inline `style={someVar}` / spread / call** | `style={cardStyle}` | ❌ No — `extractInlineStyles` bails | ❌ No — `setJsxStyle` throws `JsxStyleTargetError` | `jsxAttributeReaders.ts:405-408`; `setJsxStyle.ts:100-112` |
| 4 | **Inline style on a non-`base.*` node** | `<Button style={{…}}>` (pkg/alm/instance) | ✅ Read | ❌ **No, and SILENTLY** — writeback gated on `node.moduleId.startsWith('base.')` | `fsCodemodAdapter.ts:436` |
| 5 | **Inline style on a `.map` row / structurally-locked node** | row inside `items.map(...)` | ✅ Read | ❌ No — every style key pushed to `codeProps` | `parsedPageToSitePage.ts:183-190` |
| 6 | **Plain `.css` class, relative import** | `import './Card.css'` → `.card {}` | ✅ Yes — `StyleRule` + `node.classIds` | ✅ **Yes — declaration values reach disk** | `studioCss.ts:236-303`; `styleRuleWriteback.ts:200-268`; `studioCssWriteback.ts:137-158` |
| 7 | **Plain `.css` "ambient" selector** | `.hero em {}`, `a:hover {}` | ✅ Yes — `kind:'ambient'` rule, matched live via `element.matches()` | ✅ Yes — same `sources` entry, `selector` written verbatim | `studioCss.ts:287-291`; `selectorPickerModel.ts` (ambient matching) |
| 8 | **`.module.css` class** | `styles.card` | ✅ Yes — compiled at Tier 0, hashed name mapped back | ✅ **Yes — via `cssModuleSource` inverse map** | `styleCompile.ts` `moduleClassMaps`; `studioCss.ts:155-222`; `classifyStylesheetEditability.ts:19-31` |
| 9 | **`.module.scss` / `.module.sass` / `.module.less`** | `styles.card` in Sass module | ❌ No — warned, never renamed | ❌ No | `styleCompile.ts:168-199`; `studioCss.ts:150-153` |
| 10 | **`.scss` / `.sass` / `.less` plain import** | `import './x.scss'` | ⚠️ Only if it happens to be valid plain CSS | ❌ No — `mappable` requires `/\.css$/i`; `resolveContainedCssPath` requires `.css` | `studioCss.ts:278`; `studioCssWriteback.ts:104` |
| 11 | **Tailwind utility class** | `className="bg-red-500 p-4"` | ⚠️ Only at Tier ≥ 1 (compiled output parsed into rules); at Tier 0 **invisible** | ❌ **No — and there is no Tailwind UI at all** | `styleCompile.ts:423-448`; `classifyStylesheetEditability.ts:32-46` |
| 12 | **Vendor package CSS** | `import '@acme/ui/style.css'` | ✅ Rendered in `@layer vendor` | ❌ No — never parsed into a `StyleRule`, by design | `ProjectCssInjector.tsx:30-35`; `styleCompile.ts` `collectVendorCss` |
| 13 | **Framework token utility class** | `.text-color-metal` from `.studio/framework.json` | ✅ Yes | ❌ No CSS file (regenerated from tokens) — but token itself persists | `classUtils.ts:12-18`; skipped at `styleRuleWriteback.ts:225` |
| 14 | **CSS-in-JS** (styled-components / emotion) | `styled.div\`…\`` | ❌ No | ❌ No | Detected only as `styleToolchain.cssInJs`; no consumer |
| 15 | **`className` attribute itself** (assign/unassign a class) | add `.card` to an element | ✅ Read (`classIdsForClassName`) | ❌ **NO — no `className` codemod, no `class` edit kind exists** | `studioCss.ts:119-132` ("`className` is never rewritten by this path"); `studioWriteback.ts:70-169` (edit kinds); `fsCodemodAdapter.ts:208-215` |
| 16 | **Class-level breakpoint / `@media` override** | `.card` under Mobile tab | ✅ Read (as `ConditionDef` + `contextStyles`) | ❌ No — reported via `unwritableContexts` toast | `styleRuleWriteback.ts:172-187, 233-238`; `setDeclarationAtMedia` exists but is unwired |
| 17 | **New class created in the panel** | type "hero" → Create | n/a | ❌ No — in-memory `nanoid()` rule, no file, no `sources` entry → `unmapped` toast on save | `styleRule/crudActions.ts:288-316`; `styleRuleWriteback.ts:250-253` |
| 18 | **Rename / delete a class** | context menu → Rename | n/a | ❌ No — registry-only; the `.css` selector and every `className=` string keep the old name | `styleRule/registryActions.ts:95, 164-201` |

### 0.2 The one-sentence verdict per question

| Q | Answer |
|---|---|
| **Q7 — Does class CSS reach disk?** | **Partly, and this is the surprise: YES for declaration VALUES on plain `.css` and `.module.css` rules (a real postcss round-trip, `studioCssWriteback.ts`). NO for everything structural — class assignment, class creation, rename, delete, and every `@media` override.** The class-editing UI is ~40% real. |
| **Q5 — Tailwind** | Zero Tailwind-aware UI anywhere in `src/admin/`. `styleToolchain` never reaches the browser. At Tier 0 (every fresh import) a Tailwind project has **no styling at all** on the canvas. |
| **Q6 — CSS Modules** | Yes — a declaration on a `.module.css` class does reach disk. This is the best-supported non-obvious case, and it is invisible to the user. |
| **Q2 — Effective vs authored** | The Properties panel shows **only the authored bag of the one active target**, with a static spec-default placeholder. `getComputedStyle` is used nowhere in `PropertiesPanel/` or `property-controls/`. A real computed-style reader **does** exist — in the *left* sidebar's read-only InspectPanel (S15). |

---

## PART 1 — NUMBERED FINDINGS

### S1 — Class assignment never reaches disk; the ClassPicker is the single largest lie in the product
**Severity: CRITICAL**

**Evidence.** There is no `className` codemod and no `class` edit kind. The `StudioEdit` union is exactly seven kinds:

`src/admin/pages/site/studio/fsCodemodAdapter.ts:208-215`
```ts
type StudioEditPayload =
  | { kind: 'prop'; … } | { kind: 'text'; … } | { kind: 'style'; … }
  | { kind: 'literal'; … } | { kind: 'tag'; … } | { kind: 'asset'; … }
  | { kind: 'css'; nodeId; file; selector; property; value }
```
Server authority: `server/handlers/studioWriteback.ts:70,78,85,106,120,144,158,169` + `studioStructuralWriteback.ts:43,55,107` + `studioCssWriteback.ts:64`. No `class`/`className` kind.

`server/handlers/studioCss.ts:119-132` states the direction is one-way on purpose:
> "the source file keeps it either way, since `className` is never rewritten by this path."

`addNodeClass`/`removeNodeClass` (`store/slices/styleRule/assignmentActions.ts:31-92`) mutate `node.classIds` in memory only. `saveSite`'s prop loop (`fsCodemodAdapter.ts:384-409`) can never emit it — `className` is dropped from `props` entirely at parse time (proven by `server/handlers/__tests__/studioCss.test.ts:88-90`, `expect(nodes.some(n => 'className' in n.props)).toBe(false)`).

**And nothing tells the user.** `collectStyleRuleEdits` diffs `site.styleRules`, not `node.classIds` — a pure assignment change produces zero edits, zero `unmapped` entries, zero toasts. The user drags a class onto an element, watches the canvas change, waits 2 s for autosave, and loses it on the next reload with no message. This is strictly worse than the `unmapped` case, which at least toasts.

**Root cause.** WS-6.3 built CSS *declaration* write-back and stopped. Class *membership* was never modelled as a write.

**Proposed fix.** New codemod `src/core/ast-codemods/setJsxClassName.ts` + `kind: 'class'` edit in a new `server/handlers/studioClassWriteback.ts` (sibling of `studioCssWriteback.ts`), + a `classIds` diff in `fsCodemodAdapter.saveSite`. Must handle: literal `className="a b"` (merge tokens, preserve order/whitespace), `className={styles.x}` (refuse — one honest target rule), `cn(...)`/`clsx(...)` (refuse or append a literal arg), absent attribute (add one). Refusals surface through the existing `REFUSAL_TITLES` path (`fsCodemodAdapter.ts:506-514`).
**Effort: L.** Depends on: nothing. This is the highest-value single change in the whole styling area.

---

### S2 — The panel shows the authored value of ONE target, never the effective computed value, and never says where a value came from
**Severity: CRITICAL** (this is the user's actual complaint)

**Evidence.**
`getComputedStyle` appears **zero times** in `src/admin/pages/site/panels/PropertiesPanel/` or `src/admin/pages/site/property-controls/`. Canvas hits are geometry, scroll-unroll, chrome injection, agent evidence (`canvasDomGeometry.ts:286`, `CanvasScrollUnrollInjector.tsx:254`, `EditorChromeInjector.tsx:146`, `renderEvidence.ts:308`).

The render core takes two bags and neither is computed — `StyleSectionsEditor.tsx:52-55, 286-306`:
```ts
storedStyles: Record<string, unknown>   // drives value + set/unset state
currentStyles: Record<string, unknown>  // placeholder only
…
const storedValue = storedStyles[prop]
const isSet = hasStyleValue(storedValue)
const fallbackValue = hasStyleValue(currentStyles[prop]) ? currentStyles[prop] : getCSSPropertyDefaultValue(prop)
value={isSet ? (storedValue as string | number) : undefined}
placeholder={!isSet ? fallbackValue : undefined}
```
The class path fills them from the store — `StyleRuleComposer.tsx:66-71`:
```ts
const storedStyles = activeContextId ? (cls.contextStyles[activeContextId] ?? {}) : cls.styles
const currentStyles = activeContextId ? { ...cls.styles, ...storedStyles } : cls.styles
```
`currentStyles` is **only this same rule's base bag under its own breakpoint override** — not a cascade, not other classes, not inheritance. The inline path is flatter still: `InlineStyleComposer.tsx:49-50` passes the same bag as both `storedStyles` and `currentStyles`.

`ClassPropertyRow.tsx` resolves nothing — it stringifies what it is handed (`:89`, `:170,183,215,233,261`).

The "unset" placeholder is a **hand-written static table**, not the inherited/computed value — `cssControlTypes.ts:337-346` → `DEFAULT_CSS_VALUES` at `cssControlTypes.ts:208-328` (`backgroundColor: 'transparent'` `:267`, `width: 'auto'` `:240`, `display: 'block'` `:223`, `fontSize: '14px'` `:211`). The same two-step is duplicated in `StackedPropertyGrid.tsx:75-85`, `SizeSection.tsx:189-193`, `PositionSection.tsx:256,266`, and even the empty-state teaser (`StyleSurface.tsx:363`).

**No per-property provenance exists.** `ClassPropertyRow.tsx:273-301` emits only `data-state={isSet ? 'set' : 'unset'}`; `ClassPropertyRow.module.css:46-52` styles "unset" as a muted label and contains **no `line-through`** — there is no strikethrough for a shadowed declaration anywhere. Section headers show a bare `${setCount} set` (`StyleSectionsEditor.tsx:161,177`) of the stored bag only. Ironically, provenance UI *does* exist for module params (`ParamRow.tsx:355` renders `Overridden` / `Default`) — just never for CSS.

**Only one active class is ever consulted.** `usePropertiesPanelData.ts:165-168` resolves a single `site.styleRules[activeClassId]`. A node with `.card .btn .btn-primary` shows one pill's bag; the other two contribute nothing to values *or* placeholders. The pills themselves are sorted weakest→strongest by specificity (`selectorPickerModel.ts:147-164`), which is a cascade hint on the pill row and nowhere else.

**Consequence, concretely.** A `<div class="card">` where `.card { background: #fff }` and the element also has `style={{ background: 'red' }}`:
- Active target = Class → panel shows `#fff`. Canvas shows **red**. No indication the inline style is winning.
- Active target = Element → panel shows `red`. The `.card` rule is invisible.
- Neither view mentions the other exists.
- A property set only by a vendor `@layer vendor` rule, or by a Tailwind utility, or by an ambient descendant selector, shows as **unset with a fake spec default**.

**Root cause.** The panel is a store viewer, not an inspector. It was inherited from the CMS half, where the store *was* the truth. In Studio the truth is the iframe.

**Proposed fix.** See UNIFIED STYLING UX SPEC §A/§B. New module `src/admin/pages/site/panels/PropertiesPanel/useEffectiveStyle.ts` reading `getComputedStyle` from the frame element (via `canvasNodeLookup` + `CanvasFrameContext`), plus a provenance resolver that attributes each property to inline / a `StyleRule` / vendor / reset / inherited.
**Effort: L.** Depends on: S3 (needs the canvas to be an honest mirror first).

---

### S3 — Canvas ≠ real app: four independent, systematic divergences
**Severity: CRITICAL**

The board frame does **not** render the user's CSS. It renders a *regenerated* stylesheet built from a lossy CSSOM parse, plus three things the real app does not have.

**(a) The CMS publisher reset is injected into every Studio frame.**
`ClassStyleInjector.tsx:183-186`:
```ts
const resetBlock = `@layer ${RESET_LAYER} {\n${PUBLISHER_RESET_CSS}\n}`
styleEl.textContent = `${CANVAS_CSS_LAYER_ORDER}\n${resetBlock}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
```
`PUBLISHER_RESET_CSS` (`src/core/publisher/reset.ts:41+`) includes `:where(*) { margin: 0; padding: 0 }`, `:where(html, body) { height: 100% }`, `:where(body) { line-height: 1.5; font-family: system-ui… }`, `:where(button) { background: none; border: 0 }`. **None of this exists in the user's Vite app** unless they authored it. Every default margin, every UA button chrome, every default body font differs between board and `npm run dev`.

**(b) Studio's own `@alm-design/design-system` CSS is injected into every project's frames.**
`ProjectCssInjector.tsx:50, 74-79`:
```ts
import almDesignSystemCss from '@alm-design/design-system/dist/index.css?inline'
…
[almDesignSystemCss as string, projectVendorCss].filter(Boolean).join('\n\n')
```
Plus `ProjectCssInjector.tsx:86-88` stamps `data-theme="light"` on `<html>` of every frame. A project that has nothing to do with Alm gets Alm's token layer and a `data-theme` attribute its own CSS may key off.

**(c) The class registry is regenerated from a lossy CSSOM read, and parse warnings are discarded.**
`canvasClassCss.ts:60`: `generateClassCSS(classes, breakpoints, conditions, …)` — the canvas emits bytes derived from `StyleRule` bags, not the original file text. `studioCss.ts:274-292` calls `cssToStyleRules` and uses only `.rules` and `.conditions`; `parsed.warnings` (`cssToStyleRules.ts:238, 247, 266, 302`) is **never read**. A rule the happy-dom CSSOM cannot represent (modern nesting, `@layer`, `@container`, `@supports`, `:has()` in some engines) silently vanishes from the canvas with no warning anywhere in the UI.

**(d) Two `.css` files defining the same class name collapse into one rule.**
`studioCss.ts:114-116` — `styleRuleId(kind, name)` hashes `kind|name` only, no file. `studioCss.ts:283`: "A later stylesheet redefining the same name wins." So `.button` in `Header.css` and `.button` in `Footer.css` become one `StyleRule` whose declarations are the later file's, whose `sources` entry points at the later file (`studioCss.ts:287-291`), and whose earlier block is invisible and unreachable — while the real browser cascades both.

**Root cause.** The canvas was built for the CMS, where the store was authoritative and regeneration was correct. In Studio the file is authoritative and regeneration is a fidelity leak.

**Proposed fix.** For imported projects, inject the *original CSS bytes* (as `UserStylesheetInjector` already does for `site.files`) in file order, and use `site.styleRules` only for the editor's *understanding*, not for rendering. Drop `PUBLISHER_RESET_CSS` and the unconditional Alm CSS from Studio frames — make both conditional on the project actually depending on them. Surface `cssToStyleRules` warnings on the load stream.
**Effort: L.** Depends on: a decision about whether the CMS canvas and Studio canvas share `ClassStyleInjector` at all.

---

### S4 — Inline-style edits on non-`base.*` nodes are dropped silently
**Severity: HIGH**

`fsCodemodAdapter.ts:436`:
```ts
if (node.moduleId.startsWith('base.')) {
  const style = literalInlineStyles(node.inlineStyles)
  …
}
```
A `pkg.*`, `alm.*`, or `studio.instance` node never enters the branch, so no `kind:'style'` edit is created. Because no edit is *sent*, `result.skipped` never counts it, so the `unexplainedSkips` toast (`fsCodemodAdapter.ts:523-533`) never fires. Meanwhile `StyleSurface`'s `showInline` gate (`StyleSurface.tsx:158`) has **no** moduleId check:
```ts
const showInline = canEditStyleHere && nodeId != null && activeClass == null && inlineStyleEditing
```
So the panel happily offers the full inline editor on a design-system component and throws every keystroke away.

Same class of silence one layer down: `isStyleWritableToSource` filtering at `fsCodemodAdapter.ts:440` uses `.filter(...)` — a `codeProps`-locked style property is dropped with no report.

**Root cause.** The offer gate and the write gate were written in different work orders and never reconciled.

**Proposed fix.** Hoist the `base.*` predicate into a shared `canWriteInlineStyle(node)` in `src/core/page-tree/sourceWritability.ts`; `StyleSurface` disables the Element chip with the reason; the diff loop reports drops through the refusal channel.
**Effort: S.** Depends on: nothing.

---

### S5 — Class create / rename / delete are pure fiction
**Severity: HIGH**

- **Create** (`ClassPicker.tsx:168-202` → `crudActions.ts:288-316`): builds `{ id: nanoid(), kind:'class', selector: '.'+name }` in the store. No `.css` file is written, no `sources` entry exists, so on the next save the rule lands in `unmapped` and the user gets *"Style not saved to source… will be lost on reload"* (`fsCodemodAdapter.ts:462-469`). The affordance exists purely to produce an error two seconds later.
- **Rename** (`registryActions.ts:95`): registry-only. The `.css` selector keeps the old name; every `className=` string keeps the old name. The rename is invisible outside the session.
- **Delete** (`registryActions.ts:164-201`): removes the registry entry and strips `classIds`. The `.css` rule stays on disk; the element still carries the class in source.

**Root cause.** Same as S1 — membership and file structure were never modelled as writes.

**Proposed fix.** Create → append a rule to a chosen `.css` file (`setDeclaration` already creates a missing rule at end-of-file, `setDeclaration.ts:125-128`) and require a target-file picker. Rename → a `renameSelector` codemod plus the S1 `className` codemod applied to every node carrying the id, in one batch, refusing if any site is unwritable. Delete → `removeRule` codemod + `className` token removal.
**Effort: M** (after S1 lands; **L** without it).

---

### S6 — Two edit targets that cannot be seen at the same time, chosen by a hidden default
**Severity: HIGH** (the literal complaint in the task)

Enforced twice — once in the store, once in the surface. `store/slices/styleRule/uiStateActions.ts:28-48`:
```ts
setActiveClass(id) {
  // Selecting a real class always switches away from inline editing.
  const nextInline = id !== null ? false : inlineStyleEditing
  …
},
setInlineStyleEditing(active) {
  // Enabling inline editing clears the active class so the two targets stay
  // mutually exclusive; disabling leaves the active class untouched.
  set((s) => { s.inlineStyleEditing = active; if (active) s.activeClassId = null })
},
```
Seeded per selection from "does this node have inline styles" (`selectionSlice.ts:437-439, 610`), mirrored into the picker (`useClassPickerDerivedState.ts:40`).

`StyleSurface.tsx:158-164`:
```ts
const showInline = canEditStyleHere && nodeId != null && activeClass == null && inlineStyleEditing
const styleTarget: StyleEditTarget = activeClass != null ? 'class' : showInline ? 'element' : 'none'
const canReachElementTarget = canEditStyleHere && nodeId != null && activeClass == null
```
Inline and class are **mutually exclusive by construction**. The consequences:
1. If the element has any class, the Element chip is *disabled*, tooltip: *"Remove the assigned class to style this element directly"* (`StyleTargetChip.tsx:113`). Real React code sets both constantly. Studio makes you delete one to see the other.
2. Which target is active is decided for you: `ClassPicker.tsx:238-253` auto-activates the highest-specificity direct match on selection. Nothing announces "your next click will edit `.card`, which affects 14 other elements."
3. The Class chip is deliberately not clickable (`StyleTargetChip.tsx:117-124`) — switching targets means going to a *different surface* (the picker input) and finding the pill.
4. `storedStyles` (`StyleSurface.tsx:174-178`) is a three-way ternary that shows exactly one bag. There is no simultaneous view.
5. **The concrete failure.** Node has `inlineStyles = { backgroundColor: 'red' }` and class `.card { background-color: blue }`, `.card` active. The panel's background field reads **`blue`**. The element on canvas is **red** — inline wins the real cascade. Nothing in the panel says so. The only hint is an inactive pill labelled "Inline" (`useClassPickerDerivedState.ts:31,58` → `ClassPickerParts.tsx:174-180`), which names no properties.

**Root cause.** The chip was designed as an *honesty* device ("say which of two places this goes") rather than a *control* device ("choose where this goes, seeing both").

**Proposed fix.** See UNIFIED STYLING UX SPEC — one property list, provenance per row, explicit write-target selector per edit.
**Effort: M** (UI), gated on S2's effective-value engine.

---

### S7 — Class edits under a breakpoint/condition are accepted, previewed, then refused at save
**Severity: MEDIUM**

`styleRuleWriteback.ts:172-187` defines `unwritableContexts`; `:233-238` populates it; `fsCodemodAdapter.ts:472-481` toasts *"Breakpoint override not saved to source."* The `CssEditSchema` (`studioCssWriteback.ts:63-70`) carries no media query, even though `setDeclarationAtMedia` (`setDeclaration.ts:138-184`) is written, tested, and ready.

The panel gives no warning *before* the edit — the breakpoint tabs look fully functional. The user does a whole responsive pass and finds out at save time.

**Proposed fix.** Add `mediaQuery?: string` to `CssEditSchema`, resolve it from the `ConditionDef`/`Breakpoint` registry in `collectStyleRuleEdits`, dispatch to `setDeclarationAtMedia`. Add the corresponding `analyzeDeclarationTarget` variant scoped to the at-rule.
**Effort: M.** Depends on: nothing — the primitive exists.

---

### S8 — There is no Tailwind experience at all, and a fresh Tailwind import renders unstyled
**Severity: HIGH** (most React projects are Tailwind)

- Tailwind compilation is **Tier 1** and a fresh import is **Tier 0** — `styleCompile.ts:443-448`:
  ```ts
  if (needsTier1) { if (trust === 'static') { warnings.push({ code: 'style-toolchain-requires-trust-promotion', … }) } }
  ```
  So on first open, a Tailwind project's canvas has **zero project CSS** (plus the reset + Alm CSS from S3 — so it renders as unstyled text on a foreign token layer).
- After promotion, the generated utilities arrive via `extraCss` and are parsed into `StyleRule`s with **no `sources` entry** (`studioCss.ts:287-291`), so every one is `unmapped`.
- `ProjectProfile.styleToolchain` **never reaches the browser**. The load-stream meta line (`studioLoadStreamSchema.ts:43-60`) carries `trust`, pages, `styleRuleSources`, `conditions`, `vendorCss` — no profile. The only Tailwind string a browser ever sees is a token-source label (`studioTokenStatus.ts:29`, `TokenImportStatus.tsx:29`).
- There is no utility vocabulary, no `bg-`/`p-`/`text-` parser, no utility→property map anywhere in `src/admin/`. The only Tailwind regex in the repo is the *ban* test `src/__tests__/architecture/noTailwindUtilities.test.ts:18`.
- The gap is documented as intended future work: `classifyStylesheetEditability.ts:32-46`, `styleRuleWriteback.ts:27-30`.

**Proposed fix.** Tailwind is not a *declaration* problem, it is a *className* problem — it is S1 plus a vocabulary. Once `setJsxClassName` exists: ship `styleToolchain` on the load meta line, add a Tailwind-mode panel where each property control writes a utility token instead of a declaration (`background-color: #ef4444` → `bg-red-500`), resolved against the project's own theme (`tokenExtractTailwind.ts` already reads `theme.extend` statically). Arbitrary values (`w-[13px]`) are the escape hatch for anything the scale lacks.
**Effort: L.** Hard-depends on S1.

---

### S9 — The ClassPicker cannot tell you what a class does, or where it lives
**Severity: MEDIUM**

Enumerated gaps, all confirmed:

| Capability | State | Evidence |
|---|---|---|
| Search by name | ✅ substring/prefix ranking | `classPickerRanking.ts:26-37` (4=exact, 3=prefix, 2=word-boundary, 1=substring) |
| Search by *what it does* ("find classes setting flex") | ❌ | ranking is string-only |
| Grouping by stylesheet / file | ❌ — grouped by **Recent / Frequent / All / Ambient** (localStorage usage history) | `useClassPickerSuggestions.ts:146-169`; `ClassPickerParts.tsx:578,588,598,605` |
| Show the file a class lives in | ❌ — `StyleRule` has no file field at all (`styleRule.ts:65-129`); provenance lives in a module-level map (`styleRuleWriteback.ts:122`) the picker never reads | |
| Show what a class does (declaration summary) | ❌ in the picker. A `getSelectorStyleSummary` producing `"2 props · 1 context"` **exists** in `SelectorsPanel.tsx:362,545` and is not reused | |
| Colour swatch / visual preview in the row | ❌ — row is selector text + optional `Utility` badge | `ClassPickerParts.tsx:334-337, 558-561` |
| Live canvas preview on hover | ✅ (behind the `hoverPreview` preference) | `ClassPicker.tsx:225-232`; `uiStateActions.ts:50-56` |
| How many other elements use this class | ❌ | |
| Create new | ⚠️ exists, doesn't persist — S5 | |
| Rename | ⚠️ exists, doesn't persist — S5 | |
| Remove from element | ⚠️ exists, doesn't persist — S1 | |
| Delete class globally | ⚠️ exists, doesn't persist — S5 | |
| Reorder classes on the element | ✅ in-store (`reorderNodeClass`) | ❌ doesn't persist (S1) |

**Proposed fix.** Add `file` to `StyleRuleSource` consumption in the picker (the map already exists), group by stylesheet, reuse `getSelectorStyleSummary`, add a colour/type swatch, add a usage count.
**Effort: M.** Depends on: nothing (data is all present).

---

### S10 — `setJsxStyle` is correct but narrow, and its refusals never reach the panel's *offer*
**Severity: MEDIUM**

Shapes supported (`setJsxStyle.ts:62-132`):

| Shape | Behaviour |
|---|---|
| no `style` attribute | ✅ adds `style={{ … }}` (`:71-75`) |
| `style={{ a: 1 }}` object literal | ✅ **merges** — existing keys `setInitializer`, new keys `addPropertyAssignment` (`:114-129`). Never replaces the object. |
| spread attribute `{...props}` named `style` | ❌ throws (`:77-85`) |
| `style` with no expression (`<Foo style />`, `style="…"`) | ❌ throws (`:90-98`) |
| `style={ident}` / `style={fn()}` / `style={cond ? a : b}` | ❌ throws (`:100-105`) |
| `style={{ ...base, color: 'red' }}` | ❌ throws (`:107-112`) |
| shorthand property `{ color }` | ❌ throws for that key (`:119-128`) |
| styled-jsx / CSS-in-JS | not a `style` attribute — out of scope entirely |

**Formatting.** ts-morph `saveSync()` on a whole `SourceFile`. Merging into an existing literal touches only the initializer, but **adding** a `style` attribute or a property uses ts-morph's own printer, which is not the user's prettier config — quote style, trailing commas, and line width can drift from the project's formatting on the elements it touches. Values are `JSON.stringify`'d (`:50-52`), so every string becomes double-quoted regardless of project convention.

**The offer/refuse mismatch.** All eight refusals above happen at *save* time. `StyleSurface` offers the inline editor based only on `showInline` (`:158`), which knows nothing about the `style` attribute's shape. A user styling `<div style={cardStyle}>` gets a full editor, a live canvas, and a toast two seconds later.

**Proposed fix.** Have the parser record an `inlineStyleShape: 'literal' | 'refused'` + reason on `ParsedNode` (it already visits the attribute in `extractInlineStyles`), thread it to `PageNode`, and disable the Element target with that reason.
**Effort: S.**

---

### S11 — CSS parse warnings and Tier-0 style warnings are collected and thrown away
**Severity: MEDIUM**

`studioCss.ts:274-292` calls `cssToStyleRules(cssText, …)` and destructures only `.conditions` and `.rules`. `parsed.warnings` — `invalid-rule`, `duplicate-class`, `dropped-at-rule`, `asset-reference` (`cssToStyleRules.ts:238-307`) — is discarded. `readStylesheet` failures `console.warn` server-side only (`studioCss.ts:310, 315`).

So: a stylesheet that fails CSSOM parse entirely produces a canvas with no styles and **no message**. A duplicated class silently discards the first block (S3d). An oversized file (>2 MB, `studioCss.ts:78`) is skipped silently.

**Proposed fix.** Add `styleWarnings: ProbeWarning[]` to the load stream's meta line and surface them in the panel (a small "3 stylesheet issues" affordance), same posture the trust-tier and probe surfaces already use.
**Effort: S.**

---

### S12 — `analyzeDeclarationTarget` refuses correctly but only at save time, with the user's edit already on the canvas
**Severity: LOW-MEDIUM**

`analyzeDeclarationTarget` (`analyzeDeclarationTarget.ts:125-215`) is genuinely good work — duplicate selector, duplicate declaration, shorthand override, `!important` override, each with a readable sentence. But it runs server-side inside `applyCssEdit` (`studioCssWriteback.ts:150-153`), i.e. **after** the user changed the value, saw the canvas update, and moved on.

The client has everything it needs to pre-check: the file path and selector are in `getStudioStyleRuleSources()`. It just doesn't have the file text.

**Proposed fix.** Compute the analysis server-side at *load* time (per rule per property is too much; per rule is enough — "this rule is duplicated / has a covering shorthand") and ship a per-rule `writeHazards` list on the load meta, so `ClassPropertyRow` can mark the affected properties before the edit.
**Effort: M.**

---

### S13 — `activeBreakpointId` defaults to `'desktop'` while board frames use a synthetic `'studio'` breakpoint that is not in `site.breakpoints`
**Severity: LOW** (latent landmine, currently inert)

`canvasSlice.ts:143` — `activeBreakpointId: 'desktop'`, never changed by the board. `getActiveStyleTab('desktop')` returns `'base'` (`cssControlTypes.ts:581-583`), so `activeContextId` is `null` and edits land in `cls.styles`. Correct today.

But `BoardFramesLayer.tsx:146-156` builds a synthetic breakpoint `{ id: 'studio', mediaQuery: '(max-width: 1024px)' }`, and `site.breakpoints` is `DEFAULT_BREAKPOINTS` = mobile/tablet/desktop (`breakpoint.ts:53-57`; `defaults.ts:44`). `createStyleRuleCssEmitter` **silently skips context ids matching neither registry** (`classCss.ts:367-375`, "Keys matching neither registry are skipped (orphaned overrides)").

So the moment anything sets `activeBreakpointId = 'studio'`, every class edit lands in `contextStyles.studio` and **disappears from the canvas entirely** — file changed, canvas unchanged, the exact failure mode `analyzeDeclarationTarget` exists to prevent. `styleRuleWriteback.ts:32-59` documents this having already happened once ("it made this whole feature write nothing at all, ever") and defends the *write* side via `effectiveStudioStyles`; the *render* side is undefended.

**Proposed fix.** Either register the synthetic studio breakpoint in `site.breakpoints`, or make `createStyleRuleCssEmitter` warn instead of silently dropping an orphaned context.
**Effort: S.**

---

### S15 — The effective-value view already exists, in a different sidebar, disconnected from editing
**Severity: HIGH** (it makes S2 an *integration* problem, not a *build* problem)

`src/admin/pages/site/panels/InspectPanel/useInspectComputedStyle.ts:62` does exactly what the Properties panel needs:
```ts
const computed = view.getComputedStyle(element)
```
resolving the selected node's **real rendered element inside the canvas iframe** and snapshotting ~30 properties (`:63-93`). Its own doc (`:2-3`) states the intent verbatim.

But it lives in the **left** sidebar (`sidebars/LeftSidebar/LeftSidebar.tsx:24-31, 144`), is lazy-loaded, and is strictly read-only. So the product currently ships:
- a **right** panel that lets you edit, showing authored values with fake defaults, no provenance, one target at a time;
- a **left** panel that shows the truth and lets you change nothing;
- no link between them.

That is the clearest possible statement of the user's complaint. It also carries its own documented staleness caveat (`useInspectComputedStyle.ts:26-32`: editing a shared class rule does not re-render it).

**Root cause.** Two features shipped in different work orders, each solving half of "inspect and edit."

**Proposed fix.** Do not build a second computed-style reader for §A. Promote `useInspectComputedStyle` into a shared hook under `src/admin/pages/site/panels/` (or `canvas/`), fix its invalidation to subscribe to `site.styleRules`, and consume it from `StyleSectionsEditor`. Then either fold the InspectPanel into the Properties panel or reduce it to the raw-computed-dump power-user view.
**Effort: M** (vs. **L** for §A from scratch — this materially reduces the S2 estimate).

---

### S14 — Positive findings worth not regressing

Recorded so a future refactor does not delete working machinery:
- `setDeclaration` is a real postcss CST round-trip that preserves comments, formatting, and untouched bytes (`setDeclaration.ts:1-49`). One-property edit → one-line diff.
- `analyzeDeclarationTarget`'s four refusals are the correct model of the cascade-vs-first-match disagreement.
- `cssModuleSource` (`studioCss.ts:206-222`) correctly inverts hashed CSS-Modules names back to source-local selectors and refuses when tokens span two module files.
- `canvasCssLayers.ts:1-81` gets the layer order right and documents the real defect (reset above vendor annihilated every design system).
- Ambient rules (`a:hover`, `.hero em`) **do** write back — `sources[id].selector` is the raw selector (`studioCss.ts:288`), and `resolveContainedCssPath` allows it.
- `resolveContainedCssPath` (`studioCssWriteback.ts:99-130`) is properly adversarial: absolute/UNC/drive-letter rejection, `..` on either separator, excluded dir names, realpath containment.

---

## PART 2 — UNIFIED STYLING UX SPEC

One coherent design. The organising principle: **the panel is an inspector of the live frame, and every edit names its target explicitly.**

### §A — One property list, sourced from the frame

Replace the three-way `storedStyles` ternary (`StyleSurface.tsx:174-178`) with a single model built per selected node:

```
EffectiveProperty {
  property:  'backgroundColor'
  computed:  'rgb(239, 68, 68)'        // getComputedStyle on the frame element
  winner:    StyleOrigin                // who is actually painting it
  layers:    StyleOrigin[]              // every declaration, cascade order, losers included
  writable:  WriteTarget[]              // where this panel could put a new value
}

StyleOrigin =
  | { kind: 'inline';    value, writable: boolean, refusalReason?: string }
  | { kind: 'class';     ruleId, selector, file?, value, specificity }
  | { kind: 'ambient';   ruleId, selector, file?, value, specificity }
  | { kind: 'vendor';    package, value }          // read-only
  | { kind: 'reset';     value }                   // Studio-injected, see S3a
  | { kind: 'utility';   className, value }        // Tailwind
  | { kind: 'inherited'; fromNodeId, value }
  | { kind: 'initial';   value }
```

New module: `src/admin/pages/site/panels/useEffectiveStyle.ts` — **built by promoting `InspectPanel/useInspectComputedStyle.ts`, not from scratch** (S15).
- `computed` from `getComputedStyle` on the real frame element — `useInspectComputedStyle.ts:62` already does exactly this; it needs a wider property set and correct invalidation on `site.styleRules` (its documented staleness bug, `:26-32`).
- `layers` by walking `document.styleSheets` inside the frame and testing `element.matches(rule.selectorText)`, plus `element.style`. This works because the injectors put real `<style>` tags in the frame — but it is only *honest* once S3 lands, because today those sheets are regenerated, not the user's.
- `writable` from `getStudioStyleRuleSources()` + `classifyStylesheetEditability` + the S10 inline-shape flag.

### §B — Every row shows value, source, and conflict

Each `ClassPropertyRow` gains a compact provenance affordance:

```
Background   [ #ef4444        ]  ● Element ▾
                                   └ overrides .card (#ffffff, Card.css)

Padding      [ 12px 24px      ]  ● .card ▾            Card.css
                                   └ also set by @acme/ui (lost)

Font size    [ 16px           ]  ○ inherited from <body>       (greyed)

Gap          [ 8px            ]  ⚠ .btn ▾   read-only — Tailwind utility
```

Rules:
- The **dot colour/shape encodes the winner's kind** — element, class, vendor, inherited, initial. One glyph, always in the same column.
- Losing declarations render as a **strikethrough sub-line**, always visible, never behind a hover.
- A value that comes from `inherited`/`initial` renders **greyed with the real computed value**, not a fake spec default (kills S2's placeholder lie).
- A row whose winner is unwritable carries the warning glyph and the *specific* reason (`classifyStylesheetEditability`'s sentence, or the S10 inline-shape reason, or "Tailwind utility").

### §C — The write target is a per-edit choice, not a mode

The `▾` on each row opens the write-target menu — this is the replacement for `StyleTargetChip`'s modal, mutually-exclusive design (S6):

```
Write this to…
  ● This element only  (style={{ }})            ✓ saves to Home.tsx
  ○ .card                                       ✓ saves to Card.css
  ○ .card-primary                               ⚠ CSS Modules compile of Card.module.css
  ○ .hero em  (ambient)                         ✓ saves to Hero.css
  ────────────────────────────
  ○ New class…                                  → asks which .css file
```

- Every option states its disk outcome inline, computed from `styleRuleSources` + `classifyStylesheetEditability` — the honest content `StyleTargetChip` already produces, moved to where the decision is made.
- The default target is **sticky per node** and shown in the header, not silently auto-picked by `pickAutoActiveSelectorId`.
- Choosing a class shows *how many elements it affects* before the write ("affects 14 elements on 3 pages").
- Class rows and inline rows are visible **at the same time**, always. Remove the `activeClass == null` term from `showInline`.

### §D — Class picker upgrade

- Group suggestions by **stylesheet file** (`Card.css`, `globals.css`, `Card.module.css`, `Tailwind utilities`, `Unsaved (this session)`) — `styleRuleSources` already has the file; the picker just needs to read it.
- Each row: selector · declaration summary (reuse `getSelectorStyleSummary`) · a swatch for the dominant colour/type · usage count · the file.
- Keep Recent/Frequent as a pinned top strip, not the primary grouping.
- "New class" opens a small dialog with a **target-file picker** (defaults to the nearest `.css` the page already imports; offers "create `<Page>.css` and import it").

### §E — The CSS-to-disk writeback design needed to make class editing real

Four pieces, in dependency order. Piece 1 is the unlock for everything.

**1. `setJsxClassName` codemod + `kind: 'class'` edit** *(fixes S1, S5-partial, unblocks S8)*
- `src/core/ast-codemods/setJsxClassName.ts`: `(file, line, col, { add: string[], remove: string[] })`.
- Shapes: absent attribute → add `className="a b"`. Literal string → token-level merge preserving order and existing whitespace. `className={styles.x}` / `cn(...)` / template / identifier → **refuse with a reason** (one honest target), except the narrow, safe case of `cn('literal', …)` where a literal argument exists to edit.
- `server/handlers/studioClassWriteback.ts`: `ClassEditSchema` + `applyClassEdit`, sibling of `studioCssWriteback.ts`, imported into `StudioEditSchema`'s union.
- `fsCodemodAdapter.saveSite`: a `classIds` diff against the load baseline (extend `loadedValuesBaseline.ts` with a per-node `classIds` snapshot), mapping ids → names via the inverse of `classIdsByName` (ship that map on the load meta line).
- Refusals ride the existing `REFUSAL_TITLES` channel.

**2. Rule lifecycle codemods** *(fixes S5)*
- `src/core/css-codemods/createRule.ts` — append a rule to a named `.css` file. `setDeclaration` already creates a missing rule at end-of-file (`setDeclaration.ts:125-128`); this needs a target-file decision (from §D) and, when the file is new, an `import './X.css'` insertion in the page `.tsx`.
- `renameSelector.ts` — postcss rename + a batched `setJsxClassName` across every node carrying the id. All-or-nothing: refuse if any call site is unwritable, exactly as `isPropPatchWritableToSource` does for props.
- `removeRule.ts` — postcss removal + `className` token removal at every site.

**3. Media-scoped declarations** *(fixes S7)*
- `CssEditSchema` gains `mediaQuery?: string`; `collectStyleRuleEdits` resolves it from `ConditionDef`/`Breakpoint`; `applyCssEdit` dispatches to `setDeclarationAtMedia` (already written and tested). Extend `analyzeDeclarationTarget` with an at-rule-scoped variant.

**4. Declaration removal** *(closes a documented hole)*
`styleRuleWriteback.ts:194-199` states a removed property is *left alone* because `setDeclaration` has no remove operation. Add `removeDeclaration(cssText, selector, property)` (trivial in postcss) and wire the `unset` path, so clearing a property in the panel actually clears it in the file.

**5. Rule identity must include the file** *(fixes S3d, prerequisite for honest grouping)*
`styleRuleId(kind, name)` (`studioCss.ts:114-116`) must become `styleRuleId(kind, name, file)` so two files defining `.button` produce two rules that cascade, rather than one that silently drops a block. This is a breaking change to a deterministic id and will churn `classIds` once — acceptable per CLAUDE.md's no-back-compat stance, but it must land in one change with `classIdsForClassName` (which then returns *all* matching ids in cascade order).

### §F — Effort / dependency summary

| Item | Fixes | Effort | Depends on |
|---|---|---|---|
| E1 `setJsxClassName` + `kind:'class'` | S1, S8-unblock | **L** | — |
| S4 inline-offer/write gate reconciliation | S4 | **S** | — |
| S10 parser records inline-style shape | S10 | **S** | — |
| S11 surface stylesheet warnings | S11 | **S** | — |
| S13 register/warn on orphan context | S13 | **S** | — |
| E3 media-scoped declarations | S7 | **M** | — |
| E4 `removeDeclaration` | — | **S** | — |
| E5 file-scoped `styleRuleId` | S3d | **M** | — |
| S9 picker grouping/summary/swatch | S9 | **M** | E5 |
| S15 promote `useInspectComputedStyle` to a shared hook | S15 | **M** | — |
| §A/§B effective-value + provenance engine | S2 | **M–L** | S15, S3 |
| S3 canvas fidelity (drop reset/Alm, inject real bytes) | S3 | **L** | — |
| §C per-row write-target menu | S6 | **M** | §A/§B |
| E2 rule lifecycle codemods | S5 | **M** | E1, §D file picker |
| S8 Tailwind utility mode | S8 | **L** | E1 |
| S12 pre-flight write hazards | S12 | **M** | — |

**Recommended first slice:** E1 + S4 + S10 + S11. That converts the four silent-data-loss paths into either real writes or honest refusals, which is the minimum bar for a tool whose thesis is "the repository is the document."
