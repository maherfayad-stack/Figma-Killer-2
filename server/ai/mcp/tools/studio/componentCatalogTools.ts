/**
 * studio_list_components / studio_find_component — the design-system
 * COMPONENT catalog the Studio insert palette draws from, exposed headlessly.
 *
 * Root cause this closes: the palette (`moduleInserterModel.ts`, Studio mode
 * only shows `category === 'Design System'` entries) is fed by
 * `POST /admin/api/studio/component-bundle`'s `BundledComponentSpec[]` — a
 * complete, typed, machine-readable component API (name, package, prop specs
 * with enum variants). No MCP tool exposed any of it. An agent could not
 * enumerate what the palette offers, could not see a single prop signature,
 * and had to guess component names from prose docs — the documented failure
 * a real board shipped with (2 of 42 available components used, a hand-rolled
 * nav/divider/cards that already existed as design-system components).
 *
 * **Two component sources are merged here, and neither is guessed from the
 * other — see `apiSource`.**
 *
 *   - `apiSource: 'types'` — `buildPackageManifest` verbatim, the exact
 *     syntactic `.d.ts`/`.tsx` extraction `componentBundle.ts`'s POST route
 *     runs, over the same demand list (`ProjectProfile.componentPackages`).
 *     Deliberately does NOT reuse `componentBundle.ts`'s Tier-1 trust gate or
 *     its `Bun.build` subprocess: this tool only ever needs the MANIFEST
 *     (names + prop specs), never an `import()`-able bundle, and
 *     `packageManifest.ts`'s own doc is explicit that its extraction "only
 *     ever PARSES declaration text" and is Tier-0 safe standing alone —
 *     gating a pure read behind a trust-tier promotion the user hasn't
 *     granted (and this tool cannot itself grant) would refuse a harmless
 *     catalog read for no real security reason.
 *   - `apiSource: 'code-connect'` — `collectFigmaCodeConnectComponents`
 *     (`figmaCodeConnect.ts`), for a component `buildPackageManifest` found
 *     NOTHING for (measured against the real `@alm-design/design-system`:
 *     it ships no `.d.ts` and no typed source entry, so `buildPackageManifest`
 *     returns zero components for it — but it DOES ship 29 Figma Code Connect
 *     `*.figma.tsx` files carrying the exact same prop/enum information in a
 *     different, still fully static, source). Props on a `code-connect` entry
 *     are DERIVED from the Figma variant mapping (a `figma.enum` whose
 *     code-side values are all strings becomes `PropKind.enum`; all-boolean
 *     becomes `PropKind.boolean`; anything this can't reduce to one of those
 *     stays `unknown` — never guessed), and `required` is always `false`
 *     (Code Connect maps VALUES a variant can take, not whether a prop must
 *     be supplied — there is no signal for that here, unlike a `.d.ts`).
 *   - When a `types` component and a `code-connect` mapping exist for the
 *     SAME component name, the entry stays `apiSource: 'types'` (the more
 *     precise source) with a `figma` field ADDED on top — never merged into
 *     `props` itself, so the type-derived shape and the Figma-derived shape
 *     never blur into one indistinguishable thing.
 *
 * `studio_list_component_bindings` (`figmaBindingTools.ts`) is the deep-dive
 * sibling of the `figma` field here — the full per-value Figma label mapping,
 * verification prose, and usage example, for when the summary here isn't
 * enough.
 *
 * **A CSS-only imported design system yields ZERO components here — by
 * design, not by bug.** The "Import design tokens" wizard's
 * `styles/imported/<slug>/` copy (`designSystemDetect.ts`) is plain CSS: no
 * `package.json`, no `node_modules` entry, nothing either extractor above can
 * read a component API out of. `detectDesignSystems` still reports it in this
 * tool's `designSystems` field (`source:'imported'`) so an agent can tell "no
 * design system" from "a design system with no readable component API" — the
 * latter still has real per-component stylesheets under its `root` (one
 * `.css` file per component name) worth reading directly, just not through
 * this tool. Building a CSS parser to close that gap is explicitly out of
 * scope here (see mcp-tooling's own work order) — the honest gap is surfaced
 * in the `note` field instead of silently returning an empty list with no
 * explanation.
 */
import { join } from 'node:path'
import { StudioListComponentsInputSchema, StudioFindComponentInputSchema } from '@core/ai'
import { packageModuleId, PALETTE_HIDDEN_NAME_RE } from '@core/module-engine'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { resolveAppRoot } from '../../../../handlers/studio/appRoot'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { buildPackageManifest } from '../../../../handlers/studio/packageManifest'
import { detectDesignSystems } from '../../../../handlers/studio/designSystemDetect'
import type { DesignSystemRef, ProbeWarning } from '../../../../handlers/studio/projectProfileSchema'
import type { BundledComponentSpec } from '../../../../handlers/studio/componentBundle'
import type { PropKind, PropSpec } from '../../../../handlers/studio/packageManifestSchema'
import { collectFigmaCodeConnectComponents } from '../../../../handlers/studio/figmaCodeConnect'
import type { FigmaCodeConnectComponent, FigmaCodeConnectProp } from '../../../../handlers/studio/figmaCodeConnectSchema'

/** The Figma binding summary attached to a catalog entry — kept as its OWN sub-object rather than folded into `props`, so a type-derived prop list and a Figma-derived one are never indistinguishable. See module doc's `apiSource` section. */
interface FigmaBindingSummary {
  url: string
  fileKey?: string
  nodeId?: string
  nodeIdPlaceholder: boolean
  file: string
  verifiedNote?: string
  example?: string
  /** The RAW Figma-side prop mapping (Figma property name + every label -> code value pair) — distinct from this entry's own `props` (the reduced `PropKind` shape every catalog entry carries regardless of source). */
  props: FigmaCodeConnectProp[]
}

/** One catalog entry: the wire shape the insert palette already uses, plus whether the palette hides it, which source produced it, and (when known) its Figma binding. */
type CatalogEntry = BundledComponentSpec & {
  hiddenFromPalette: boolean
  apiSource: 'types' | 'code-connect'
  figma?: FigmaBindingSummary
}

/** Generous enough for a real design system in one screen (the real corpora run 39–42) without being unbounded. */
const DEFAULT_LIST_LIMIT = 60
const DEFAULT_FIND_LIMIT = 40

// ---------------------------------------------------------------------------
// Code Connect -> PropSpec reduction — see module doc's `apiSource` section
// ---------------------------------------------------------------------------

/** A `figma.enum` mapping reduces to `PropKind.enum` only when every code-side value is a string (a real select-able set of options); an all-boolean mapping (`figma.enum('Switch', { on: true, off: false })`) reduces to `PropKind.boolean` instead — that IS what the code prop is. Anything this can't reduce to one of those (mixed types, numbers) stays `unknown` rather than inventing a values list the schema (`Type.Array(Type.String())`) couldn't even represent. */
function propKindFromCodeConnect(prop: FigmaCodeConnectProp): PropKind {
  if (prop.kind === 'boolean') return { kind: 'boolean' }
  if (prop.kind === 'string') return { kind: 'string' }
  if (prop.kind !== 'enum') return { kind: 'unknown' }

  const values = (prop.mapping ?? []).map((m) => m.codeValue)
  if (values.length === 0) return { kind: 'unknown' }
  if (values.every((v) => typeof v === 'boolean')) return { kind: 'boolean' }
  if (values.every((v) => typeof v === 'string')) return { kind: 'enum', values: [...new Set(values as string[])] }
  return { kind: 'unknown' }
}

/** A Code Connect component's own `props` -> the reduced `PropSpec[]` shape every catalog entry carries. `required` is always `false` — see module doc. */
function propsFromCodeConnect(props: readonly FigmaCodeConnectProp[]): PropSpec[] {
  return props.map((p) => ({ name: p.name, kind: propKindFromCodeConnect(p), required: false }))
}

function figmaBindingSummary(spec: FigmaCodeConnectComponent): FigmaBindingSummary {
  return {
    url: spec.figmaUrl,
    fileKey: spec.figmaFileKey,
    nodeId: spec.figmaNodeId,
    nodeIdPlaceholder: spec.nodeIdPlaceholder,
    file: spec.file,
    verifiedNote: spec.verifiedNote,
    example: spec.example,
    props: spec.props,
  }
}

// ---------------------------------------------------------------------------
// Shared catalog collection — both tools below derive from the exact same
// pass, so "what does studio_list_components see" and "what does
// studio_find_component search" can never silently diverge.
// ---------------------------------------------------------------------------

interface Catalog {
  packages: string[]
  designSystems: DesignSystemRef[]
  components: CatalogEntry[]
  warnings: ProbeWarning[]
}

/**
 * `dir` -> every component this project's installed design-system package(s)
 * expose, flattened and sorted, from BOTH sources (see module doc). Never
 * throws: `buildPackageManifest` and `collectFigmaCodeConnectComponents` both
 * already degrade an unreadable/uninstalled package to `{ components: [],
 * warnings }` on their own, so a project with no readable component API at
 * all still returns a valid, empty catalog plus its warnings — never a failed
 * tool call.
 */
function collectCatalog(dir: string): Catalog {
  const profile = resolveProjectProfile(dir)
  const appRootAbs = resolveAppRoot(dir)
  // Mirrors `projectProbe.ts`'s own `prefixAppRoot` closure exactly — see
  // `ProjectProfileSchema.appRoot`'s doc for why every OTHER install-dependent
  // path on this profile already carries this prefix.
  const prefixAppRoot = (relPath: string): string => (profile.appRoot ? `${profile.appRoot}/${relPath}` : relPath)
  // Recomputed fresh rather than trusting `profile.designSystems` — that field
  // is `Optional` precisely because a `.studio/meta.json` cache written before
  // it existed must keep validating (see its own schema doc), and this tool's
  // whole point is telling "no design system" from "a design system this
  // extractor can't read" — a `designSystems: undefined` cache miss must not
  // silently collapse into the former.
  const designSystems = detectDesignSystems(dir, profile.componentPackages, prefixAppRoot)

  const hiddenIds = new Set(readStudioMeta(dir).paletteHiddenModuleIds ?? [])
  const warnings: ProbeWarning[] = []
  const components: CatalogEntry[] = []

  for (const pkg of profile.componentPackages) {
    const typesResult = buildPackageManifest(appRootAbs, pkg)
    warnings.push(...typesResult.warnings)

    const pkgDir = join(appRootAbs, 'node_modules', ...pkg.split('/'))
    const codeConnectResult = collectFigmaCodeConnectComponents(pkgDir, pkg)
    warnings.push(...codeConnectResult.warnings)
    const codeConnectByName = new Map(codeConnectResult.components.map((c) => [c.component, c]))

    for (const spec of typesResult.components) {
      const hiddenFromPalette = PALETTE_HIDDEN_NAME_RE.test(spec.name) || hiddenIds.has(packageModuleId(pkg, spec.name))
      const codeConnect = codeConnectByName.get(spec.name)
      if (codeConnect) codeConnectByName.delete(spec.name) // consumed — anything left over is code-connect-ONLY
      components.push({
        ...spec,
        pkg,
        hiddenFromPalette,
        apiSource: 'types',
        ...(codeConnect ? { figma: figmaBindingSummary(codeConnect) } : {}),
      })
    }

    // Whatever's left in `codeConnectByName` has NO `.d.ts`/`.tsx` counterpart
    // — a component this project can only know about through its Figma
    // binding (the real `@alm-design/design-system` case: 0 types results,
    // 29 of these).
    for (const codeConnect of codeConnectByName.values()) {
      const hiddenFromPalette =
        PALETTE_HIDDEN_NAME_RE.test(codeConnect.component) || hiddenIds.has(packageModuleId(pkg, codeConnect.component))
      components.push({
        name: codeConnect.component,
        file: codeConnect.file,
        // Code Connect names the LOCAL import binding, not necessarily the
        // package's public entry export — every file in the real corpus uses
        // a plain named import matching the component's real export name, so
        // this is a reasonable default, not a verified fact the way a `.d.ts`
        // export name is.
        exportName: codeConnect.component,
        isDefaultExport: false,
        pkg,
        hiddenFromPalette,
        apiSource: 'code-connect',
        props: propsFromCodeConnect(codeConnect.props),
        figma: figmaBindingSummary(codeConnect),
      })
    }
  }
  components.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name))

  return { packages: [...profile.componentPackages].sort(), designSystems, components, warnings }
}

/** The honest explanation for an empty (or package-less) catalog when a CSS-only imported design system is the reason — see module doc. `undefined` when there is genuinely nothing to explain. */
function importedOnlyNote(designSystems: readonly DesignSystemRef[]): string | undefined {
  const imported = designSystems.filter((d) => d.source === 'imported')
  if (imported.length === 0) return undefined
  const names = imported.map((d) => `"${d.name}" (${d.root})`).join(', ')
  return `This project has no installed component package to read a component API from, but it does have a CSS-only imported design system: ${names}. That copy is plain CSS — no .d.ts/.tsx, so no component/prop list can be extracted from it. Its stylesheets (one .css file per component name under its root) and design tokens are still real and readable — use studio_read_file to read them directly.`
}

// ---------------------------------------------------------------------------
// studio_list_components
// ---------------------------------------------------------------------------

const listComponentsTool: AiTool = {
  name: 'studio_list_components',
  scope: 'shared',
  execution: 'server',
  description:
    'List this project\'s design-system components — the EXACT catalog the Studio insert palette draws from, read headlessly instead of through a live editor, PLUS every component this project only knows about through a Figma Code Connect binding (see apiSource below). Each entry is { name, pkg, exportName, isDefaultExport, file, hiddenFromPalette, apiSource, props, figma? }: pkg is the import specifier to write (`import { name } from pkg` for a named export; `import name from pkg` when isDefaultExport is true); props is [{ name, kind, required }] where kind is one of string/number/boolean/enum(+values)/color/image/node/handler/unknown — the SAME classification the Properties panel uses to choose a control (enum -> dropdown, color -> color picker, node -> slot). apiSource is "types" when props came from a real .d.ts/.tsx type (required is trustworthy), or "code-connect" when this project has NO typed entry for the package at all and every prop was instead reduced from a Figma Code Connect *.figma.tsx mapping file (required is always false there — Code Connect maps values a variant can take, not whether a prop is mandatory; do not trust it for that). When present, figma carries the raw Figma binding for that component regardless of apiSource: { url, fileKey, nodeId, nodeIdPlaceholder, verifiedNote, example, props }; nodeIdPlaceholder true means the URL\'s node-id is an un-filled-in "REPLACE-ME" template, not a real Figma reference — call studio_list_component_bindings for the full per-value Figma label mapping and verification prose this summary trims. hiddenFromPalette marks an overlay/portal component (Dialog/Sheet/Modal/Toast/Snackbar/Tooltip/Popover by name, or an explicit .studio/meta.json override) that is real and importable but excluded from the canvas picker as confusing to hand-place — still usable, just compose its JSX + import directly rather than through the palette. Pass filter to narrow by component name (case-insensitive substring) and package to restrict to one installed package when the project depends on more than one. Response is capped (default 60, max 200) and always reports matchedComponents/returnedComponents, with an honest omittedCount — never a silent drop. LIMITATION: a design system copied in via the "Import design tokens" wizard (styles/imported/<slug>/, plain CSS, no package.json, no Code Connect files either) has NO extractable component API from either source and returns zero components — check the response\'s designSystems field (source:"imported") and note to tell that case apart from "this project has no design system at all". Use studio_find_component when you already know a name or prop to search for instead of browsing the whole catalog.',
  inputSchema: StudioListComponentsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, filter, package: packageFilter, limit } = input as {
      dir?: string
      filter?: string
      package?: string
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { packages, designSystems, components, warnings } = collectCatalog(dir)

    const needle = filter?.trim().toLowerCase() ?? ''
    const pkgFilter = packageFilter?.trim()
    const matched = components.filter((c) => {
      if (pkgFilter && c.pkg !== pkgFilter) return false
      if (needle.length > 0 && !c.name.toLowerCase().includes(needle)) return false
      return true
    })

    const cap = limit ?? DEFAULT_LIST_LIMIT
    const shown = matched.slice(0, cap)
    const omittedCount = matched.length - shown.length
    const note = omittedCount > 0
      ? `${omittedCount} more component(s) matched but were not returned — narrow with filter/package, or raise limit (max 200).`
      : importedOnlyNote(designSystems)

    return {
      ok: true,
      dir,
      packages,
      designSystems,
      totalComponents: components.length,
      matchedComponents: matched.length,
      returnedComponents: shown.length,
      ...(omittedCount > 0 ? { truncated: true, omittedCount } : {}),
      components: shown,
      warnings,
      ...(note ? { note } : {}),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_find_component
// ---------------------------------------------------------------------------

const findComponentTool: AiTool = {
  name: 'studio_find_component',
  scope: 'shared',
  execution: 'server',
  description:
    'Search this project\'s design-system component catalog (see studio_list_components, including its Figma-Code-Connect-only components) by component name and/or a prop it declares — the narrow lookup for a large system where listing everything wastes context. Pass name to substring-match the component name, prop to substring-match a PROP NAME any matched component declares (e.g. prop:"variant" finds every component with a variant prop, so their enum values can be compared before picking one), or both together to narrow further. At least one of name/prop is required — for browsing without a starting point, call studio_list_components instead. Returns the same per-component shape as studio_list_components ({ name, pkg, exportName, isDefaultExport, file, hiddenFromPalette, apiSource, props, figma? }), capped (default 40, max 200) with an honest truncated/omittedCount when more matched than were returned. Same LIMITATION as studio_list_components: a CSS-only imported design system (styles/imported/<slug>/, no package.json, no Code Connect files) has no extractable component API from either source and will never appear in results — check the response\'s designSystems field and note to tell "nothing matched" from "there is nothing here to search".',
  inputSchema: StudioFindComponentInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, name, prop, limit } = input as {
      dir?: string
      name?: string
      prop?: string
      limit?: number
    }
    if (!name && !prop) {
      return {
        ok: false,
        error: 'Pass at least one of "name" or "prop" to search by. Use studio_list_components to browse the whole catalog instead.',
      }
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const { packages, designSystems, components, warnings } = collectCatalog(dir)

    const nameNeedle = name?.trim().toLowerCase()
    const propNeedle = prop?.trim().toLowerCase()
    const matched = components.filter((c) => {
      if (nameNeedle && !c.name.toLowerCase().includes(nameNeedle)) return false
      if (propNeedle && !c.props.some((p) => p.name.toLowerCase().includes(propNeedle))) return false
      return true
    })

    const cap = limit ?? DEFAULT_FIND_LIMIT
    const shown = matched.slice(0, cap)
    const omittedCount = matched.length - shown.length
    const note = omittedCount > 0
      ? `${omittedCount} more component(s) matched but were not returned — raise limit (max 200) or narrow name/prop.`
      : importedOnlyNote(designSystems)

    return {
      ok: true,
      dir,
      packages,
      designSystems,
      matchedComponents: matched.length,
      returnedComponents: shown.length,
      ...(omittedCount > 0 ? { truncated: true, omittedCount } : {}),
      components: shown,
      warnings,
      ...(note ? { note } : {}),
    }
  },
}

export const studioComponentCatalogMcpTools: AiTool[] = [listComponentsTool, findComponentTool]
