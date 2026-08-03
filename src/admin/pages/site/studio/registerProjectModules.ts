/**
 * registerProjectModules — WS-3.3 of `STUDIO-IMPORT-V2-PLAN.md`: the generic
 * consumer of `pkg-01`'s server-side manifest/bundle work
 * (`server/handlers/studio/{packageManifest,componentBundle}.ts`). Turns
 * `pkg.<sanitized-package>.<ComponentName>` nodes — the moduleId
 * `studioPageLoad.ts`'s `resolveModuleId` now assigns to every REAL
 * npm-package component the parser finds, for whatever design system the
 * PROJECT actually imports — into live, editable canvas modules, the same
 * way `src/modules/alm/register.tsx` does for the one hardcoded
 * `@alm-design/design-system` case.
 *
 * `src/modules/alm/register.tsx` is NOT deleted by this change —
 * `standing-07` (STATE.md): that deletion is gated on the generic pipeline
 * being PROVEN to render the eSIM board visually equivalently, which needs a
 * real browser dogfood pass this change does not run. The two paths coexist:
 * `@alm-design/design-system` components keep resolving to `alm.<Name>`
 * (`studioPageLoad.ts`'s `ALM_DESIGN_PACKAGE_SPECIFIER` carve-out); every
 * OTHER package's components resolve to `pkg.*` and register here.
 *
 * Kept VERBATIM from `register.tsx`, because each earned its own comment
 * there — see the sibling functions/constants below for why:
 *   - the error boundary (`AlmErrorBoundary` → `PackageErrorBoundary`)
 *   - `TRANSPARENT_HOST_STYLE` (`display: contents`) — the host carries NO
 *     layout of its own, `nodeVisualRect` (canvas-side) is what keeps a
 *     box-less node selectable
 *   - `Type.Optional(Type.Unknown())` for every prop — declaring the truth
 *     when there is no real type to declare
 *   - the class-goes-on-the-component-not-the-host rule (`mergeClassNames`)
 *   - the `{svg}` JSON icon-revival shape (now one of TWO revival cases —
 *     see `revivePropValue`)
 *
 * NEW in this generic path, beyond what `register.tsx` does for the single
 * hardcoded package:
 *   - **Registration is undoable on project switch.** `register.tsx`'s
 *     registration is a module-level side effect at import — it can never be
 *     reversed. `syncProjectModules` tracks exactly which ids IT registered
 *     for the currently-active project dir and calls `registry.unregister`
 *     on every one of them the moment the project changes, before
 *     registering the new project's set.
 *   - **The bundle is fetched lazily** — only when (a) the project's trust
 *     tier is ≥ 1 (`render-packages`/`run-project`; Tier 0 is the default for
 *     every fresh import, `meta-03` decision 1) AND (b) the currently loaded
 *     board actually contains an unregistered `pkg.*` node. Both conditions
 *     are checked once per project-load/trust-tier transition inside a
 *     `useEffect`, via a single IMPERATIVE `useEditorStore.getState()` read —
 *     never a reactive `useEditorStore(selector)` scan, which would run on
 *     every store change (store-engineer's own rule).
 *   - **WS-3.4 — `ReactNode` props render as slots.** `iconPropFromJsx`
 *     (page-parser) still recovers only one level of raw SVG markup; anything
 *     else assigned to a component prop as JSX (`header={<PageHeader/>}`) is
 *     now captured by `parsePageFile.ts`'s `captureSlotProps` as a REAL child
 *     node, referenced from `props` via a sentinel
 *     (`@core/utils/studioSlotSentinel`) rather than inlined as JSON.
 *     `revivePropValue` recognizes the sentinel and renders the referenced
 *     node through the ordinary `NodeRenderer`, then hands the resulting
 *     React element to the underlying design-system component as that prop's
 *     value — reusing the "materialized, locked node in the page tree" shape
 *     `base.slot-instance` established for VC slots, not its code path.
 *   - `canHaveChildren: true` (register.tsx hardcodes `false` — its own doc
 *     calls this a deliberate first-slice restriction to a "SAFE_SUBSET").
 *     Nested JSX children (`<Button><Icon/> Buy now</Button>`) are extremely
 *     common in real design systems, and `ModuleComponentProps.children`
 *     already carries the rendered subtree — passing it through to the
 *     underlying component is the correct general behaviour.
 *   - A best-effort provider probe (`findProvider`): the FIRST export whose
 *     name ends in `Provider` in the bundled module namespace, instead of
 *     `register.tsx`'s hardcoded `DesignSystemProvider` lookup. Per-project
 *     configuration of which provider to use (the roadmap's own risk-register
 *     entry for WS-3) is NOT built here — an honest, documented gap; see the
 *     `pkg-02` STATE.md entry.
 */
import React, { useEffect, useSyncExternalStore } from 'react'
import { apiRequest } from '@core/http'
import { ensurePluginRuntime } from '@admin/pluginRuntimeBootstrap'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { sanitizeSvg } from '@core/sanitize'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import {
  registry,
  packageModuleId,
  sanitizePackageName,
  PALETTE_HIDDEN_NAME_RE,
  type ModuleDefinition,
  type ModuleComponentProps,
} from '@core/module-engine'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { NodeRenderer } from '@site/canvas/NodeRenderer'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import { getStudioPaletteHiddenModuleIds } from './fsCodemodAdapter'
import { getStudioTrustTier, setPackageBundleStatus, subscribeStudioTrustTier } from './studioProjectTrust'

// ---------------------------------------------------------------------------
// Wire shape — mirrors the server's `PropKind`/`ComponentSpec`/`BundledComponentSpec`
// (`packageManifestSchema.ts`, `componentBundle.ts`). This file runs in the
// browser, so — same reasoning as `fsCodemodAdapter.ts`'s `ComponentSourceSchema`
// — it only needs to agree on the JSON wire shape, not import the Node/ts-morph
// server modules that produce it.
// ---------------------------------------------------------------------------

const PropKindSchema = Type.Union([
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
type PropKind = Static<typeof PropKindSchema>

const PropSpecSchema = Type.Object({
  name: Type.String(),
  kind: PropKindSchema,
  required: Type.Boolean(),
})

const BundledComponentSpecSchema = Type.Object({
  name: Type.String(),
  file: Type.String(),
  exportName: Type.String(),
  isDefaultExport: Type.Boolean(),
  props: Type.Array(PropSpecSchema),
  pkg: Type.String(),
})
type BundledComponentSpec = Static<typeof BundledComponentSpecSchema>

const ProbeWarningSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  fix: Type.String(),
})

const ComponentBundleResponseSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    url: Type.Union([Type.String(), Type.Null()]),
    hash: Type.Union([Type.String(), Type.Null()]),
    components: Type.Array(BundledComponentSpecSchema),
    warnings: Type.Array(ProbeWarningSchema),
  }),
  Type.Object({
    ok: Type.Literal(false),
    code: Type.String(),
    message: Type.String(),
    warnings: Type.Optional(Type.Array(ProbeWarningSchema)),
  }),
])

// ---------------------------------------------------------------------------
// Palette hiding — name heuristic + `.studio/meta.json` override (union, see
// `paletteHiddenModuleIds`'s doc in `studioMeta.ts`).
// ---------------------------------------------------------------------------

/**
 * Module ids the insert palette hides, across every registered package —
 * consulted by `moduleAvailability` (`moduleInserterModel.ts`) alongside
 * `PALETTE_HIDDEN_ALM_MODULE_IDS`. Rebuilt wholesale each `syncProjectModules`
 * run (cheap — one pass over the just-fetched component list), not
 * maintained incrementally: this only changes once per project load/switch,
 * never per keystroke.
 */
let paletteHiddenPackageModuleIds: ReadonlySet<string> = new Set()

export function getPaletteHiddenPackageModuleIds(): ReadonlySet<string> {
  return paletteHiddenPackageModuleIds
}

// ---------------------------------------------------------------------------
// Error boundary — verbatim behaviour from `AlmErrorBoundary`.
// ---------------------------------------------------------------------------

class PackageErrorBoundary extends React.Component<
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
 * The host element every design-system component mounts under, carrying the
 * editor's selection/hover/keyboard wiring (`nodeWrapperProps`). Verbatim
 * from `register.tsx`'s `TRANSPARENT_HOST_STYLE` — see that file's doc for
 * why `display: contents` (no layout of its own) is load-bearing, and why
 * `nodeVisualRect` (canvas-side) exists.
 */
const TRANSPARENT_HOST_STYLE: React.CSSProperties = { display: 'contents' }

/** Merges two optional class strings, dropping empties and duplicates. Verbatim from `register.tsx`. */
function mergeClassNames(a: unknown, b: string | undefined): string | undefined {
  const names = new Set<string>()
  for (const source of [a, b]) {
    if (typeof source !== 'string') continue
    for (const name of source.split(/\s+/)) if (name) names.add(name)
  }
  return names.size > 0 ? [...names].join(' ') : undefined
}

/**
 * WS-3.4 — the two shapes a prop value can carry that need reviving into a
 * real React element before reaching the design-system component:
 *
 *   1. A slot sentinel (`studio-slot:<nodeId>`) — `captureSlotProps`
 *      (`parsePageFile.ts`) materialized the prop's JSX subtree as a real
 *      child node; render it through the ordinary `NodeRenderer` (same
 *      selection/hover/edit wiring any other canvas node gets) and hand the
 *      RESULT as the prop.
 *   2. The legacy `{ svg: markup }` shape `iconPropFromJsx` still produces
 *      for the one-level-deep SVG case (`<Icon svg={checkSvg}/>`) —
 *      `register.tsx`'s `reviveIconProps`, kept verbatim. `'svg'` is
 *      hardcoded (not imported from `@core/page-parser`'s `ICON_PROP_SVG_KEY`)
 *      for the same reason `register.tsx` does: that module pulls in
 *      ts-morph, which must never reach the browser bundle.
 */
function revivePropValue(value: unknown): React.ReactElement | undefined {
  const slotNodeId = studioSlotNodeId(value)
  if (slotNodeId !== undefined) {
    return React.createElement(NodeRenderer, { key: slotNodeId, nodeId: slotNodeId })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  const svg = entries.length === 1 && entries[0]![0] === 'svg' ? entries[0]![1] : undefined
  if (typeof svg !== 'string') return undefined
  const markup = sanitizeSvg(svg)
  if (!markup) return undefined
  return React.createElement('span', {
    style: { display: 'inline-flex' },
    dangerouslySetInnerHTML: { __html: markup },
  })
}

function reviveProps(props: Record<string, unknown>): Record<string, unknown> {
  let revived: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(props)) {
    const element = revivePropValue(value)
    if (element === undefined) continue
    revived ??= { ...props }
    revived[key] = element
  }
  return revived ?? props
}

/** The first export whose name ends in `Provider` in the bundled module namespace, or `undefined`. See module doc's "honest gap" note. */
function findProvider(mod: Record<string, unknown>): React.ComponentType<{ children?: React.ReactNode }> | undefined {
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value === 'function' && /Provider$/.test(key)) {
      return value as React.ComponentType<{ children?: React.ReactNode }>
    }
  }
  return undefined
}

function makePackageComponent(
  pkg: string,
  name: string,
  Comp: React.ComponentType<Record<string, unknown>>,
  Provider: React.ComponentType<{ children?: React.ReactNode }> | undefined,
): React.FC<ModuleComponentProps> {
  const PackageModuleComponent: React.FC<ModuleComponentProps> = ({ props, nodeWrapperProps, mcClassName, children }) => {
    // `style` is pulled OUT of the editor bag: it holds the node's own inline
    // styles, which belong on the styled component, not on the transparent
    // host where `display: contents` would make them inert.
    const { style: nodeStyle, ...editorProps } = nodeWrapperProps ?? {}
    const dsProps = reviveProps(props as Record<string, unknown>)
    // The node's CSS classes go on the design-system component, where the
    // source wrote them — applying them to the host too double-applies
    // every padding and margin in the rule.
    const className = mergeClassNames(dsProps.className, mcClassName)
    const inner = React.createElement(
      Comp,
      {
        ...dsProps,
        ...(className !== undefined ? { className } : {}),
        ...(nodeStyle ? { style: nodeStyle } : {}),
      },
      children,
    )
    const provided = Provider ? React.createElement(Provider, null, inner) : inner
    return React.createElement(
      'div',
      { ...editorProps, style: TRANSPARENT_HOST_STYLE },
      React.createElement(PackageErrorBoundary, { name }, provided),
    )
  }
  PackageModuleComponent.displayName = `Pkg(${pkg}:${name})`
  return PackageModuleComponent
}

// ---------------------------------------------------------------------------
// Schema / defaults
// ---------------------------------------------------------------------------

function controlForKind(name: string, kind: PropKind): Record<string, unknown> | undefined {
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
      // WS-6.5 — the sentinel value is meaningless in a scalar control, but
      // the slot IS a real, editable node (WS-3.4's materialized child) —
      // `SlotControl` renders an "Edit contents" affordance that selects it,
      // rather than silently dropping the row (the prior behaviour: this
      // component genuinely HAS an icon/header slot and a user had no way to
      // discover that from the Properties panel).
      return { type: 'slot', label: name }
    case 'string':
    case 'unknown':
    default:
      return { type: 'text', label: name }
  }
}

function buildSchema(props: readonly BundledComponentSpec['props'][number][]): ModuleDefinition['schema'] {
  const schema: Record<string, unknown> = {}
  for (const p of props) {
    const control = controlForKind(p.name, p.kind)
    if (control) schema[p.name] = control
  }
  return schema as ModuleDefinition['schema']
}

/**
 * Every prop is `Unknown`, because it genuinely is — there is no real type
 * here to declare. Verbatim reasoning from `register.tsx`'s
 * `buildPropsSchema`: `Type.String()` actively lied and broke a real
 * `actions={[{label}]}`-shaped prop; declaring the truth passes any value
 * through untouched.
 */
function buildPropsSchema(props: readonly BundledComponentSpec['props'][number][]) {
  const shape: Record<string, ReturnType<typeof Type.Optional>> = {}
  for (const p of props) shape[p.name] = Type.Optional(Type.Unknown())
  return Type.Object(shape)
}

function buildDefaults(spec: BundledComponentSpec): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const p of spec.props) {
    if (p.name === 'label') defaults[p.name] = spec.name
    else if (p.kind.kind === 'enum' && p.kind.values.length > 0) defaults[p.name] = p.kind.values[0]
  }
  return defaults
}

// ---------------------------------------------------------------------------
// Registration bookkeeping — undoable on project switch.
// ---------------------------------------------------------------------------

let activeProjectDir: string | null = null
let activeModuleIds = new Set<string>()

function unregisterActiveProjectModules(): void {
  for (const id of activeModuleIds) registry.unregister(id)
  activeModuleIds = new Set()
  paletteHiddenPackageModuleIds = new Set()
  setPackageBundleStatus(null)
}

/** One-time imperative scan (NOT a reactive `useEditorStore(selector)`) — see module doc. */
function siteHasUnregisteredPackageNode(): boolean {
  const site = useEditorStore.getState().site
  if (!site) return false
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.moduleId.startsWith('pkg.') && !registry.has(node.moduleId)) return true
    }
  }
  return false
}

/**
 * Fetches the project's component bundle and registers every component it
 * contains. Safe to call more than once for the same `dir` (the server
 * caches by content hash; `registerOrReplace` is idempotent).
 */
async function syncProjectModules(dir: string): Promise<void> {
  const response = await apiRequest('/admin/api/studio/component-bundle', {
    method: 'POST',
    body: { dir },
    schema: ComponentBundleResponseSchema,
  })
  if (dir !== activeProjectDir) return // project changed again while this request was in flight

  if (!response.ok) {
    console.error(`[registerProjectModules] bundle refused (${response.code}): ${response.message}`)
    setPackageBundleStatus({ ok: false, code: response.code, message: response.message })
    return
  }
  setPackageBundleStatus({ ok: true })
  if (response.components.length === 0 || !response.url) return

  await ensurePluginRuntime()
  if (dir !== activeProjectDir) return

  const mod: Record<string, unknown> = await import(/* @vite-ignore */ response.url)
  if (dir !== activeProjectDir) return

  const metaHidden = new Set(getStudioPaletteHiddenModuleIds())
  const nextHidden = new Set<string>(paletteHiddenPackageModuleIds)
  const Provider = findProvider(mod)

  for (const spec of response.components) {
    const exportKey = `${sanitizePackageName(spec.pkg)}__${spec.name}`
    const Comp = mod[exportKey] as React.ComponentType<Record<string, unknown>> | undefined
    if (!Comp) continue

    const id = packageModuleId(spec.pkg, spec.name)
    if (PALETTE_HIDDEN_NAME_RE.test(spec.name) || metaHidden.has(id)) nextHidden.add(id)

    const mod_: ModuleDefinition<Record<string, unknown>> = {
      id,
      name: spec.name,
      description: `${spec.name} — ${spec.pkg}`,
      category: 'Design System',
      version: '1.0.0',
      icon: CursorClickSolidIcon,
      trusted: true,
      canHaveChildren: true,
      schema: buildSchema(spec.props),
      propsSchema: buildPropsSchema(spec.props),
      defaults: buildDefaults(spec),
      // How this component is spelled in the user's source, so adding it from
      // the picker can write `import { X } from '<pkg>'` + `<X />` into the
      // file — see `ModuleDefinition.sourceImport`.
      sourceImport: { specifier: spec.pkg, name: spec.name },
      component: makePackageComponent(spec.pkg, spec.name, Comp, Provider),
      // Publish (HTML) path is out of scope, same as `register.tsx` — the canvas uses `component` above.
      render: () => ({ html: '' }),
    } as unknown as ModuleDefinition<Record<string, unknown>>

    registry.registerOrReplace(mod_)
    activeModuleIds.add(id)
  }

  paletteHiddenPackageModuleIds = nextHidden
}

// ---------------------------------------------------------------------------
// Hook — mount once from the editor body (`AdminCanvasEditorBody.tsx`).
// ---------------------------------------------------------------------------

/**
 * Drives registration for whichever project is currently open:
 *   - On every project-dir change, unregisters the previous project's `pkg.*`
 *     modules FIRST — regardless of whether the new project needs a fetch —
 *     so switching away from a project never leaves its modules registered.
 *   - Fetches + registers the new project's bundle only when its trust tier
 *     is ≥ 1 AND the loaded board actually has an unregistered `pkg.*` node.
 *     Tier 0 (the default for every fresh import) leaves the canvas showing
 *     `NodeRenderer`'s "promote this project" placeholder instead — no
 *     network request, no code execution, until the user opts in.
 *   - Re-runs when the trust tier changes (a successful "promote" action —
 *     `promoteProjectToTier1` in `studioProjectTrust.ts` — updates the
 *     external store this hook subscribes to), so promoting mid-session
 *     picks up components without a full page reload.
 */
export function useRegisterProjectModules(): void {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)

  useEffect(() => {
    if (projectDir !== activeProjectDir) {
      unregisterActiveProjectModules()
      activeProjectDir = projectDir
    }
    if (!projectDir) return
    if (trust === 'static') return
    if (!siteHasUnregisteredPackageNode()) return
    void syncProjectModules(projectDir)
  }, [projectDir, trust])
}
