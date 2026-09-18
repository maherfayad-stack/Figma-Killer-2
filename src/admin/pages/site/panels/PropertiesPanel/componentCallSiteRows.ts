/**
 * componentCallSiteRows — the row set a `studio.instance`'s Component
 * section shows, driven by Track E1's catalog instead of the call site's
 * own (possibly empty) attribute list.
 *
 * Before E2.5: `InstanceCallSiteView.tsx` iterated `Object.keys(callSiteProps)`
 * — a prop the call site didn't pass got no row at all, and every row's
 * control was GUESSED from the runtime VALUE's type (`controlForCallSiteValue`,
 * deleted). This module is the replacement: every prop the component's own
 * source DECLARES gets a row, whether or not the call site sets it, and its
 * control comes from the declared `PropKind` (K3's named-union-alias
 * resolution included) — the same mapping a package/design-system
 * component's schema-driven rows already used.
 *
 * Split out as a pure function (no React, no store) so the row set — the
 * actual behavioral contract the panel promises — is unit-testable without
 * rendering a component or seeding a store.
 */
import type { PropertyControl } from '@core/module-engine'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { controlForPropKind, type LocalComponentSpec, type PropSpec } from '@site/property-controls/componentPropKind'

export interface ComponentCallSiteRow {
  key: string
  control: PropertyControl
  value: unknown
}

/**
 * One row per prop `spec.props` declares (in declaration order), plus one
 * row per prop the call site ALREADY sets that the catalog didn't declare
 * (an untyped JS-only project's `props: []`, a spread/rest prop, or a
 * momentarily-stale catalog) — nothing the call site already passes ever
 * silently disappears. An undeclared row's control comes from the SAME
 * `controlForPropKind` mapping, classified `'unknown'` (honest: Studio has
 * no declared type for it) unless its value is a slot sentinel, which is a
 * definite structural marker to check, not a value-shape guess — the one
 * exception `controlForCallSiteValue` used to make too.
 *
 * `spec: null` (catalog not loaded yet, or this instance's component isn't
 * in it) falls back to declaring nothing — every currently-set prop still
 * gets a row via the "undeclared" path above, so the panel never goes
 * blank while the catalog fetch is in flight.
 */
export function buildComponentCallSiteRows(
  spec: LocalComponentSpec | null,
  callSiteProps: Record<string, unknown>,
): ComponentCallSiteRow[] {
  const declaredRows: ComponentCallSiteRow[] = []
  const declaredKeys = new Set<string>()

  for (const prop of spec?.props ?? []) {
    const control = controlForPropKind(prop.name, prop.kind)
    if (!control) continue
    if (!propAppliesToCallSite(prop, callSiteProps)) continue
    declaredKeys.add(prop.name)
    declaredRows.push({ key: prop.name, control, value: callSiteProps[prop.name] })
  }

  const extraRows: ComponentCallSiteRow[] = []
  for (const key of Object.keys(callSiteProps)) {
    if (declaredKeys.has(key)) continue
    const value = callSiteProps[key]
    const control = controlForPropKind(
      key,
      studioSlotNodeId(value) !== undefined ? { kind: 'node' } : { kind: 'unknown' },
    )
    if (control) extraRows.push({ key, control, value })
  }

  return [...declaredRows, ...extraRows]
}

/**
 * Whether a declared prop's row belongs in the set for THIS call site — see
 * `PropSpec.appliesWhen`'s own doc for what populates the gate and why it is
 * a separate fact from structural writability (`isPropWritableToSource`).
 *
 * A set value always outranks a gate: if the call site already writes this
 * prop, the row stays even when the gating prop's current value says it
 * shouldn't apply. A real, live value a keystroke could touch must never go
 * missing from the panel — hiding it would make it silently un-editable and
 * un-discoverable, which is a worse failure than one always-visible row that
 * occasionally does nothing.
 */
function propAppliesToCallSite(prop: PropSpec, callSiteProps: Record<string, unknown>): boolean {
  const gate = prop.appliesWhen
  if (!gate) return true
  if (callSiteProps[prop.name] !== undefined) return true
  return gate.values.includes(callSiteProps[gate.prop] as string)
}
