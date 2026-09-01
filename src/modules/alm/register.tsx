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
import { CURATED_DEFAULTS } from './curatedDefaults'

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

/**
 * Components that render their own `children` — the ones a user can compose
 * INTO on the canvas.
 *
 * Every module here used to declare `canHaveChildren: false`, which was wrong
 * for the container-shaped ones and wrong in the expensive direction: a
 * scaffolded (or imported) `<BottomSheet><p>…</p></BottomSheet>` parsed into a
 * real child node, listed it in the layer tree, and then drew an EMPTY sheet —
 * the package's `.bottom-sheet__content` div rendered with nothing in it. The
 * content was not lost, it was invisible, which is the worst of both.
 *
 * A curated list rather than a manifest field because the manifest is built
 * from the package's `mcp/catalog.js`, which documents props and says nothing
 * about children — same reason `PALETTE_HIDDEN_COMPONENTS` above is a list.
 * These three are the package's own overlay shells, each documented as taking
 * its panel content as `children` (`CLAUDE.md`, per-component sections).
 * Extend it when another component's own docs say the same; do NOT flip it on
 * wholesale — `Button`/`Tag`/`Chip` take their text through a `label` prop and
 * explicitly do **not** render children, so allowing a drop into one would
 * silently swallow the dropped node.
 */
const CHILD_ACCEPTING_COMPONENTS = ['BottomSheet', 'Dialog', 'ActionSheet'] as const

const CHILD_ACCEPTING_COMPONENT_NAMES: ReadonlySet<string> = new Set(CHILD_ACCEPTING_COMPONENTS)

// ---------------------------------------------------------------------------
// Error boundary so a throwing design-system component degrades to a label
// instead of taking down the canvas iframe.
// ---------------------------------------------------------------------------
class AlmErrorBoundary extends React.Component<
  React.PropsWithChildren<{ name: string }>,
  { failed: boolean }
> {
  state: { failed: boolean; message?: string } = { failed: false }
  static getDerivedStateFromError(error: unknown) {
    // Carry the reason. A bare "(render error)" named the component and
    // nothing else, so the only way to find out which prop broke it was to
    // delete props one at a time.
    return { failed: true, message: error instanceof Error ? error.message : undefined }
  }
  render() {
    if (this.state.failed) {
      const detail = this.state.message ? `: ${this.state.message}` : ''
      return React.createElement('span', null, `${this.props.name} (render error${detail})`)
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
    case 'collection':
      return { kind: 'collection' }
    case 'number':
      // A number the docs call an index into a sibling list gets that list's
      // own entries to choose from instead of a bare number box — see
      // `PropSpec.indexesCollection`.
      return p.indexesCollection === undefined
        ? { kind: 'number' }
        : { kind: 'collectionIndex', collection: p.indexesCollection }
    case 'boolean':
      return { kind: 'boolean' }
    case 'icon':
    case 'node':
      return { kind: 'node' }
    // A URL the user should be able to upload or pick, not type by hand.
    case 'image':
      return { kind: 'image' }
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

/**
 * What an inserted component starts out holding.
 *
 * **A component inserted with no content is not a component, it is a blank
 * box.** This used to seed three things — `label` (from the component's own
 * name), a collection's documented example, and an enum's first option — and
 * every content-bearing prop outside those three got nothing. So inserting a
 * `SystemBanner` drew a bare tinted row, a `Snackbar` drew an empty capsule, a
 * `LinearProgressIndicator` drew a grey track at 0%, a `ProgressStepper` drew
 * nothing at all, and an `Accordion` drew an untitled header. The author was
 * handed an empty shell and no clue which of eleven props would make it
 * visible. That is the same defect `TabBar.items` was fixed for, and this is
 * the same fix generalised: `PropSpec.example` now carries the package's own
 * documented value for EVERY prop whose docs show one, so a component arrives
 * looking like the thing its own documentation says it is.
 *
 * Everything seeded here is a real, editable prop written into the user's
 * source on insert — placeholder copy to replace, not a canvas-only illusion.
 * Three kinds never reach a manifest `example` at all (`documentedExample`): an
 * asset path (it names a file their project does not have), a React node or
 * icon (no JSON form, and inventing a glyph would put design in their source
 * their docs never asked for), and a handler (never a value). Two more are
 * recorded in the manifest — which is a record of what the docs SAY — and
 * declined here, which is the separate question of what an insert should WRITE:
 * see `isSeedableDefault`.
 *
 * The documented example beats the component's own name for `label` — `Callout`
 * documents `label="Cheapest for your dates"`, which shows what the component
 * is FOR; the bare word "Callout" only repeats what the layer tree already
 * says. The name stays as the fallback for a `label` the docs leave unshown.
 */
function buildDefaults(spec: ComponentSpec): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const p of spec.props) {
    // `dir` is the canvas's, not the node's — see `CANVAS_DRIVEN_PROPS`.
    if (isCanvasDrivenProp(p.name)) continue
    if (p.example !== undefined && isSeedableDefault(p)) defaults[p.name] = p.example
    else if (p.name === 'label') defaults[p.name] = spec.name
    else if (p.enumValues?.length) defaults[p.name] = p.enumValues[0]
  }
  // Last, so a curated value beats the docs' own — that is the whole point of
  // an entry existing. See `CURATED_DEFAULTS`.
  return { ...defaults, ...CURATED_DEFAULTS[spec.name] }
}

/**
 * Whether a documented example is worth WRITING into the user's source on
 * insert. Content, yes; the component's own defaults and its failure states, no.
 *
 * **Booleans are declined wholesale.** A boolean is never a component's content
 * — it is a mode — and this package documents each one at the value the
 * component already uses (`skeleton={false}`, `dismissOnScrim={true}`,
 * `showBottomBar={true}  // defaults to true`). Writing them back changes
 * nothing on the canvas and costs an inserted `<TextInput>` five redundant
 * attributes (`disabled={false} required={false} skeleton={false}
 * multiline={false} password={false}`) in a file a human reads. The panel's
 * toggle still shows and sets every one of them.
 *
 * **`errorText` and friends are declined by name**, the one place here that
 * reads a name rather than a form. TextInput's own docs are explicit that "the
 * error state is derived from `errorText` being non-empty" — so seeding the
 * documented `"Error message"` does not illustrate the field, it puts every
 * newly inserted field into its failure state, red border and all. A component
 * arriving broken is worse than one arriving blank, which is the whole reason
 * this function exists.
 */
const ERROR_STATE_PROP_RE = /^error/i

function isSeedableDefault(p: PropSpec): boolean {
  if (p.kind === 'boolean' || typeof p.example === 'boolean') return false
  return !ERROR_STATE_PROP_RE.test(p.name)
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
    const converted = reviveValue(value, key)
    if (converted === value) continue
    revived ??= { ...props }
    revived[key] = converted
  }
  return revived ?? props
}

/**
 * One prop value, with every slot sentinel and every `{ svg }` inside it turned
 * back into a React element — at ANY depth, not only at the top.
 *
 * Depth is the whole point. A design system's list content carries its own
 * icons: `items={[{ icon: <svg…/>, label: 'Home' }]}` is the documented shape
 * of a `TabBar`, and the parser now captures those nested elements as
 * `{ svg: markup }` the same way it always captured a top-level one. This used
 * to look only at the top level, so those five icons arrived as plain objects,
 * were handed to the component as objects, and rendered as nothing — five empty
 * icon slots above five correct labels.
 *
 * Returns the value UNCHANGED (by identity) when nothing inside it needed
 * reviving, so the caller can keep the original props object and the
 * design-system component's props stay referentially stable between renders.
 */
function reviveValue(value: unknown, key: string): unknown {
  const slotNodeId = studioSlotNodeId(value)
  if (slotNodeId !== undefined) return React.createElement(NodeRenderer, { key: slotNodeId, nodeId: slotNodeId })
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item, index) => {
      const converted = reviveValue(item, `${key}-${index}`)
      if (converted !== item) changed = true
      return converted
    })
    return changed ? items : value
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const svg = entries.length === 1 && entries[0]![0] === 'svg' ? entries[0]![1] : undefined
  if (typeof svg === 'string') {
    // Sanitised here for the same reason `SvgEditor` sanitises: never trust
    // that an upstream layer did.
    const markup = sanitizeSvg(svg)
    if (!markup) return value
    return React.createElement('span', {
      key,
      style: { display: 'inline-flex' },
      dangerouslySetInnerHTML: { __html: markup },
    })
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of entries) {
    const converted = reviveValue(entryValue, `${key}-${entryKey}`)
    if (converted !== entryValue) changed = true
    out[entryKey] = converted
  }
  return changed ? out : value
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

/**
 * Tokenizes a `codeFunctionPaths` entry (`'toolbar.onBack'`,
 * `'actions[0].onClick'`) into its object-key / array-index segments. The
 * FIRST segment is always the top-level prop name (`extractProps` prefixes
 * every path with it) — see `PageNode.codeFunctionPaths`.
 */
const CODE_FUNCTION_PATH_TOKEN_RE = /[^[.\]]+|\[(\d+)\]/g

function parseCodeFunctionPath(path: string): (string | number)[] {
  const segments: (string | number)[] = []
  for (const match of path.matchAll(CODE_FUNCTION_PATH_TOKEN_RE)) {
    segments.push(match[1] !== undefined ? Number(match[1]) : match[0])
  }
  return segments
}

/**
 * Rebuilds `root` with `value` set at `segments`, cloning only the objects/
 * arrays ALONG the path — everything else in `root` is shared, not copied.
 * Used to stand a no-op function back up at a nested key the parser could
 * only record the LOCATION of (`ParsedNode.codeFunctionPaths` has no value to
 * give here — a function has no JSON form) without mutating the node's own
 * `props`, which other renders of the same node still read.
 */
function withValueAtPath(root: unknown, segments: readonly (string | number)[], value: unknown): unknown {
  if (segments.length === 0) return value
  const [head, ...rest] = segments
  if (typeof head === 'number') {
    const next = Array.isArray(root) ? [...root] : []
    next[head] = withValueAtPath(next[head], rest, value)
    return next
  }
  const next: Record<string, unknown> =
    root !== null && typeof root === 'object' && !Array.isArray(root) ? { ...(root as Record<string, unknown>) } : {}
  next[head] = withValueAtPath(next[head], rest, value)
  return next
}

/**
 * `handlerProps` are the prop names this component's manifest marks
 * `kind: 'handler'`. Several design-system components gate a visible
 * affordance on being given one — a `BottomSheet` draws its leading close
 * button only when `onClose` is provided, and its trailing action button only
 * for `onAction` — and a function is exactly what the parser cannot hand over
 * (the prop is code-valued, so it never reaches `props`). The result was a
 * sheet whose close button was missing from a design that plainly has one.
 *
 * `codeProps` says which handlers the SOURCE actually wrote, so each one can
 * be stood up with a no-op. Conditional on that, never blanket: defaulting
 * every handler on would draw a trailing action button on every sheet ever
 * scaffolded, inventing an affordance the design does not have.
 *
 * A handler nested INSIDE an object/array prop (`toolbar={{ …, onBack: () =>
 * {} }}`) is the same fact one level deeper, driven off `codeFunctionPaths`
 * instead — see the render body below and `parseCodeFunctionPath`/
 * `withValueAtPath` above.
 */
/**
 * A prop the package documents as a structured value (`items={[{ icon, label }]}`)
 * holding something that is not one.
 *
 * This is a CONTRADICTION, not a guess: the manifest read the shape off the
 * package's own usage docs, so a scalar there cannot be a legitimate value.
 * Studio itself wrote these — the panel used to render a text box for any prop
 * it could not classify, and typing `5` into `TabBar.items` reached
 * `items.map(...)` and put a bare "TabBar (render error)" on the canvas.
 * `componentPropKind.ts` no longer offers that control, but sources already
 * carry the damage, and an agent or a hand edit can still write it.
 *
 * Reported rather than repaired. Dropping the bad prop would render a healthy
 * TabBar over source that genuinely breaks in a real browser, and a canvas that
 * is more forgiving than reality is the one thing this canvas must never be.
 */
function badCollectionProps(props: Record<string, unknown>, collectionProps: readonly string[]): string[] {
  return collectionProps.filter((prop) => {
    const value = props[prop]
    if (value === undefined || value === null) return false // absent is fine — the component's own default applies
    return typeof value !== 'object'
  })
}

function makeComponent(
  name: string,
  handlerProps: readonly string[],
  collectionProps: readonly string[] = [],
): React.FC<ModuleComponentProps> {
  const Comp = (DS as Record<string, unknown>)[name] as React.ComponentType<Record<string, unknown>> | undefined
  // Stands in for a handler the source supplied but the canvas can never
  // receive. One identity per component definition, not per render — a fresh
  // arrow each pass would change the design-system component's props every time.
  const noopHandler = (): void => {}
  const AlmEditor: React.FC<ModuleComponentProps> = ({
    props,
    nodeWrapperProps,
    mcClassName,
    children,
    codeProps,
    codeFunctionPaths,
  }) => {
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
    for (const prop of handlerProps) {
      if (codeProps?.includes(prop)) dsProps[prop] = noopHandler
    }
    // The nested counterpart of the loop above — a handler the source wrote
    // INSIDE an object/array prop (`toolbar={{ …, onBack: () => {} }}`),
    // which the parser can trace the LOCATION of but never a value for. Same
    // rule as `handlerProps`: only ever stands one up where `codeFunctionPaths`
    // says the source actually wrote one, never invented. See
    // `ParsedNode.codeFunctionPaths` for why this can't be driven off the
    // manifest the way `handlerProps` is — a nested key has no manifest entry
    // of its own to classify.
    for (const path of codeFunctionPaths ?? []) {
      const [propName, ...rest] = parseCodeFunctionPath(path)
      if (typeof propName !== 'string') continue
      dsProps[propName] = rest.length === 0 ? noopHandler : withValueAtPath(dsProps[propName], rest, noopHandler)
    }
    // The node's CSS classes go on the design-system component, where the source
    // wrote them — applying them to the host as well double-applied every
    // padding and margin in the rule.
    const className = mergeClassNames(dsProps.className, mcClassName)
    // The canvas has always rendered this node's child modules and handed
    // them in; nothing here ever passed them on, so a container component's
    // slot rendered empty. A component that takes its text through a `label`
    // prop simply ignores them, exactly as it does in the user's own source.
    // `canHaveChildren` (below) is the separate question of whether the EDITOR
    // offers it as a drop target.
    //
    // Passed ONLY when there is at least one child, never as an empty list.
    // `createElement(C, props, children)` sets `props.children` to whatever it
    // is given, and an empty array is TRUTHY — so a component that renders an
    // optional wrapper with `children && <div className="…__slot">` emits that
    // wrapper for a node with no children at all. Measured: a self-closing
    // `<Dialog />` grew a phantom `.ios-dialog__slot`, and because
    // `.ios-dialog__content` is a flex column with `gap: 10px`, the empty
    // zero-height child made the canvas dialog 284px where the same source
    // renders 274px in a real browser. Omitting the argument entirely leaves
    // `props.children` undefined, which is what the source actually says.
    // Say WHICH prop is wrong and what it holds, instead of letting the
    // component throw into a boundary that can only report "(render error)".
    const invalid = badCollectionProps(dsProps, collectionProps)
    if (invalid.length > 0) {
      const detail = invalid
        .map((prop) => `${prop} expects a list, found ${JSON.stringify(dsProps[prop])}`)
        .join('; ')
      return React.createElement(
        'div',
        { ...editorProps, style: TRANSPARENT_HOST_STYLE },
        React.createElement('span', null, `${name} — ${detail}`),
      )
    }
    const childArgs = React.Children.count(children) > 0 ? [children] : []
    const inner = Comp
      ? React.createElement(
          Comp,
          {
            ...dsProps,
            ...(className !== undefined ? { className } : {}),
            ...(nodeStyle ? { style: nodeStyle } : {}),
          },
          ...childArgs,
        )
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
  const handlerProps = spec.props.filter((prop) => prop.kind === 'handler').map((prop) => prop.name)
  const collectionProps = spec.props.filter((prop) => prop.kind === 'collection').map((prop) => prop.name)
  const mod = {
    id: `alm.${spec.name}`,
    name: spec.name,
    description: `${spec.name} — @alm-design/design-system`,
    category: 'Design System',
    version: '1.0.0',
    icon: CursorClickSolidIcon,
    trusted: true,
    canHaveChildren: CHILD_ACCEPTING_COMPONENT_NAMES.has(spec.name),
    schema: buildSchema(spec.props),
    propsSchema,
    defaults: buildDefaults(spec),
    sourceImport: { specifier: ALM_PACKAGE_SPECIFIER, name: spec.name },
    component: makeComponent(spec.name, handlerProps, collectionProps),
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
    // An icon is a leaf, always — it is not in CHILD_ACCEPTING_COMPONENTS and
    // `spec` isn't even in scope here (these come from the package's runtime
    // exports, not the manifest).
    canHaveChildren: false,
    schema: buildSchema([]),
    propsSchema: buildPropsSchema([]),
    defaults: {},
    sourceImport: { specifier: ALM_PACKAGE_SPECIFIER, name },
    component: makeComponent(name, []),
    render: () => ({ html: '' }),
  } as unknown as ModuleDefinition<Record<string, unknown>>

  registry.registerOrReplace(iconMod)
  registered += 1
}

if (typeof console !== 'undefined') {
  console.info(`[alm] registered ${registered} design-system modules (${iconExportNames.length} icons)`)
}
