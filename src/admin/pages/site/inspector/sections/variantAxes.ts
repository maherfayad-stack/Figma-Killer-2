/**
 * variantAxes — the pure reads the variant editor's forms share: which props of
 * a component are variant axes, what values they hold, which value a new one
 * would be copied from, and why a prop cannot be extended. Kept apart from the
 * popover components (a component file exports components only).
 */
import type { VariantBinding } from '@core/component-variants'
import type { LocalComponentSpec, LocalPropSpec } from '@site/property-controls/componentPropKind'

/** The enum props of a component: its variant axes, in declaration order. */
export function enumPropsOf(spec: LocalComponentSpec): LocalPropSpec[] {
  return spec.props.filter((prop) => prop.kind.kind === 'enum')
}

/** The values an enum prop declares. */
export function valuesOf(prop: LocalPropSpec): readonly string[] {
  return prop.kind.kind === 'enum' ? prop.kind.values : []
}

/** Which value's style a new one starts as a copy of — the default's, else the first that has one. */
export function copySourceOf(prop: LocalPropSpec): string | null {
  const binding: VariantBinding | undefined = prop.binding
  if (!binding || binding.kind === 'opaque' || binding.kind === 'boolean-class') return null
  const styled = binding.kind === 'lookup-object' || binding.kind === 'cva' ? binding.entries.map((e) => e.member) : binding.rules.map((r) => r.member)
  if (typeof prop.defaultValue === 'string' && styled.includes(prop.defaultValue)) return prop.defaultValue
  return styled[0] ?? null
}

/** Why Add variant cannot work for this prop, or `null` when it can. */
export function blockerOf(prop: LocalPropSpec | undefined): { message: string; file?: string; line?: number } | null {
  if (!prop) return { message: 'This component has no property with a set of values to add one to.' }
  const binding = prop.binding
  if (!binding) return { message: `Studio could not read how this component styles "${prop.name}", so it cannot extend it.` }
  if (binding.kind === 'opaque') return { message: `Its styling is decided in code (${binding.reason}).`, file: binding.file, line: binding.line }
  if (binding.kind === 'boolean-class') return { message: `"${prop.name}" is an on/off class, not a set of values.` }
  return null
}
