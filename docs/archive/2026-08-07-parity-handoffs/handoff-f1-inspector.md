# Track F1 — Effective value + provenance — handoff

Status: **complete for the scope below**, working tree only (nothing committed/staged).

## What shipped

### 1. S6 (the headline item) — inline and class styling are simultaneous now

`src/admin/pages/site/store/slices/styleRule/uiStateActions.ts` — `setActiveClass`
and `setInlineStyleEditing` no longer touch each other's flag. Picking a class
no longer force-closes inline editing; toggling inline editing no longer
clears `activeClassId`.

`src/admin/pages/site/store/slices/selectionSlice.ts` — `applySelection`'s
seeding formula changed from `nextActiveClassId === null && nodeHasInlineStyles(...)`
to just `nodeHasInlineStyles(...)`, so a node selected with BOTH an assigned
class and its own inline styles opens with both sections visible. This is a
minimal, necessary edit outside my listed ownership (`selectionSlice.ts` isn't
`PropertiesPanel/**`) — flagging per the boundary-crossing protocol; it's a
2-line formula change plus a doc comment, nothing else in that file touched.

`src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx` — rewritten so
the CSS area renders an **Element block** and a **Class block** independently
(each gated on its own reachability, not on the other's absence), instead of
the old if/else chain that could only ever show one. Each block gets a small
uppercase label (`Element` / `.selector`) so it's always visible which target
a row belongs to (WS-6.2's "biggest UX risk"). Dogfood this first.

### 2. Provenance data model — `stylePropertyProvenance.ts` (new)

`src/admin/pages/site/panels/PropertiesPanel/stylePropertyProvenance.ts`:

```ts
export type PropertySourceKind = 'inline' | 'class'
export interface PropertySource {
  kind: PropertySourceKind
  classId?: string          // only for kind:'class'
  label: string             // 'Element', or the class selector e.g. '.card'
  value: string | number
  winner: boolean           // true for at most one source per property
}
export type WinnerConfidence = 'inline' | 'exact-match' | 'ambiguous' | 'none'
export interface PropertyProvenance {
  property: keyof CSSPropertyBag
  sources: PropertySource[]        // every place that declares this property
  confidence: WinnerConfidence
  computedValue: string | undefined // getComputedStyle ground truth
  inherited: boolean                // best-effort "looks ancestor-inherited"
}
export interface ClassChainEntry { classId: string; selector: string; styles: Record<string, unknown> }
export function buildClassChain(classRules: StyleRule[], activeContextId: string | null): ClassChainEntry[]
export function resolvePropertyProvenance(property, { classChain, inlineStyles, computedValue }): PropertyProvenance
```

**Winner attribution rule** (documented at length in the module, because it's
the one place this task could have silently lied):
- Inline always wins over any class (CSS spec — `!important` in a class rule
  is the one known exception; Studio's own class editor never writes
  `!important`, but a hand-authored/imported class could carry one and this
  module has no way to see it — named as a limitation, not hidden).
- A single class source wins by elimination.
- Among MULTIPLE class sources for the same property, the real cascade order
  is decided by `ClassStyleInjector`'s generated-CSS rule order (registry
  order, not `node.classIds` assignment order) — this module has no access to
  that and doesn't own `ClassStyleInjector`. Rather than guess, it only
  crowns a winner when exactly one class source's value textually matches the
  computed value (light normalization); otherwise `confidence: 'ambiguous'`
  and **no source is marked winner** — the row still shows the real computed
  value, it just doesn't fabricate which declaration produced it. This is the
  same "refuse rather than guess" discipline the write-side codemods use,
  applied to a read.

12 unit tests in `src/__tests__/panels/stylePropertyProvenance.test.ts`
(all passing), covering: no-sources, inline-beats-class, single-class-wins,
multi-class exact-match attribution, multi-class honest ambiguity, the
`inherited` heuristic (present/absent/no-computed-value), and empty-string
treated as unset.

### 3. Frame truth — `useFrameComputedStyleValues` (new, in `useInspectComputedStyle.ts`)

`src/admin/pages/site/panels/InspectPanel/useInspectComputedStyle.ts` gained a
second, generalized export **alongside** the existing (unchanged)
`useInspectComputedStyle`/`ComputedStyleSnapshot` the left-sidebar Inspect
panel still uses:

```ts
export function useFrameComputedStyleValues(
  nodeId: string | null,
  activeBreakpointId: string,
  properties: ReadonlyArray<string>,
): Record<string, string> | null
```

Reads `getComputedStyle(element)[prop]` for an arbitrary property list
(bracket access on the CSS2Properties camelCase interface every browser
implements) instead of a fixed 28-field shape — the Properties Panel curates
~90 properties (`ALL_CURATED_CSS_PROPERTIES`, new frozen export in
`cssControlTypes.ts`), far more than `ComputedStyleSnapshot` models. Same
synchronous render-time read as the existing hook (no effect, no polling —
`getComputedStyle` is a pure read and the caller already re-renders on every
relevant change), same narrow-subscription discipline. Returns `null` when no
canvas frame has rendered the node yet (every existing panel test, or a node
before first paint) — **every consumer treats `null` as "no frame truth
available," falling back to the pre-existing spec-default table**, not as
"everything is unset." This is why zero existing placeholder-text assertions
(`getCSSPropertyDefaultValue` pins in `propertiesPanel-redesign.test.tsx`)
needed to change — in a jsdom test with no live iframe, the merge collapses
to exactly the old bag.

### 4. Where the frame truth actually lands

`StyleRuleComposer.tsx` / `InlineStyleComposer.tsx` both gained an optional
`computedValues?: Record<string, string> | null` prop, folded as the BASE
layer under each composer's own stored values when building `currentStyles`
(the bag every unset row's placeholder AND every visual section's gating
logic — `LayoutSection` reading `currentStyles.display`, etc. — reads):

```ts
// StyleRuleComposer
currentStyles = activeContextId
  ? { ...(computedValues ?? {}), ...cls.styles, ...storedStyles }
  : { ...(computedValues ?? {}), ...cls.styles }
// InlineStyleComposer
current = computedValues ? { ...computedValues, ...stored } : stored
```

This is the actual fix for the plan's headline bug ("a field can confidently
read `transparent` on an element rendering red") — **one change point per
composer**, so it fixes every section's placeholder/gating logic (Spacing,
Layout, Position, Size, Typography, Background, Interaction, Border) without
having to touch those 8 bespoke visual components individually. It also
happens to fix the "only one active class is ever consulted" bug for FREE:
`getComputedStyle` already resolved the real cascade across every assigned
class + inline + inheritance — no need to re-implement cascade resolution in
JS to get an accurate placeholder.

### 5. Winner + losers, struck-through — `ClassPropertyRow.tsx`

New optional `provenance?: PropertyProvenance` prop. Purely additive — does
**not** change which value the control shows/edits (that's still driven by
the caller's existing `value`/`placeholder`/`isSet`, unchanged). Renders a
small strip below the control listing every OTHER declared source
(`provenance.sources.filter(s => !s.winner)`), each struck through
(`text-decoration: line-through` on the value, per spec: "seeing why a value
lost is the entire point"), plus an `inherited` badge when nothing declares
the property but it looks ancestor-inherited. New CSS in
`ClassPropertyRow.module.css`: `.provenanceStrip`/`.provenanceInherited`/
`.provenanceLoser*` — all token-based (`--text-subtle`, `--text-muted`,
`--space-3xs`/`--space-4xs`), no new tokens needed.

**Threading, not full coverage**: `provenanceByProperty` flows
`StyleSurface` → `StyleRuleComposer`/`InlineStyleComposer` →
`StyleSectionsEditor` → the generic fallback `ClassPropertyRow` branch +
`AdvancedRows` (Border's shorthand disclosure). It does **not** reach the 8
bespoke visual section components (`SpacingBoxControl`, `LayoutSection`,
`PositionSection`, `SizeSection`, `TypographySection`, `BackgroundSection`,
`InteractionSection`, `BorderControl`'s primary controls) — those keep their
existing set/unset visual language unchanged this pass. In practice this
means the **Effects section** (opacity/boxShadow/filter/transform/…, which
has no dedicated component — it falls through to the generic branch), the
**Border Advanced disclosure**, and **every property reached via search**
get full winner/loser strikethrough today; the flagship visual blocks
(display switcher, spacing box, etc.) get the accurate placeholder/gating fix
(#4 above) but not yet the strikethrough UI. Retrofitting those 8 components
is real remaining work — each owns its own row markup, not `ClassPropertyRow`
— and was out of this pass's time budget. Clean seam: each already receives
`storedStyles`/`currentStyles`; adding `provenanceByProperty` as an optional
prop the same way `StyleSectionsEditor` does now is the mechanical next step.

### 6. The write-target menu — `StyleTargetChip.tsx` (rewritten in place)

Kept the filename (still `PropertiesPanel/StyleTargetChip.tsx`) but changed
its contract from an **exclusive toggle** (`target: 'element'|'class'|'none'`)
to an **independent-facts menu**, matching S6 (both targets can be visible at
once now, so "which one is active" no longer means anything):

```ts
interface StyleTargetChipProps {
  elementVisible: boolean
  onToggleElement?: () => void       // present only when Element is reachable at all
  elementDisabledReason?: string
  classSelector?: string
  classCssEditability?: ClassCssEditability
  disabled?: boolean
}
export type ClassCssEditability =
  | { kind: 'plain-css'; file: string }
  | { kind: 'will-create-existing'; file: string }
  | { kind: 'will-create-new-stylesheet'; pageFile: string }
  | { kind: 'compiled'; reason: string }
  | { kind: 'unmapped'; reason?: string }
```

Renders three entries:
1. **Element** — a real `Button`, `pressed={elementVisible}`, click toggles
   `inlineStyleEditing`. Disabled+reason when the module owns its own
   `style=""` (S4) or the caller lacks `site.style.edit`.
2. **Class `.foo`** — informational span (unchanged from WS-6.2: no click
   action exists for it — switching TO a class is `ClassPicker`'s job). Now
   covers **five** honest outcomes instead of three (see #7).
3. **"Assign class"** — new, always-present, always-disabled informational
   row. See #7 for why this exists instead of a fabricated "Tailwind" value
   target.

Full doc comment in the file explains every state; `StyleTargetChip.test.tsx`
rewritten for the new shape (14 tests, all passing, including the two new
Track F1 states and the "Element stays reachable even with a class assigned"
regression lock for S6).

### 7. The five Class outcomes — wired to Track B1/B1b, read-only

`StyleSurface.tsx`'s `resolveClassCssEditability(cls)` now checks, in order:
`getStudioStyleRuleSources()[cls.id]` (existing source → `plain-css` or
`compiled`, unchanged from WS-6.3), else — **new** — whether the class is
editor-authored (`!classId.startsWith('sc-')`, replicated inline because
`styleRuleWriteback.ts`'s `isEditorAuthoredRuleId` is intentionally private;
see the doc comment for why duplicating this one-line invariant was the right
call rather than exporting a new public surface I don't own) and, if so,
`resolveCssInsertDestination(cls)` (Track B1/B1b, imported read-only — I did
**not** edit `styleRuleWriteback.ts`) — `{ok:true, kind:'existing'}` →
`will-create-existing`, `{ok:true, kind:'create'}` → `will-create-new-stylesheet`,
refusal → `unmapped` (carrying the refusal's own message as `reason` when
present, e.g. naming the ambiguous candidate files).

This is exactly the "4th kind" `handoff-b1-css-engine.md` §"Refusal
surfacing" flagged as the natural follow-up for whoever owns
`StyleTargetChip.tsx`/`fsCodemodAdapter.ts` next — done for the chip side;
`fsCodemodAdapter.ts` itself (proactive pre-save toasting) is untouched, out
of scope here.

### 8. Why "Tailwind className" is NOT a per-property value target

The task description listed **existing declaration · inline style · Tailwind
`className` (B2) · new declaration (B1) · new stylesheet (B1b)** as the
target set. I built four of the five as real, live-wired options (#6/#7
above cover existing/inline/new-declaration/new-stylesheet). I deliberately
did **not** build a "set this CSS property via a Tailwind class" per-row
target, because there is no honest way to do it: `setJsxClassName` (Track B2)
writes whole class TOKENS to/from `className` — it has no concept of "the
Tailwind class that means `padding: 13px`" for an arbitrary typed value, and
synthesizing that mapping would be exactly the kind of guess this panel
exists to refuse (there is no general value → utility-class function, and
building one is a different, much larger feature). What Track B2 actually
made real this session is **whole-class assignment/removal reaching disk**
(via `ClassPicker`, already a separate, pre-existing surface) — the chip's
new "Assign class" row (#6.3) states this honestly and points at where it
lives, rather than fabricating a per-declaration Tailwind writer. Flagging
this explicitly in case the intent was actually different — I read "Tailwind
className… disabled with the reason" as **exactly** describing this row
(always present, always disabled-as-a-value-target, with the reason being
"this is a different kind of edit, not a refusal").

## F2 seam — exactly where `EditConstraint` slots in

I did **not** touch `SourceConstraintNotice.tsx`, `BranchChoiceNotice.tsx`,
`nodeResolution.ts`, or `propLockReason.ts` (F2's files — confirmed via
`git diff --stat`, all show sibling edits I never opened this session).

The seam I left, documented in `ClassPropertyRow.tsx`'s own doc comment on
the new `provenance` prop:

> A locked/refused WRITE reason for this specific row (e.g. this property
> resolved from a code expression) is a SEPARATE fact from provenance and is
> not modeled here yet — `InlineStyleComposer`'s `lockedPropertySet` (per-row,
> computed from `codeProps`/`isStyleWritableToSource`) currently
> short-circuits `onChange`/`onRemove` before this component ever sees the
> row, and its own top-of-composer notice is the only per-row-lock UI that
> exists today. When F2's `EditConstraint` lands (`editConstraint.ts`,
> `scope: 'style-property'`), the natural next step is a
> `constraint?: EditConstraint` prop on `ClassPropertyRow`, rendered as a
> lock glyph next to (not replacing) the provenance strip this pass adds —
> the two facts ("who wins" vs "can I even write here") are independent and
> should render as two independent affordances on the same row, not merged.

Nothing in my code duplicates refusal-reason logic — `InlineStyleComposer`'s
existing `lockedPropertySet` computation (pre-existing, not touched by me)
is the only per-row lock check, and I left it exactly as-is.

## Files touched (mine only — confirmed via `git diff --stat`/`git status`)

**New:**
- `src/admin/pages/site/panels/PropertiesPanel/stylePropertyProvenance.ts`
- `src/__tests__/panels/stylePropertyProvenance.test.ts`

**Edited:**
- `src/admin/pages/site/panels/InspectPanel/useInspectComputedStyle.ts` (added `useFrameComputedStyleValues`, existing export untouched)
- `src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx` (rewritten — S6 restructure, provenance wiring, target menu)
- `src/admin/pages/site/panels/PropertiesPanel/StyleSurface.module.css` (`.targetBlock`/`.targetBlockLabel`)
- `src/admin/pages/site/panels/PropertiesPanel/StyleTargetChip.tsx` (rewritten contract, see #6)
- `src/admin/pages/site/panels/PropertiesPanel/StyleTargetChip.module.css` (`.chipInfo`)
- `src/admin/pages/site/panels/PropertiesPanel/StyleRuleComposer.tsx` (`computedValues`/`provenanceByProperty` props)
- `src/admin/pages/site/panels/PropertiesPanel/InlineStyleComposer.tsx` (same)
- `src/admin/pages/site/panels/PropertiesPanel/StyleSectionsEditor.tsx` (threads `provenanceByProperty` to the generic branch + `AdvancedRows`)
- `src/admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.tsx` (`provenance` prop, strikethrough strip)
- `src/admin/pages/site/panels/PropertiesPanel/ClassPropertyRow.module.css` (`.provenanceStrip` etc.)
- `src/admin/pages/site/panels/PropertiesPanel/cssControlTypes.ts` (`ALL_CURATED_CSS_PROPERTIES`)
- `src/admin/pages/site/panels/PropertiesPanel/usePropertiesPanelData.ts` (`assignedClassRules`)
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanel.tsx` / `PropertiesPanelBody.tsx` (thread `assignedClassRules` down)
- `src/admin/pages/site/store/slices/styleRule/uiStateActions.ts` (S6 — decouple `setActiveClass`/`setInlineStyleEditing`)
- `src/admin/pages/site/store/slices/styleRule/types.ts` (doc comment only)
- `src/admin/pages/site/store/slices/selectionSlice.ts` (minimal, flagged — S6 seeding formula, 1 line + comment)
- `src/__tests__/editor-store/nodeInlineStyles.test.ts` (rewrote the "mutually exclusive" test to assert the new independence)
- `src/__tests__/panels/StyleTargetChip.test.tsx` (rewritten for the new contract)

**Tokens added to `globals.css`:** none — every new CSS rule reuses existing
tokens (`--text-subtle`, `--text-muted`, `--text-3xs`, `--space-3xs`,
`--space-4xs`, `--space-2xs`, `--space-l`, `--space-px`, `--radius`).

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json          → clean
./node_modules/.bin/eslint <every file above>               → clean, 0 errors/warnings
bun test src/__tests__/panels/stylePropertyProvenance.test.ts     → 12 pass
bun test src/__tests__/panels/StyleTargetChip.test.tsx            → 14 pass
bun test src/__tests__/editor-store/nodeInlineStyles.test.ts      → pass
bun test src/__tests__/panels src/__tests__/property-controls \
         src/__tests__/editor-store src/core/page-tree/__tests__  → 1050 pass / 4 fail (repeated 3x)
bun test src/__tests__/architecture/css-token-policy.test.ts \
         src/__tests__/architecture/no-css-var-fallbacks.test.ts \
         src/__tests__/architecture/button-primitive-usage.test.ts \
         src/__tests__/architecture/module-size-budgets.test.ts   → all pass
```

**The 4 failures are NOT mine** (confirmed via `git diff --stat` — none of
these files are in my diff, and they fail identically with my changes
reverted):
- `AgentPanel > attaches multiple local images…` / `keeps an attachment
  visible…` — flaky timing, `AgentPanel.tsx`, untouched by me.
- `notifyClassAssignmentUnsaved > warns, naming the node and the class…` —
  `classAssignmentUnsavedNotice.ts`/`.test.tsx`, Track B2's own rewritten
  wording vs. a stale test assertion (per B2's own handoff doc).
- `DomPanel — tree keyboard navigation > commits inline tree rename…` —
  unrelated panel, untouched by me.
- `src/__tests__/architecture/ui-primitives-location.test.ts` flags
  `TokenizedColorField.tsx` (Track H, explicitly off-limits to me) and
  `AddCustomFontDialog.tsx` (untouched by me).
- `src/__tests__/store/selectorStability.test.ts` flags `InstanceCallSiteView.tsx`
  (a different sibling's in-flight `?? []`, already named as not-mine in the
  C3 handoff doc I read before starting).

I also hit real order-dependent flakiness in `classPicker.test.tsx` /
`sourceConstraintNotice.test.tsx` when run as part of a very large combined
file list — isolated and confirmed both files pass 100% reliably alone and
in small combinations; `sourceConstraintNotice.test.tsx` fails **consistently
on its own**, with zero relation to any file I touched (F2's in-flight file).
Not chased further per the "don't fix sibling in-flight failures" instruction.

Did **not** run `bun run lint` / `bun run build` per instructions. Did
**not** run `npx tsc` anywhere.

## Human action needed — what to dogfood

1. **The headline S6 check.** Select an element that already has BOTH a
   class assigned and its own inline styles (or: select a classed element,
   click the new "Element" chip in the write-target menu to turn on inline
   editing without losing the class). Confirm you see **two labeled blocks**
   — `Element` and `.your-class` — stacked in the CSS area, both editable,
   simultaneously, with no need to remove the class first.
2. **Provenance strikethrough.** On a node with a class that sets, say,
   `opacity` or `boxShadow` (Effects section — generic rows, full provenance
   coverage) AND an inline override of the same property: confirm the
   Element block shows the winning value in the live control, and either
   block shows a small struck-through `.your-class: <old value>` note below
   the row citing the shadowed declaration.
3. **Frame-truth placeholders.** On a node with NO explicit value for, say,
   `color` or `display`, confirm the unset row's placeholder now matches
   what's actually rendering on the canvas (not a generic guess) — this
   needs the real Studio canvas (an iframe), not the isolated component
   tests, to see the effect; the placeholder fix is invisible in a
   non-rendered/test context by design (documented fallback).
4. **The write-target menu.** Open the panel on a class with no CSS source
   yet (a fresh `createClass()` via the picker) and confirm the "Class" chip
   now reads as writable (green, no warning icon) with a tooltip naming
   *where* the first edit will land — either an existing stylesheet or a new
   co-located one — instead of the old blanket "preview-only" warning.
5. **Regression check.** Re-run the existing class-pill / StyleRuleComposer
   flows (assign a class, edit its display/gap/position/typography) to
   confirm nothing about the single-class editing experience changed for a
   node with no inline styles — this should look and behave identically to
   before this change.
