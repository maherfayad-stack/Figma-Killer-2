/**
 * Registers @alm-design/design-system components as editor modules so they
 * appear in the canvas module inserter, render live on the canvas, are
 * selectable, and get an auto-generated Properties-panel inspector driven by
 * the design-system manifest (prop names + enum values).
 *
 * FIRST SLICE SCOPE:
 *  - A conservative SAFE_SUBSET of components that render with simple
 *    string/enum props (no required React-node children).
 *  - Components render via each module's editor `component` (the canvas renders
 *    React components, not the publish `render()` HTML). They are wrapped in an
 *    ErrorBoundary so a misbehaving component can never crash the whole canvas.
 *  - NOT YET: design-system CSS injection into the canvas iframe (components
 *    render unstyled for now) and writing prop edits back to .tsx source
 *    (the filesystem adapter). Those are the next two steps.
 *
 * The manifest is generated at build time by `scripts/gen-alm-manifest.mjs`
 * (the extraction is Node-only) into `manifest.generated.json`.
 */
import React from 'react'
import * as DS from '@alm-design/design-system'
import { Type } from '@core/utils/typeboxHelpers'
import { registry, type ModuleDefinition, type ModuleComponentProps } from '@core/module-engine'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import manifestJson from './manifest.generated.json'

interface PropSpec {
  name: string
  tsType: string
  required: boolean
  defaultValue?: string
  enumValues?: string[]
}
interface ComponentSpec {
  name: string
  file: string
  exportName: string
  isDefaultExport: boolean
  props: PropSpec[]
}
const manifest = manifestJson as { components: ComponentSpec[] }

/**
 * Overlay/portal components that render detached from the canvas flow and would
 * be confusing as inline placeable modules — excluded from the palette for now.
 * Everything else in the manifest is registered (the ErrorBoundary keeps any
 * component that needs richer props from breaking the canvas).
 */
const EXCLUDE = new Set(['Dialog', 'BottomSheet', 'ActionSheet', 'Snackbar', 'Tooltip'])

// ---------------------------------------------------------------------------
// Error boundary so a throwing design-system component degrades to a label
// instead of taking down the canvas iframe.
// ---------------------------------------------------------------------------
class AlmErrorBoundary extends React.Component<
  React.PropsWithChildren<{ name: string }>,
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) {
      return React.createElement('span', null, `${this.props.name} (render error)`)
    }
    return this.props.children
  }
}

const Provider = (DS as Record<string, unknown>).DesignSystemProvider as
  | React.ComponentType<{ children?: React.ReactNode }>
  | undefined

function buildSchema(props: PropSpec[]): ModuleDefinition['schema'] {
  const schema: Record<string, unknown> = {}
  for (const p of props) {
    if (p.enumValues && p.enumValues.length >= 2) {
      schema[p.name] = {
        type: 'select',
        label: p.name,
        options: p.enumValues.map((v) => ({ label: v, value: v })),
      }
    } else {
      schema[p.name] = { type: 'text', label: p.name }
    }
  }
  return schema as ModuleDefinition['schema']
}

function buildPropsSchema(props: PropSpec[]) {
  const shape: Record<string, ReturnType<typeof Type.Optional>> = {}
  for (const p of props) shape[p.name] = Type.Optional(Type.String())
  return Type.Object(shape)
}

function buildDefaults(spec: ComponentSpec): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const p of spec.props) {
    if (p.name === 'label') defaults[p.name] = spec.name
    else if (p.enumValues?.length) defaults[p.name] = p.enumValues[0]
  }
  return defaults
}

function makeComponent(name: string): React.FC<ModuleComponentProps> {
  const Comp = (DS as Record<string, unknown>)[name] as React.ComponentType<Record<string, unknown>> | undefined
  const AlmEditor: React.FC<ModuleComponentProps> = ({ props, nodeWrapperProps, mcClassName }) => {
    const inner = Comp
      ? React.createElement(Comp, props as Record<string, unknown>)
      : React.createElement('span', null, name)
    const provided = Provider ? React.createElement(Provider, null, inner) : inner
    return React.createElement(
      'div',
      { ...nodeWrapperProps, className: mcClassName, style: { display: 'inline-block' } },
      React.createElement(AlmErrorBoundary, { name }, provided),
    )
  }
  AlmEditor.displayName = `Alm(${name})`
  return AlmEditor
}

let registered = 0
for (const spec of manifest.components) {
  if (EXCLUDE.has(spec.name)) continue
  const propsSchema = buildPropsSchema(spec.props)
  const mod = {
    id: `alm.${spec.name}`,
    name: spec.name,
    description: `${spec.name} — @alm-design/design-system`,
    category: 'Design System',
    version: '1.0.0',
    icon: CursorClickSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: buildSchema(spec.props),
    propsSchema,
    defaults: buildDefaults(spec),
    component: makeComponent(spec.name),
    // Publish (HTML) path is a later step — the canvas uses `component` above.
    render: () => ({ html: '' }),
  } as unknown as ModuleDefinition<Record<string, unknown>>

  registry.registerOrReplace(mod)
  registered += 1
}

if (typeof console !== 'undefined') {
  console.info(`[alm] registered ${registered} design-system modules`)
}
