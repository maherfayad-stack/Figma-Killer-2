# Canonical JSX

A documented subset of React that Studio reads perfectly and writes back losslessly.

Every limitation in [`docs/features/studio-import.md`](../features/studio-import.md) exists because the parser is reading code somebody else wrote — it has to cope with whatever shape it finds, without executing it. When Studio (or its agent) authors a new screen, it chooses the shape instead, and this page is that shape: ten rules, each tied to a specific, documented parser limitation, that together guarantee every node stays unlocked and every prop stays writable.

---

## TL;DR

- **Two paths.** The *import* path (`studio-import.md`) is best-effort against arbitrary React and stays best-effort. The *authoring* path (this page) is total — a canonical file round-trips losslessly, because Studio controls the shape it writes.
- **Ten rules**, enforced nowhere, checked on demand by `src/core/page-parser/canonicalCheck.ts`'s `checkCanonicalJsx`. The validator **reports, never blocks** — hand-editing a Studio-authored screen into non-canonical React is a legitimate choice; the tool says what you lose, it does not refuse the edit.
- **Two tiers, not a flat list.** Every rule is `'violation'` (the signal proves the rule is broken) or `'advisory'` (the signal cannot tell a permitted shape from a forbidden one, or the check is an admitted heuristic). **A canonical file is a file with zero `'violation'` findings — not zero findings.** Three rules (`literal-props`, `static-class-name`, `no-wrapper-elements`) are `'advisory'` and legitimately fire on conforming code; see "Two tiers" below and `summarizeCanonicalFindings`'s `isCanonical`.
- **npm design systems are the best case, not an exception** (§2). A component call with literal props is the single most canonical shape there is.
- **The validator is mostly a view over signals `parsePageFile.ts` already produces** (`lockReason`, `codeProps`, `codeText`, `branchAlternatives`), plus two genuinely new checks: the styling-mechanism scan and the wrapper-element heuristic. `single-return` reuses an existing signal but is broader than its name suggests — see its row below.
- **Several of the ten rules turned out to be imprecise once checked against the real parser** — each row below states the exact signal, and a "Validator caveat" where the checker's real behaviour diverges from the rule's one-line description. This is the honest accounting D5 asks for: report what's wrong or overstated rather than encode a fiction.
- **Verification target:** `studio-workspace/__canonical-fixture/` — a small, disk-committed reference project exercising every rule (canonical) and every rule's violation (non-canonical). It replaces any real corpus for this purpose; real projects stay import-path smoke tests only.

## Two tiers

`CanonicalRuleDef.tier` (`src/core/page-parser/canonicalCheck.ts`) is one of:

| Tier | Means | Rules |
|---|---|---|
| `'violation'` | The signal PROVES the rule is broken. Every shape it fires on is genuinely non-canonical. | `single-return`, `literal-text`, `const-array-map`, `no-spread-props`, `single-styling-mechanism`, `static-svg`, `direct-component-imports` |
| `'advisory'` | The signal cannot tell a PERMITTED shape from a forbidden one, or the check is an admitted heuristic that accepts false positives. Worth surfacing, never disqualifying. | `literal-props`, `static-class-name`, `no-wrapper-elements` |

`summarizeCanonicalFindings(findings)` turns a `CanonicalFinding[]` into `{ violations, advisories, isCanonical }`, where `isCanonical` is `violations === 0`. **This is the one signal step 4's scaffolder and WS-12's agent should check** — not a raw finding count, and not "zero findings", which no real canonical screen using CSS Modules will ever show (its `styles.x` usage is a legitimate, expected `static-class-name` advisory on every styled node).

**Do not "fix" an advisory finding by suppressing it.** The detection is accurate — `className={styles.card}` genuinely cannot be typed over in the Properties panel — only its severity is not "broken". If a rule's signal turns out to have a real false positive that should not be flagged AT ALL, that is a detection bug to fix in `canonicalCheck.ts`, not a tier to change.

---

## The ten rules

Each rule: the statement (verbatim from the WS-13 spec), a canonical example, a non-example, and the exact mechanism `checkCanonicalJsx` uses to detect a violation — cross-referenced to the underlying parser signal from `docs/features/studio-import.md`.

### 1. `single-return` — One `return`

**Tier:** violation

**Rule.** No top-level conditional rendering, no multi-stage screens.

```jsx
// canonical
export default function Confirmation() {
  return <section className="confirm">Booked</section>
}
```

```jsx
// non-example
export default function Confirmation() {
  if (loading) return <Spinner />
  return <section className="confirm">Booked</section>
}
```

**Detection.** `node.branchAlternatives` non-empty. This is set on the node the parser *selected* (`getReturnedJsxRoots`/`selectJsxBranch`, [`branchSelection.ts`](../../src/core/page-parser/branchSelection.ts)) whenever there was more than one `return`, or a `? :`, `&&`, `||`, or `??` in the JSX carried an untaken alternative. It never locks the node — the parser is certain of the *structure*, it only chose which runtime state to show by default — so this is an informational finding, matching `BRANCH_AUTO_SELECTED` (`fidelityCodes.ts`).

**Validator caveat.** The rule's title says "one `return`", but the signal it reuses fires identically for a *nested* ternary/`&&`/`||`/`??` one level into the JSX (parser-06/07), not only for a component with more than one top-level `return`. A canonical screen therefore also avoids `{cond ? <A/> : <B/>}` anywhere in its own JSX, not just at the top.

---

### 2. `literal-props` — Props are literals or module-scope `const`s

**Tier:** advisory — the signal cannot tell a permitted module-scope `const` reference from a forbidden one (hook state, an unresolvable expression); see the caveat below.

**Rule.** Props are literals or module-scope `const`s.

```jsx
// canonical
<Button variant="primary" size="large">Book now</Button>
```

```jsx
// non-example
<Button variant={selectedVariant}>Book now</Button>   // selectedVariant: useState
```

**Detection.** `node.codeProps` contains an entry other than `className` (its own rule, §6) or `svg` (raw markup, not an attribute — §8's business). Every remaining entry is a prop or inline-style property (`style:<property>`) Tier A/B/C had to resolve rather than read as a literal — the same signal `CODE_VALUED_PROP` reports (`fidelityCodes.ts`). Skips any node produced inside a `.map` expansion — the loop row itself, or a component inlined into it reading the loop's own per-item parameter (a node id containing the loop separator `#` anywhere, at any level of composite inlining) — because that value is data-derived by construction; see rule 4.

**Validator caveat.** `ParsedNode.codeProps` records *that* a prop resolved from a non-literal expression, never *why*. A prop that is a bare reference to a module-scope `const` — `variant={DEFAULT_VARIANT}` — is exactly the shape this rule permits, but it still resolves through the evaluator and still lands in `codeProps`, so the checker flags it too. This is a genuine limitation of the current signal, not a design choice: distinguishing "identifier bound to a plain const" from "hook state" would need per-prop provenance `ParsedNode.resolution` does not carry (it records only the *first* resolution on a node — see `docs/features/studio-import.md`'s "Resolved TEXT is editable, at its origin"). Prefer a literal when you want zero findings on this specific prop; a const reference stays canonical either way (this is `tier: 'advisory'`, never `'violation'`), it just surfaces an advisory pointing at the panel field that stays read-only.

---

### 3. `literal-text` — Text is a literal string in the JSX

**Tier:** violation — no const exception exists for text (unlike rule 2), so the signal has no permitted-but-flagged case.

**Rule.** Text is a literal string in the JSX.

```jsx
// canonical
<h1>Book your trip</h1>
```

```jsx
// non-example
<h1>{TITLE}</h1>   // TITLE is a module-scope const — still not a JSX literal
```

**Detection.** `node.codeText === true`. Set whenever the node's text came from *any* expression rather than a literal `JsxText` node or a `{"..."}`/`{'...'}` string-literal expression container (`extractSingleText`, [`jsxAttributeReaders.ts`](../../src/core/page-parser/jsxAttributeReaders.ts)) — independent of whether that expression also resolved to a writable `textOrigin`. Skips a `.map`-derived node, same exclusion as rule 2 — a list row's own item text (`{plan.name}`) is data-derived, not hand-authored, and is `const-array-map`'s fact to report.

**Validator caveat.** Unlike rule 2, this rule has no const exception, and the checker is exact about it: `codeText` is `true` even for a fully-resolved, perfectly-editable dictionary lookup (`{c.hotelsTag}`, writable at its `textOrigin`). That asymmetry is deliberate in the WS-13 spec (rule 2 says "literals or module-scope consts"; rule 3 says only "a literal string") — text authored for a *new* screen should be a literal, full stop; i18n dictionaries are an import-path concern, not an authoring-path one (§2.2).

---

### 4. `const-array-map` — `.map` only over a module-scope `const` array

**Tier:** violation — broader than "`.map`" alone (see the caveat), but every construct the signal catches is genuinely non-canonical.

**Rule.** `.map` only over a module-scope `const` array.

```jsx
// canonical
const PLANS = [{ id: 'starter', name: 'Starter' }, { id: 'team', name: 'Team' }]
// …
{PLANS.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
```

```jsx
// non-example
{fetchPlans().map((plan) => <PlanCard key={plan.id} plan={plan} />)}
```

**Detection.** `node.lockReason === 'dynamic — rendered in code'` (`DYNAMIC_LOCK_REASON`, exported from [`parsePageFile.ts`](../../src/core/page-parser/parsePageFile.ts)) — the same reason `DYNAMIC_CONTENT_UNRESOLVED` reports. A `.map` over a fully Tier-A-resolved array does **not** produce this: [bounded loop expansion](../features/studio-import.md#bounded-loop-expansion--not-tier-d) walks the array and locks each *row* with `item N of <source>`, a different, non-error reason `classifyLockReason` (`fidelityReport.ts`) already treats as a success, not a finding.

**Validator caveat.** `DYNAMIC_LOCK_REASON` is not narrowly scoped to `.map` — it fires for *any* JSX-producing construct `selectJsxBranch` does not own that the walk meets while descending (`isLockingExpression`: any `CallExpression`, including a `.map` over unreadable data, but also any other unresolvable call that happens to sit where JSX is expected). The rule's title undersells the mechanism the same way `single-return`'s does.

---

### 5. `no-spread-props` — No `{...spread}`

**Tier:** violation — exact.

**Rule.** No `{...spread}`.

```jsx
// canonical
<img src={heroSrc} alt="Hero" />
```

```jsx
// non-example
<img {...imgProps} />
```

**Detection.** `node.lockReason === 'spread props'` (`SPREAD_LOCK_REASON`) — exact match to `SPREAD_PROPS_UNRESOLVED`. No caveat: this one is precise. (One scoping note, not a checker limitation: a spread on an element *inside* a `.map` row is invisible to this specific check, because the row's own `item N of …` lock reason always takes priority over `spread props` — `processElement`'s inherited-lock branch never re-derives a more specific reason once a row is already locked. The spread is still real and the row is still unwritable; it is simply reported under rule 4, not rule 5.)

---

### 6. `static-class-name` — `className` is a static string or `styles.x`

**Tier:** advisory — fires on the permitted `styles.x` shape too, and the genuinely-dynamic (forbidden) case is invisible in both directions; see the caveat below.

**Rule.** `className` is a static string or `styles.x`.

```jsx
// canonical
<div className="hero">…</div>
<div className={styles.hero}>…</div>   {/* CSS Modules — Tier 0 safe */}
```

```jsx
// non-example
<div className={DANGER_CLASS}>…</div>          {/* a const identifier — neither shape */}
<div className={`hero hero--${size}`}>…</div>  {/* computed interpolation */}
```

**Detection.** `node.codeProps` includes `'className'`. Skips a `.map`-derived node, same exclusion as rules 2 and 3.

**Validator caveat — read this before treating a `static-class-name` finding as a problem.** This signal cannot distinguish the *permitted* `styles.x` shape from any other non-literal `className`: both resolve through the same evaluator path in `extractProps` and both land in `codeProps` the same way, because `className={styles.card}` genuinely is not typeable-over in the Properties panel (it is bound to the CSS-Modules import, exactly like any other resolved prop). That is exactly why this rule is `tier: 'advisory'`, not `'violation'` — **a canonical screen using CSS Modules will show a `static-class-name` finding on every styled node, and `summarizeCanonicalFindings` still reports it `isCanonical`.** The finding means "read-only in the panel", not "non-canonical"; edit the class in the CSS Classes panel instead. The genuinely non-canonical case — a `className` interpolation that fails to resolve *at all* (no static prefix, no fallback) — is invisible to this rule in either direction: `extractProps` silently drops the attribute (no `props` entry, no `codeProps` entry) rather than recording anything, so the node simply renders with no class and no signal fires. `docs/features/studio-import.md`'s claim that such a case "keeps only its static prefix" describes `StaticValue`'s internal `partial` field (`staticEvalValues.ts`'s `unresolved(reason, partial)`), which no caller of `tryResolveExpression` ever reads back out — the static-prefix fallback is real only inside `componentSubstitution.ts`'s call-site `className` re-read during local-component inlining, not in the ordinary `extractProps` path this rule is scoped to.

---

### 7. `single-styling-mechanism` — One authored styling mechanism: plain CSS or CSS Modules

**Tier:** violation — a textual import-specifier scan; when it matches, the import is genuinely there.

**Rule.** One *authored* styling mechanism: plain CSS or CSS Modules. Governs the CSS you write — not CSS a package ships (§2.1).

```jsx
// canonical
import './Screen.css'
import styles from './Card.module.css'
```

```jsx
// non-example
import './Screen.scss'
import styled from 'styled-components'
```

**Detection.** A genuinely new check — `ParsedNode` carries no import information, so this scans the page's *own* raw source text for a relative Sass/Less stylesheet import (`\.(scss|sass|less)`) or a CSS-in-JS package import (`styled-components`, `@emotion/styled`, `@emotion/react`, `@emotion/css`, `@stitches/react`) — the same specifier set `ProjectProfile.styleToolchain.cssInJs` names. Requires `sourceText` (the page's own file content); the check is skipped, not guessed at, when it is not supplied.

**Validator caveat.** Deliberately does **not** attempt to detect Tailwind utility-class soup in a `className` string — a hyphenated-token heuristic would be indistinguishable from an ordinary BEM class name and would false-positive on nearly every real screen. Tailwind usage is a *project-level* fact (`ProjectProfile.styleToolchain`, from the probe), not a per-page one the parser can see; a Tailwind-authored screen currently passes this check silently. Detecting it belongs in the project probe, not here.

---

### 8. `static-svg` — Inline `<svg>` is static JSX

**Tier:** violation — only reachable past 64 KB of serialized markup, so no false positives.

**Rule.** Inline `<svg>` is static JSX.

```jsx
// canonical
<svg viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10" />
</svg>
```

```jsx
// non-example — only detectable at scale, see caveat
// an <svg> whose serialized markup exceeds 64 KB
```

**Detection.** `node.lockReason === 'SVG built in code'` (`DYNAMIC_SVG_LOCK_REASON`) — matches `SVG_BUILT_DYNAMICALLY`.

**Validator caveat — this rule's detectable surface is much narrower than its title suggests.** `serializeInlineSvg` ([`inlineSvg.ts`](../../src/core/page-parser/inlineSvg.ts)) *omits* an unresolvable attribute or child rather than failing the whole element — `<svg><circle strokeDashoffset={f(props.pct)} /></svg>` still serializes (missing that one attribute), it does not lock. The lock reason is reachable, for a JSX-authored `<svg>`, only when the total serialized markup exceeds `MAX_MARKUP_LENGTH` (64 KB) — an edge case too large to commit as a small fixture, so `canonicalCheck.test.ts` exercises it with a synthetically generated (not disk-committed) source file rather than via `studio-workspace/__canonical-fixture/`. The *other* documented dynamic-SVG shape — `dangerouslySetInnerHTML={{ __html: applyTokens(svg) }}` where the transform's own fallback also fails — does not reach `DYNAMIC_SVG_LOCK_REASON` at all: `extractRawSvgMarkup` returning `undefined` simply means the element falls through to ordinary (non-svg) processing, with no lock and no `svg` prop. That shape is real, and currently invisible to this rule.

---

### 9. `direct-component-imports` — Components are imported directly

**Tier:** violation — rare, but exact when it fires: the tag's identifier genuinely could not be traced.

**Rule.** Components are imported directly — local or from an npm package.

```jsx
// canonical
import { PlanCard } from '../components/PlanCard'
import { Button } from '@alm-design/design-system'
```

```jsx
// non-example — a tag whose identifier resolves to nothing in scope
<UndeclaredWidget />
```

**Detection.** Needs `componentSources` — the `Record<nodeId, ComponentSource>` `resolveComponentSources` ([`componentSources.ts`](../../src/core/page-parser/componentSources.ts)) computes for the *same* page against a workspace-wide `Project`. A `kind: 'component'` node whose id is absent from that map violates the rule; the check is skipped entirely (no findings, not a guess) when `componentSources` is not supplied.

**Validator caveat.** JSX syntax itself already rules out most non-canonical shapes — a tag name must be a `JSXIdentifier` or `JSXMemberExpression`, so `<Components[key]/>` cannot be written at all. What remains detectable is a genuinely undeclared/untraceable identifier (a bug, or a global injected by a mechanism `resolveComponentSources` does not follow), which is rare in practice — most real violations of this rule's *spirit* (a dynamically-selected component) are not expressible in JSX in the first place, so they don't need a check.

---

### 10. `no-wrapper-elements` — No wrapper elements added around content

**Tier:** advisory — an admitted heuristic that accepts a false positive (see the caveat below).

**Rule.** No wrapper elements added around content.

```jsx
// canonical
<PlanCard plan={plan} />
```

```jsx
// non-example
<div>
  <PlanCard plan={plan} />
</div>
```

**Detection.** A genuinely new heuristic: an `element`-kind node that is not `locked`, has exactly one child, and carries no props, no inline styles, and no text of its own — a node whose only observable purpose is to hold its one child — is flagged as a likely unnecessary wrapper.

**Validator caveat.** This is a heuristic, not a proof, and it is stated as one in the code. A wrapper carrying only an event-handler prop (`onClick`) looks identical to one carrying nothing at all, because a function value is never captured in `ParsedNode.props` (`staticValueToPropValue` drops it, never stubs it) — a false negative the rule accepts rather than special-case. Locked nodes are skipped outright: their structure was not freely chosen by whoever wrote this JSX (a `.map` row, an inlined component's own root), so flagging them as an "inserted" wrapper would misattribute intent that isn't there.

---

## npm design systems are the best case, not an exception

Nothing in the ten rules above restricts design-system usage — a design-system call with literal props is **the single most canonical shape there is**:

```jsx
<Button variant="primary" size="large">Book now</Button>
```

Every prop is a literal, so Tier A resolves every one of them, every prop is writable, the node is unlocked, and no fidelity code fires at all. Compared with a hand-rolled `<div>` carrying a computed `className`, this is strictly better on every axis the subset cares about — the canonical subset actively pushes toward design systems, not away from them.

Three mechanisms are involved when a design-system component is used, and only one is trust-gated:

| | What | Trust |
|---|---|---|
| **The package's CSS** | A bare-specifier `.css` import resolved against the project's own `node_modules`, injected read-only as `@layer vendor`, ordered *below* the editable `user-authored` layer | **Tier 0** — a text scan and a file read |
| **`@alm-design/design-system` components** | Compiled into Studio's own bundle (`src/modules/alm/register.tsx`) | **Tier 0** — works on a fresh import, no promotion |
| **Any other npm package's components** | `componentBundle.ts` runs `Bun.build` over the workspace's real code | **Tier 1** — refuses at Tier 0 with `trust-tier-required`, because a package can execute a macro at build time |

So: ALM works today with no trust promotion. Another design system needs one consent click to promote the project, and then works the same way. Either way their CSS renders at Tier 0.

The `@layer vendor` / `user-authored` split is why rule 7 says *authored* — a package's stylesheet lives in a read-only layer beneath the user's own, so it never counts as a second styling mechanism under rule 7. A screen's own CSS Module and a design system's shipped CSS coexist by design.

**The one genuinely restricted case** is a design-system prop that takes a runtime value — `<Chip label={t(key)}>`. That prop comes back read-only under rule 2, same as anywhere else in the subset. Pass a literal, or a module-scope const (with rule 2's caveat above in mind).

**The instance stays linked to the package.** Inserting a design-system component writes a real `import` into the user's source (`sourceImport: { specifier, name }` on the module definition) — there is no generated copy and no inlined markup. Bumping the package version updates every screen that uses it, because each screen references the package the same way any hand-written React file would.

**Restyling it, in order of preference:** the package's own design tokens (`tokenExtract.ts` reads a `vendor-css` `:root` layer into the Framework panel), then the screen's own CSS (the `user-authored` layer sits above `@layer vendor`, so it overrides without `!important`), then props exposed as variants — the most canonical of the three.

---

## What this subset costs, stated plainly

A canonical screen is a static composition. Interactivity, data fetching, and conditional states live in the surrounding app or inside components the screen imports — not in the screen file.

That is a real constraint and it should not be soft-pedalled. It is also the right one: a design tool's frame *is* a static composition. Figma has no `useState` either. The screen file is the design; behaviour belongs to the app around it.

Where a screen genuinely needs a stateful piece, it imports a component that owns that state. The screen stays canonical; the component is ordinary React and is rendered as an instance — Tier D (hook state, effects, async, JSX branch selection by evaluation) stays banned everywhere in this module, for imported code and authored code alike.

---

## The validator

`checkCanonicalJsx` (`src/core/page-parser/canonicalCheck.ts`) takes a `CanonicalCheckInput`:

```ts
interface CanonicalCheckInput {
  page: ParsedPage
  sourceText?: string                              // rule 7 only
  componentSources?: Record<string, ComponentSource> // rule 9 only
}
```

and returns `CanonicalFinding[]` — `{ ruleId, tier, nodeId, file, line, col, message }`, sorted by source position. It never throws (every check is a plain read over already-parsed data) and it never mutates or refuses anything — **it reports, never blocks (D5)**. Running it against an arbitrary imported repo produces a wall of findings that mean nothing, because that repo was never trying to be canonical; it is meant to run on demand against files Studio (or its agent) authored.

`CANONICAL_JSX_RULES` is the registry — one `{ id, title, description, because, tier }` entry per rule above. `canonicalCheck.test.ts` gates doc ⇄ registry parity exactly the way `fidelityCodes.test.ts` gates the fidelity-code table: every rule id AND its tier must match between this doc and the registry.

**`summarizeCanonicalFindings(findings)`** returns `{ violations, advisories, isCanonical }` — the single signal a caller should act on (step 4's scaffolder, WS-12's agent's self-check) instead of raw findings. See "Two tiers" above.

### Verification corpus

`studio-workspace/__canonical-fixture/` is a small, disk-committed reference project — **not user data**, unlike every other directory under `studio-workspace/`. It is named with a leading `__` specifically so that distinction is visible in a directory listing. It contains:

- `src/screens/CanonicalScreen.tsx` — one screen exercising the canonical shape of every rule that has one (rule 6's `styles.x`/CSS-Module usage included, with the expected `'advisory'` finding noted in a comment — it does not stop the screen from being `isCanonical`).
- `src/screens/NonCanonicalScreen.tsx` — one screen with a clearly labelled section per rule, each violating exactly that rule.
- `src/components/PlanCard.tsx` + `PlanCard.module.css`, `src/data/plans.ts`, `src/screens/CanonicalScreen.css`/`.module.css` — the supporting local component, module-scope data, and stylesheets the two screens above need.

`canonicalCheck.test.ts` parses both screens directly (`parsePageFile` + `resolveComponentSources`, the same pipeline `loadStudioPages` runs) and asserts, per rule, that the canonical node produces no finding for that rule and the non-canonical node does. The 64 KB oversized-SVG case (rule 8) is the one exception — generated at test time rather than committed, to keep the fixture small and reviewable in a diff.

---

## Related

- `docs/features/studio-import.md` — the import path and every underlying parser signal this page's checks reuse.
- `docs/agent-refs/studio-pipeline.md` — the compressed pipeline reference.
- `server/ai/mcp/tools/studio/fidelityCodes.ts` — the sibling registry this module's pattern is copied from.
- Source of truth: `src/core/page-parser/canonicalCheck.ts`.
- Gate test: `src/core/page-parser/__tests__/canonicalCheck.test.ts`.
- Verification fixture: `studio-workspace/__canonical-fixture/`.
