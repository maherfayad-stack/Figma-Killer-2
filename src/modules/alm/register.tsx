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
import {
  controlForPropKind,
  isCanvasDrivenProp,
  withCanvasDrivenProps,
  type PropKind,
} from '@site/property-controls/componentPropKind'
import { registry, type ModuleDefinition, type ModuleComponentProps } from '@core/module-engine'
import { sanitizeSvg } from '@core/sanitize'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { NodeRenderer } from '@site/canvas/NodeRenderer'
import { useFramePreviewAxes } from '@site/canvas/previewAxesFrameEffect'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import type { ComponentManifest, ComponentSpec, PropSpec } from '@core/component-manifest'
import manifestJson from './manifest.generated.json'

// The manifest's own types, not a hand-copied structural twin: this file
// consumes exactly what `buildDesignSystemManifest` writes, `PropSpec.kind`
// included, so the two cannot drift.
const manifest = manifestJson as ComponentManifest

/**
 * The specifier every component here is imported from in a user's source.
 * Mirrors `studioPageLoad.ts`'s `ALM_DESIGN_PACKAGE_SPECIFIER` (server-side —
 * it decides which components keep the `alm.*` module id instead of the generic
 * `pkg.*` one). Declared on each module as `sourceImport` so the Studio insert
 * path can write a real `import { Button } from '@alm-design/design-system'`
 * without knowing anything about this package.
 */
const ALM_PACKAGE_SPECIFIER = '@alm-design/design-system'

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

/**
 * What Studio drives on the design system's provider.
 *
 * The provider is still rendered with the frame's direction, but **it is not
 * what makes direction work** — do not rely on it. Measured against the
 * installed `@alm-design/design-system@1.1.2`: the bundle has ZERO `useDir(`
 * call sites, and 20 of its 26 components take `dir` as an ordinary prop
 * defaulting to the literal `'ltr'`, which each writes onto its own root
 * element — where it beats the `html[dir]` the frame sets. Direction is
 * therefore passed as an explicit prop by `withCanvasDrivenProps`; this
 * provider is kept for whatever else it carries, and because a future version
 * of the package may start consulting it.
 */
type DesignSystemProviderProps = { children?: React.ReactNode; dir?: 'ltr' | 'rtl' }

const Provider = (DS as Record<string, unknown>).DesignSystemProvider as
  | React.ComponentType<DesignSystemProviderProps>
  | undefined

/**
 * Maps this package's documented prop kinds onto Studio's ONE
 * `PropKind -> PropertyControl` mapping — the same one every `pkg.*` component
 * and every local `studio.instance` call site goes through.
 *
 * This file used to carry its own two-case version (enum -> select, everything
 * else -> text), which is why a boolean rendered as a text box you had to type
 * the word `false` into, a number rendered as a text box, and an `onClick`
 * rendered as an editable field at all. The manifest now carries a real
 * `kind` per prop (`buildDesignSystemManifest`, derived from the package's own
 * documented value forms), so there is no reason for a second mapping to
 * exist — CLAUDE.md's "no old-and-new side by side" applies to a mapping
 * function as much as to a feature. `handler` is passed straight through for
 * the same reason: `controlForPropKind` is what decides a handler gets no
 * control, not a private filter here.
 */
function propKindFor(p: PropSpec): PropKind {
  if (p.enumValues && p.enumValues.length >= 2) return { kind: 'enum', values: p.enumValues }
  switch (p.kind) {
    case 'handler':
      return { kind: 'handler' }
    case 'boolean':
      return { kind: 'boolean' }
    case 'number':
      return { kind: 'number' }
    case 'icon':
    case 'node':
      return { kind: 'node' }
    case 'string':
      return { kind: 'string' }
    default:
      return { kind: 'unknown' }
  }
}

function buildSchema(props: PropSpec[]): ModuleDefinition['schema'] {
  const schema: Record<string, unknown> = {}
  for (const p of props) {
    if (isCanvasDrivenProp(p.name)) continue
    const control = controlForPropKind(p.name, propKindFor(p))
    if (control) schema[p.name] = control
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
  // Handler props stay in the SCHEMA (a parsed call site legitimately carries
  // `onClick={fn}`, and `validateNodeProps` must let it through untouched) —
  // they are only absent from `schema`, the panel's control list.
  for (const p of props) {
    if (isCanvasDrivenProp(p.name)) continue
    shape[p.name] = Type.Optional(Type.Unknown())
  }
  return Type.Object(shape)
}

function buildDefaults(spec: ComponentSpec): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const p of spec.props) {
    // `dir` is the canvas's, not the node's — see `CANVAS_DRIVEN_PROPS`.
    if (isCanvasDrivenProp(p.name)) continue
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
 * WS-3.4 (`pkg-02`) — the parser now ALSO captures a JSX-valued component prop
 * that isn't a one-level SVG icon as a real materialized child node, referenced
 * by a `studio-slot:<nodeId>` sentinel (`@core/utils/studioSlotSentinel`) rather
 * than the `{svg}` shape above. This function must recognize BOTH: the parser
 * change is unconditional (it runs for every component, not just `pkg.*` ones),
 * so an `@alm-design` node with a composed-children prop this file's old
 * one-level SVG capture declined would otherwise arrive here as a raw,
 * unrecognized sentinel STRING and render as literal visible text
 * (`"studio-slot:pages/Home.jsx:5:3"`) instead of the icon/header it names —
 * a regression `structuredProps.test.ts`'s "WS-3.4" case exists to catch
 * generically, mirrored here because this file's own render path is separate
 * from `registerProjectModules.ts`'s `revivePropValue`.
 *
 * Other structured values pass straight through: a real `<ActionSheet>` wants its
 * `actions` array as an array.
 */
function reviveIconProps(props: Record<string, unknown>): Record<string, unknown> {
  let revived: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(props)) {
    const slotNodeId = studioSlotNodeId(value)
    if (slotNodeId !== undefined) {
      revived ??= { ...props }
      revived[key] = React.createElement(NodeRenderer, { key: slotNodeId, nodeId: slotNodeId })
      continue
    }
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

/**
 * The host element every design-system component is mounted under, carrying the
 * editor's selection/hover/keyboard wiring (`nodeWrapperProps`) — which a
 * third-party component cannot be relied on to forward onto its own root.
 *
 * `display: contents` because it must carry NO layout of its own. As an
 * `inline-block` it shrink-wrapped, and every full-width design-system button on
 * an imported screen came out at its intrinsic width: source styles them with
 * `.footer .btn { width: 100% }`, and 100% of a shrink-to-fit box is the box's
 * own content width. The same box also stopped the component participating in a
 * parent's flex/grid layout. `nodeVisualRect` is what keeps the node selectable
 * and droppable without a box of its own.
 */
const TRANSPARENT_HOST_STYLE: React.CSSProperties = { display: 'contents' }

/** Merges two optional class strings, dropping empties and duplicates. */
function mergeClassNames(a: unknown, b: string | undefined): string | undefined {
  const names = new Set<string>()
  for (const source of [a, b]) {
    if (typeof source !== 'string') continue
    for (const name of source.split(/\s+/)) if (name) names.add(name)
  }
  return names.size > 0 ? [...names].join(' ') : undefined
}

function makeComponent(name: string): React.FC<ModuleComponentProps> {
  const Comp = (DS as Record<string, unknown>)[name] as React.ComponentType<Record<string, unknown>> | undefined
  const AlmEditor: React.FC<ModuleComponentProps> = ({ props, nodeWrapperProps, mcClassName }) => {
    // The direction of the FRAME this component is rendered into (a "duplicate
    // as variant" frame can preview RTL beside an LTR board), fed to the
    // design system's own provider — see `DesignSystemProviderProps`.
    const { direction } = useFramePreviewAxes()
    // `style` is pulled OUT of the editor bag: it holds the node's own inline
    // styles, which belong on the styled component, not on the transparent host
    // where `display: contents` would make them inert.
    const { style: nodeStyle, ...editorProps } = nodeWrapperProps ?? {}
    // The node's own `dir` is replaced by the FRAME's — see
    // `withCanvasDrivenProps` for why the value is passed explicitly rather
    // than left to the provider below (this package's components default
    // `dir` to `'ltr'` and write it on their own root, which beats the
    // frame's `html[dir]`). The board axis is what a direction PREVIEW means.
    const dsProps = reviveIconProps(withCanvasDrivenProps(props as Record<string, unknown>, { direction }))
    // The node's CSS classes go on the design-system component, where the source
    // wrote them — applying them to the host as well double-applied every
    // padding and margin in the rule.
    const className = mergeClassNames(dsProps.className, mcClassName)
    const inner = Comp
      ? React.createElement(Comp, {
          ...dsProps,
          ...(className !== undefined ? { className } : {}),
          ...(nodeStyle ? { style: nodeStyle } : {}),
        })
      : React.createElement('span', null, name)
    const provided = Provider ? React.createElement(Provider, { dir: direction }, inner) : inner
    return React.createElement(
      'div',
      { ...editorProps, style: TRANSPARENT_HOST_STYLE },
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
    sourceImport: { specifier: ALM_PACKAGE_SPECIFIER, name: spec.name },
    component: makeComponent(spec.name),
    // Publish (HTML) path is a later step — the canvas uses `component` above.
    render: () => ({ html: '' }),
  } as unknown as ModuleDefinition<Record<string, unknown>>

  registry.registerOrReplace(mod)
  registered += 1
}

/**
 * The package's ICON components, discovered from its own runtime exports
 * rather than from `manifest.generated.json`.
 *
 * The manifest is built from the package's own `mcp/catalog.js`
 * (`buildDesignSystemManifest`), which lists the 39 documented components and
 * says nothing about the icon set. So every `<ChevronDownIcon/>` in a user's
 * source resolved to `alm.ChevronDownIcon`, matched no registered module, and
 * drew an "Unknown module" box on the canvas — while
 * `.claude/design-system-icons.md` was simultaneously telling the agent to
 * import exactly those names. The guide and the canvas contradicted each
 * other, and the agent believed the canvas: it went back to hand-drawing SVG
 * path data.
 *
 * Discovered BY SHAPE rather than from a hardcoded list — any `*Icon`-suffixed
 * function the package actually exports — so a new icon in a future version
 * registers itself instead of silently regressing to an Unknown-module box.
 * Filtered against the manifest names so a documented component that happens
 * to end in `Icon` is never registered twice with an empty prop schema.
 *
 * They carry no editable props: these render a fixed glyph and inherit size
 * and colour from the parent rule, which is exactly what the generated icon
 * reference tells the agent to do.
 */
const manifestNames = new Set(manifest.components.map((c) => c.name))
const iconExportNames = Object.keys(DS as Record<string, unknown>)
  .filter((name) => name.endsWith('Icon') && !manifestNames.has(name))
  .filter((name) => typeof (DS as Record<string, unknown>)[name] === 'function')
  .sort()

for (const name of iconExportNames) {
  const iconMod = {
    id: `alm.${name}`,
    name,
    description: `${name} — @alm-design/design-system icon`,
    category: 'Design System',
    version: '1.0.0',
    icon: CursorClickSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: buildSchema([]),
    propsSchema: buildPropsSchema([]),
    defaults: {},
    sourceImport: { specifier: ALM_PACKAGE_SPECIFIER, name },
    component: makeComponent(name),
    render: () => ({ html: '' }),
  } as unknown as ModuleDefinition<Record<string, unknown>>

  registry.registerOrReplace(iconMod)
  registered += 1
}

if (typeof console !== 'undefined') {
  console.info(`[alm] registered ${registered} design-system modules (${iconExportNames.length} icons)`)
}
