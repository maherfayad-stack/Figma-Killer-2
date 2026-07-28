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
import { sanitizeSvg } from '@core/sanitize'
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
 * be confusing to place by hand. They are hidden from the INSERT PALETTE only —
 * `PALETTE_HIDDEN_ALM_MODULE_IDS`, consumed by `moduleAvailability`.
 *
 * They are still registered. An imported page that already uses `<Snackbar>` or
 * `<ActionSheet>` in its source has real nodes for them, and an unregistered
 * module renders as an "Unknown module" box — so skipping registration lost
 * whole components off the board (measured: 4 nodes on the eSIM corpus). Being
 * awkward to insert by hand is not a reason to refuse to render existing usage.
 */
const PALETTE_HIDDEN_COMPONENTS = ['Dialog', 'BottomSheet', 'ActionSheet', 'Snackbar', 'Tooltip'] as const

/** Module ids the insert palette hides. Exported for `moduleAvailability`; see `PALETTE_HIDDEN_COMPONENTS`. */
export const PALETTE_HIDDEN_ALM_MODULE_IDS: ReadonlySet<string> = new Set(
  PALETTE_HIDDEN_COMPONENTS.map((name) => `alm.${name}`),
)

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

/**
 * Every prop is `Unknown`, because it genuinely is: the generator records
 * `tsType: 'unknown'` for all of them, so there is no real type here to declare.
 *
 * `Type.String()` was the old shape and it actively lied. `validateNodeProps`
 * runs `Value.Parse` against this schema, so an `actions={[{ label }]}` array —
 * exactly what a real `<ActionSheet>` needs — failed Check, threw, and fell back
 * to the module's defaults. Declaring the truth passes the value through
 * untouched, which is what a React component wants: a boolean `open` stays a
 * boolean instead of being converted to the string `"true"`.
 */
function buildPropsSchema(props: PropSpec[]) {
  const shape: Record<string, ReturnType<typeof Type.Optional>> = {}
  for (const p of props) shape[p.name] = Type.Optional(Type.Unknown())
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

/**
 * Turns a `{ svg: markup }` prop back into the React element the source had
 * there: `<Cell icon={<Icon svg={rewardCardSvg}/>}/>`.
 *
 * A page tree is JSON, so a React node cannot survive the trip from source to
 * the canvas. The page parser captures such a prop as `{ svg }` — the same key a
 * node carrying raw markup uses (see `ICON_PROP_SVG_KEY`) — and this layer, which
 * is already the adapter between page-tree JSON and React props, converts it
 * back. Markup is sanitised here for the same reason `SvgEditor` sanitises: never
 * trust that an upstream layer did.
 *
 * Other structured values pass straight through: a real `<ActionSheet>` wants its
 * `actions` array as an array.
 */
function reviveIconProps(props: Record<string, unknown>): Record<string, unknown> {
  let revived: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entries = Object.entries(value as Record<string, unknown>)
    const svg = entries.length === 1 && entries[0]![0] === 'svg' ? entries[0]![1] : undefined
    if (typeof svg !== 'string') continue
    const markup = sanitizeSvg(svg)
    if (!markup) continue
    revived ??= { ...props }
    revived[key] = React.createElement('span', {
      style: { display: 'inline-flex' },
      dangerouslySetInnerHTML: { __html: markup },
    })
  }
  return revived ?? props
}

function makeComponent(name: string): React.FC<ModuleComponentProps> {
  const Comp = (DS as Record<string, unknown>)[name] as React.ComponentType<Record<string, unknown>> | undefined
  const AlmEditor: React.FC<ModuleComponentProps> = ({ props, nodeWrapperProps, mcClassName }) => {
    const inner = Comp
      ? React.createElement(Comp, reviveIconProps(props as Record<string, unknown>))
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
