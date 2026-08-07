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
 * The ONE `PropKind -> PropertyControl` mapping — moved verbatim from
 * `registerProjectModules.ts`'s private `controlForKind`, behaviour
 * unchanged (same case order, same >= 2 values guard on `enum`, same
 * `string`/`unknown`/default fallthrough to `text`). `handler`-kind props
 * are dropped before they ever reach a `PropSpec` array
 * (`componentSpecExtract.ts`'s own "dropped, never stubbed" rule, mirrored
 * server-side for the package-bundle path too) — no case here needs to
 * special-case it, same as the original.
 */
export function controlForPropKind(name: string, kind: PropKind): PropertyControl | undefined {
  switch (kind.kind) {
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
