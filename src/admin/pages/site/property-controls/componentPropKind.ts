/**
 * componentPropKind — the browser's wire mirror of the server's `PropKind`/
 * `PropSpec`/`LocalComponentSpec` (`server/handlers/studio/
 * packageManifestSchema.ts` + `componentSpecExtract.ts`), plus the ONE
 * `PropKind -> PropertyControl` mapping every component-instance surface in
 * the Properties panel uses.
 *
 * Before E2.5 this mapping existed exactly once, private to
 * `registerProjectModules.ts` (`controlForKind`, for `pkg.*`/`alm.*` design-
 * system components read off `componentBundle.ts`'s bundle). A LOCAL
 * component call site (`studio.instance`) had no declared-type source at all
 * and instead GUESSED a control from the call-site VALUE's runtime type
 * (`InstanceCallSiteView.tsx`'s deleted `controlForCallSiteValue`) — which is
 * why a string union rendered a text box instead of a dropdown, and why a
 * prop the call site didn't pass got no row at all (nothing to guess a
 * control FROM). Track E1 (`GET /admin/api/studio/components`) gives local
 * components the exact same `PropKind` signal package components already
 * had; this module is the one mapping both paths now share, so a `select`
 * for a `variant?: 'primary' | 'ghost'` union looks and behaves identically
 * whether the component is local to the project or an installed design
 * system — CLAUDE.md's "no old-and-new side by side" applies to a mapping
 * function exactly as much as it does to a whole feature.
 *
 * `registerProjectModules.ts` still owns its own `BundledComponentSpecSchema`
 * (which adds a `pkg: Type.String()` field `LocalComponentSpec` has no use
 * for) and imports `PropKindSchema`/`PropSpecSchema`/`controlForPropKind`
 * from here instead of maintaining a second copy of each.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { PropertyControl } from '@core/module-engine'

export const PropKindSchema = Type.Union([
  Type.Object({ kind: Type.Literal('string') }),
  Type.Object({ kind: Type.Literal('number') }),
  Type.Object({ kind: Type.Literal('boolean') }),
  Type.Object({ kind: Type.Literal('enum'), values: Type.Array(Type.String()) }),
  Type.Object({ kind: Type.Literal('color') }),
  Type.Object({ kind: Type.Literal('image') }),
  Type.Object({ kind: Type.Literal('node') }),
  Type.Object({ kind: Type.Literal('handler') }),
  Type.Object({ kind: Type.Literal('collection') }),
  Type.Object({ kind: Type.Literal('collectionIndex'), collection: Type.String() }),
  Type.Object({ kind: Type.Literal('unknown') }),
])
export type PropKind = Static<typeof PropKindSchema>

export const PropSpecSchema = Type.Object({
  name: Type.String(),
  kind: PropKindSchema,
  required: Type.Boolean(),
})
export type PropSpec = Static<typeof PropSpecSchema>

/**
 * The wire mirror of `server/handlers/studio/componentSpecExtract.ts`'s
 * `LocalComponentSpec` — every exported, PascalCase-named component
 * declared anywhere in the workspace, off `GET /admin/api/studio/components`.
 */
export const LocalComponentSpecSchema = Type.Object({
  name: Type.String(),
  file: Type.String(),
  exportName: Type.String(),
  isDefaultExport: Type.Boolean(),
  props: Type.Array(PropSpecSchema),
})
export type LocalComponentSpec = Static<typeof LocalComponentSpecSchema>

/**
 * Props the CANVAS owns on a design-system component — never the panel, and
 * never a per-node value.
 *
 * `dir` is the whole set. A design system resolves direction through a
 * `useDir(prop)`-shaped hook — explicit prop > provider > a built-in `'ltr'`
 * — and both registration paths wrap every component they render in the
 * package's own provider, fed the FRAME's preview direction
 * (`useFramePreviewAxes`). Leaving `dir` in the editable prop surface meant
 * the manifest's own enum default (`values[0]`, i.e. `'ltr'`) was stamped
 * onto every inserted component, and an explicit prop outranks the provider
 * — so the board's RTL toggle was defeated by a value nobody chose, on every
 * component that documents a `dir` prop.
 *
 * This rule applies ONLY to the two design-system registration paths
 * (`src/modules/alm/register.tsx`, `registerProjectModules.ts`), because they
 * are the two that actually supply the value from the provider. A LOCAL
 * component's call site (`componentCallSiteRows.ts`) is deliberately NOT
 * filtered: Studio wraps no provider around it, so hiding its `dir` row would
 * remove a control with nothing left to drive it.
 */
export const CANVAS_DRIVEN_PROPS: ReadonlySet<string> = new Set(['dir'])

export function isCanvasDrivenProp(name: string): boolean {
  return CANVAS_DRIVEN_PROPS.has(name)
}

/**
 * Drops every {@link CANVAS_DRIVEN_PROPS} entry from a node's props before
 * they reach the design-system component, returning the SAME object when
 * there is nothing to drop (the overwhelmingly common case — one allocation
 * per render is not worth spending on every node).
 *
 * Stripping at render time is what makes the rule hold for props the schema
 * never produced: a `dir="ltr"` literal already sitting in the user's source,
 * or one stamped by an older Studio build, arrives on the node regardless of
 * what the panel offers. The source file is left untouched — this is a
 * PREVIEW decision, and the board's direction axis is what a direction
 * preview means.
 *
 * On its own this is only HALF the rule — see {@link withCanvasDrivenProps},
 * which supplies the value the canvas owns. Stripping without supplying is
 * what made an RTL board render left-to-right.
 */
export function stripCanvasDrivenProps(props: Record<string, unknown>): Record<string, unknown> {
  let stripped: Record<string, unknown> | undefined
  for (const name of CANVAS_DRIVEN_PROPS) {
    if (!(name in props)) continue
    stripped ??= { ...props }
    delete stripped[name]
  }
  return stripped ?? props
}

/**
 * The props a design-system component is actually rendered with: the node's
 * own, minus what the canvas owns, plus what the canvas drives.
 *
 * ## Why `dir` is PASSED and not left to the provider
 *
 * The original rule stripped `dir` and relied on the package's
 * `DesignSystemProvider` to answer a `useDir()` call inside each component.
 * Measured against the installed `@alm-design/design-system@1.1.2`, that
 * premise is false: the bundle contains **zero** `useDir(` call sites, and
 * **20 of its 26 components declare `dir` as an ordinary prop defaulting to
 * the literal `'ltr'`**, which each one then writes onto its own root
 * element. A `dir="ltr"` on the component's root BEATS the inherited
 * `html[dir="rtl"]` the frame sets, so stripping the prop did not fall
 * through to the provider — it pinned twenty components left-to-right and
 * defeated the frame's own direction. That is exactly the reported symptom:
 * an RTL board where the text reflows but the components do not mirror.
 *
 * So the canvas supplies the value rather than hoping something else will.
 * An explicit prop is also the highest-precedence input for any component
 * that DOES consult a provider, so this is correct for both shapes and does
 * not depend on which one a given package uses.
 *
 * The provider is still rendered — it carries whatever else it carries — but
 * direction no longer depends on it.
 */
export function withCanvasDrivenProps(
  props: Record<string, unknown>,
  axes: { direction: 'ltr' | 'rtl' },
): Record<string, unknown> {
  return { ...stripCanvasDrivenProps(props), dir: axes.direction }
}

/**
 * The ONE `PropKind -> PropertyControl` mapping — moved verbatim from
 * `registerProjectModules.ts`'s private `controlForKind`, behaviour
 * unchanged for every value-carrying kind (same case order, same >= 2 values
 * guard on `enum`, same `string`/`unknown`/default fallthrough to `text`).
 *
 * `handler` is the one case that returns NO control. A callback is not a
 * value a text box can produce, and writing one back would put a string where
 * the component expects a function. The rule lives here rather than in each
 * caller's own filter because this is the single place that decides what a
 * prop's editor is — `componentSpecExtract.ts` drops handlers server-side for
 * the local-component and package-bundle paths, but a design-system manifest
 * generated from a package's own docs (`buildDesignSystemManifest.ts`) does
 * record them, and that path deserves the same answer rather than a second
 * copy of the rule.
 */
export function controlForPropKind(name: string, kind: PropKind): PropertyControl | undefined {
  switch (kind.kind) {
    case 'handler':
      return undefined
    case 'collection':
      // Same answer as a handler, for the same reason: there is no scalar edit
      // that lands honestly. A text box on `items={[{ icon, label }]}` accepts
      // any value and every value it accepts breaks the component — typing `5`
      // reached `items.map(...)` and put "TabBar (render error)" on the canvas.
      // Declining the control is the refusal CLAUDE.md asks for.
      return undefined
    case 'enum':
      return kind.values.length >= 2
        ? { type: 'select', label: name, options: kind.values.map((v) => ({ label: v, value: v })) }
        : { type: 'text', label: name }
    case 'color':
      return { type: 'color', label: name }
    case 'image':
      return { type: 'image', label: name }
    case 'boolean':
      return { type: 'toggle', label: name }
    case 'number':
      return { type: 'number', label: name }
    case 'collectionIndex':
      // A number that names one entry of a sibling list. See the
      // `collection-index` control in `propertySchema.ts` for why the options
      // cannot be baked into the schema.
      return { type: 'collection-index', label: name, collection: kind.collection }
    case 'node':
      // WS-6.5/E2.5 — the sentinel value is meaningless in a scalar control,
      // but the slot IS a real, editable node (WS-3.4's materialized child,
      // E2.3's fragment-slot container) — `SlotControl` renders an "Edit
      // contents"/"Add" affordance instead of dropping the row.
      return { type: 'slot', label: name }
    case 'string':
    case 'unknown':
    default:
      return { type: 'text', label: name }
  }
}
