/**
 * nodeDiffWriteback — the per-node diff half of `fsCodemodAdapter.ts`'s
 * `saveSite`: given the dirty pages of a `SiteDocument`, walk every node and
 * produce the `StudioEditPayload[]` batch (props, text, tag, inline style)
 * plus the parallel baseline-advance lists (`bumps`/`drops`) and the
 * `pkg.*`/`studio.instance` inline-style refusals to toast.
 *
 * Split out of `fsCodemodAdapter.ts` (`speed-02`'s module-size-budget fix) —
 * this is a self-contained unit: it reads only the page tree + the
 * load-time baseline (`loadedValuesBaseline.ts`) and writes only its own
 * return value. Nothing here talks to the network or the editor store.
 * `saveSite` still owns everything downstream (the POST, refusal reporting,
 * baseline commits, resync) — only the diffing loop itself moved.
 */
import {
  type Page,
  type PageNode,
  canWriteInlineStyleForModule,
  hasWritableSourceLocation,
  isPropWritableToSource,
  loopTemplateNodeId,
  styleValueKey,
} from '@core/page-tree'
import type { SaveSiteOptions } from '@core/persistence/types'
import { registry } from '@core/module-engine'
import { CUSTOM_HTML_TAG_VALUE } from '@modules/base/utils/htmlTag'
import type { InlineStyleModuleRefusal } from '@site/panels/inlineStyleUnsavedNotice'
import {
  diffInlineStyles,
  getLoadedNodeValues,
  type NodeValueBump,
  type NodeValueDrop,
} from './loadedValuesBaseline'
import type { StudioEditPayload } from './studioEditPayload'
import { editOutcomeKey } from './editOutcomes'
import { rowsOfTemplate, type RowTemplateWrite } from './rowTemplateWrites'

export interface NodeDiffResult {
  edits: StudioEditPayload[]
  bumps: NodeValueBump[]
  drops: NodeValueDrop[]
  inlineStyleRefusals: InlineStyleModuleRefusal[]
  /** P3-C (OD-8) — the edits a `.map` row sent to its row template. See {@link RowTemplateWrite}. */
  rowTemplateWrites: RowTemplateWrite[]
}

/**
 * The HTML tag an element node renders as, or `undefined` when the module has no
 * tag property. `base.container`'s select uses a sentinel plus a free-text
 * `customTag` for anything outside its built-in list, so the effective name is
 * one of two props — collapsed here so the writeback deals in one value.
 */
function effectiveTag(props: Record<string, unknown> | undefined): string | undefined {
  const tag = props?.tag
  if (typeof tag !== 'string') return undefined
  if (tag !== CUSTOM_HTML_TAG_VALUE) return tag
  const custom = props?.customTag
  return typeof custom === 'string' && custom.length > 0 ? custom : undefined
}

type OriginBackedValue = { key: string; value: string | number; origin: { rel: string; line: number; col: number } }

/**
 * WB-8 (P3-C) — every scalar value on `node` whose code-valued prop the parser
 * traced to a single string literal (`resolvedProps[key].origin`), keyed the
 * way `codeProps` and the baseline key it: a flat prop name, or
 * `callSiteProps:<name>` for an instance's call-site props.
 *
 * The module's text prop is left to the `textOrigin` branch, which owns it
 * (`parsedPageToSitePage` re-keys text's resolution onto that prop with the
 * same origin, and emitting it twice would send the same write twice).
 */
function originBackedValues(node: PageNode, textProp: string | undefined): OriginBackedValue[] {
  const resolved = node.resolvedProps
  if (!resolved) return []
  const out: OriginBackedValue[] = []
  const collect = (key: string, value: unknown): void => {
    if (typeof value !== 'string' && typeof value !== 'number') return
    const origin = resolved[key]?.origin
    if (origin) out.push({ key, value, origin })
  }
  for (const [prop, value] of Object.entries(node.props ?? {})) {
    if (prop === textProp && node.textOrigin) continue
    collect(prop, value)
  }
  if (node.moduleId === 'studio.instance') {
    const callSiteProps = (node.props as { callSiteProps?: Record<string, unknown> }).callSiteProps ?? {}
    for (const [name, value] of Object.entries(callSiteProps)) collect(`callSiteProps:${name}`, value)
  }
  return out
}

/**
 * Walk every node of every DIRTY page (see the `dirtyPages` comment below)
 * and produce the edit batch + baseline-advance lists `saveSite` sends and
 * commits. Pure with respect to the page tree it's handed — no store reads,
 * no network calls; `saveSite` is the only caller and owns everything that
 * happens with the result.
 */
export function collectNodeDiffEdits(
  pages: readonly Page[],
  dirty: SaveSiteOptions['dirty'],
): NodeDiffResult {
  // Every source-backed node's literal props + inline styles, DIFFED against
  // `loadedValues` — an unchanged value must never be re-written, or a
  // resolved expression gets baked into a literal. Synthetic nodes (e.g.
  // `index:body`) are skipped server-side.
  const edits: StudioEditPayload[] = []
  // Parallel to `edits` — one `(nodeId, baseline key, value)` entry per
  // node-value edit pushed below, each tagged with the outcome key of the edit
  // that carries it, so `loadedValues` can be advanced to exactly what this
  // batch wrote once the response names what it refused (WB-35). See
  // `commitNodeValuesBaseline`'s doc for why this is E1's fix.
  const bumps: NodeValueBump[] = []
  // `style-03`'s counterpart: the `(nodeId, key)` pairs this batch REMOVES
  // from source, which have no value to record — see `dropNodeValuesBaseline`.
  const drops: NodeValueDrop[] = []
  // `font-revert` — inline-style drift on a node whose MODULE has no
  // `style=""` target (`pkg.*`, `studio.instance`). Collected rather than
  // dropped, and toasted below: see `inlineStyleUnsavedNotice.ts`.
  const inlineStyleRefusals: InlineStyleModuleRefusal[] = []
  const rowTemplateWrites: RowTemplateWrite[] = []
  /** Push one edit and answer the outcome key its bumps and drops carry. */
  const emit = (edit: StudioEditPayload): string => {
    edits.push(edit)
    return editOutcomeKey(edit)
  }

  /**
   * The node's inline-style drift, written to `targetId` — its own location,
   * or (OD-8) its row template. Answers the edit's outcome key, or `undefined`
   * when there was nothing to write or the module has no `style=""` target.
   */
  const writeInlineStyles = (
    node: PageNode,
    baseline: ReturnType<typeof getLoadedNodeValues>,
    targetId: string,
  ): string | undefined => {
    // Inline style edits (a colour, a shadow, a width dragged off a resize
    // handle) write a `style={{}}` attribute onto the source element.
    // `canWriteInlineStyleForModule` rather than a second inline copy of
    // the rule: it is the one predicate every OFFER has to agree with
    // (`StyleSurface`'s composer, `CanvasResizeHandles`'s handles), and S4
    // is what happens when a copy drifts. See it for which modules qualify.
    const { changed, removed } = diffInlineStyles(node, baseline)
    if (Object.keys(changed).length === 0 && removed.length === 0) return undefined
    if (!canWriteInlineStyleForModule(node.moduleId)) {
      // `font-revert` — this used to be an `if` around the write, so a
      // `pkg.*` / `studio.instance` node's style drift was dropped in
      // SILENCE: the canvas showed it, the save reported success, and the
      // next reload put the old value back. Refused out loud now, at the one
      // chokepoint every write path (single composer, multi composer, canvas
      // handles, agent) already passes through.
      inlineStyleRefusals.push({
        nodeLabel: node.label ?? node.id,
        moduleId: node.moduleId,
        properties: [...Object.keys(changed), ...removed],
      })
      return undefined
    }
    const editKey = emit({
      kind: 'style',
      nodeId: targetId,
      style: changed,
      ...(removed.length > 0 ? { remove: removed } : {}),
    })
    for (const [k, v] of Object.entries(changed)) {
      bumps.push({ nodeId: node.id, key: styleValueKey(k), value: v, editKey })
    }
    for (const property of removed) drops.push({ nodeId: node.id, key: styleValueKey(property), editKey })
    return editKey
  }

  // C4 — this loop used to scan every node of every page on every autosave
  // tick, ignoring `opts.dirty` (fed correctly by every `mutateSite`/
  // `mutateActiveTree` call, see `dirtyTracking.ts`). A page NOT in
  // `dirty.pageIds` produced zero site patches since the last snapshot, so
  // it holds no unshipped edit — skipping its scan is lossless. Absent
  // hints or `dirty.all` fall back to the full scan (`SaveSiteOptions`'s own
  // "Absent -> replace-mode full save" contract). Scope: only THIS loop is
  // filtered — `collectClassIdsDrift`/`commitClassIdsBaseline`/
  // `collectStyleRuleEdits` (both still in `fsCodemodAdapter.ts`) stay
  // unfiltered (cheaper per-node checks, lower risk to touch alongside the
  // 0.6 seam than the payoff is worth).
  const dirtyPages = !dirty || dirty.all ? pages : pages.filter((page) => dirty.pageIds.has(page.id))

  for (const page of dirtyPages) {
    for (const node of Object.values(page.nodes)) {
      // The module's declared inline-text-edit prop (if any) routes that
      // one prop as a `text` edit (rewrites the element's text children)
      // instead of a `prop` edit (rewrites an attribute) — capturing it as
      // an attribute would corrupt the source (e.g. `label="Click me"` on a
      // <Button> whose label is really its text child).
      const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
      const baseline = getLoadedNodeValues(node.id)

      // A resolved text's ORIGIN is a literal in some other file, so this
      // branch does not care whether the node's own id is a writable JSX
      // location — which is what lets a `.map` row be edited individually. Each
      // iteration resolved a DIFFERENT array element, so each carries its own
      // origin and writes only its own string.
      if (textProp !== undefined && node.textOrigin) {
        const value = node.props?.[textProp]
        if (typeof value === 'string' && !(baseline && Object.is(baseline[textProp], value))) {
          const { rel, line, col } = node.textOrigin
          const editKey = emit({ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: value })
          bumps.push({ nodeId: node.id, key: textProp, value, editKey })
        }
      }

      // WB-8 (P3-C) — a code-valued prop the parser traced to ONE string
      // literal (`resolvedProps[k].origin`: a dictionary entry, or the call-site
      // literal a component was handed) is editable, but ONLY at that literal.
      // `isPropWritableToSource` authorises it on exactly this promise; a
      // `kind: 'prop'` write would bake a string over the binding (and
      // `setJsxProp` refuses `binding-overwrite` for it anyway). Like the text
      // branch above, this runs BEFORE the location guard: the origin is not
      // this node's JSX, so a `.map` row whose prop read its own array element
      // writes its own string — it used to pass the store's gate and then be
      // dropped here in silence. An instance's call-site props are the same
      // rule under the `callSiteProps:` key, where a `prop` edit at the call
      // site used to be emitted instead.
      const writtenAtOrigin = new Set<string>()
      for (const { key, value, origin } of originBackedValues(node, textProp)) {
        writtenAtOrigin.add(key)
        if (baseline && Object.is(baseline[key], value)) continue
        const editKey = emit({ kind: 'literal', nodeId: `${origin.rel}:${origin.line}:${origin.col}`, text: String(value) })
        bumps.push({ nodeId: node.id, key, value, editKey })
      }

      // No single source location to write to (a synthetic `index:body` root, a
      // `.map` iteration). Reached only after the two origin branches above,
      // which is why a `.map` row can still have its own copy edited.
      //
      // P3-C (OD-8) — a row's inline STYLE goes to its row template, the one
      // JSX site that renders every row; the caller tells the user it restyled
      // all of them. Nothing else about a row is written there: its literal
      // attributes stay read-only, and its tag is the template's tag.
      if (!hasWritableSourceLocation(node.id)) {
        const templateId = loopTemplateNodeId(node.id)
        if (templateId === null) continue
        const editKey = writeInlineStyles(node, baseline, templateId)
        if (editKey !== undefined) rowTemplateWrites.push({ editKey, nodeId: node.id, templateId, rowCount: rowsOfTemplate(page, templateId) })
        continue
      }

      // The element's own name, not an attribute — see `effectiveTag`. Diffed
      // against the loaded baseline the same way, then routed to the rename
      // codemod instead of the attribute writer.
      // Restricted to `base.*`, whose source element IS the host tag at this
      // location. A design-system component's `tag`, if it has one, is a real
      // prop it forwards — renaming `<Sheet>` is not what the user asked for.
      if (node.moduleId.startsWith('base.')) {
        const tag = effectiveTag(node.props)
        const baselineTag = effectiveTag(baseline)
        if (tag !== undefined && tag !== baselineTag) {
          const editKey = emit({ kind: 'tag', nodeId: node.id, tag })
          // `effectiveTag(baseline)` reads BOTH raw keys — bump both so a
          // later save's `baselineTag` recomputes from what's now on disk,
          // not from the as-loaded pair.
          const rawTag = node.props?.tag
          if (typeof rawTag === 'string') bumps.push({ nodeId: node.id, key: 'tag', value: rawTag, editKey })
          const rawCustomTag = node.props?.customTag
          if (typeof rawCustomTag === 'string') {
            bumps.push({ nodeId: node.id, key: 'customTag', value: rawCustomTag, editKey })
          }
        }
      }

      for (const [prop, value] of Object.entries(node.props ?? {})) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
        // Already emitted as a `tag` edit above; writing either as an attribute
        // would put a junk `tag="section"` on the element and leave it a `<div>`.
        if (prop === 'tag' || prop === 'customTag') continue
        // Only write what the USER actually changed. This is the guard that
        // makes writeback safe on an imported page: a prop whose source is
        // an expression (`svg={checkSvg}`, `label={t.common.needHelp}`)
        // arrives here as the value §7 resolved it to, and re-writing that
        // unchanged value would replace the expression with a baked literal
        // — silently destroying the binding. `setJsxText` refuses that on
        // the text path, but `setJsxProp` will happily do it.
        if (baseline && Object.is(baseline[prop], value)) continue
        // Already emitted as a `literal` edit aimed at its origin, above.
        if (writtenAtOrigin.has(prop)) continue
        // Second gate on the same rule the store applies, here because THIS is
        // the boundary that writes files: `updateNodeProps` refuses a
        // code-valued prop, but a tree can also arrive from an agent or a
        // plugin, and a mis-aimed `setJsxProp` bakes a literal over a binding.
        if (!isPropWritableToSource(node, prop)) continue
        // Already emitted as a `literal` edit aimed at its origin, above.
        if (prop === textProp && node.textOrigin) continue
        const editKey =
          prop === textProp
            ? emit({ kind: 'text', nodeId: node.id, text: String(value) })
            : emit({ kind: 'prop', nodeId: node.id, prop, value })
        bumps.push({ nodeId: node.id, key: prop, value, editKey })
      }

      // instance-ui-01 — a `studio.instance`'s call-site props are a
      // NESTED bag (`props.callSiteProps`), invisible to the flat loop
      // above. Same diff/writability/text-origin discipline, keyed under
      // the `callSiteProps:<name>` convention `parsedPageToSitePage.ts`
      // already uses for `codeProps` — reusing it here (rather than a
      // parallel field) is what lets `isPropWritableToSource` and the
      // server's `callSiteProps:` prefix strip (`applyStudioEdit`'s
      // `'prop'` case) work completely unchanged.
      if (node.moduleId === 'studio.instance') {
        const callSiteProps = (node.props as { callSiteProps?: Record<string, unknown> }).callSiteProps ?? {}
        for (const [name, value] of Object.entries(callSiteProps)) {
          if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
          const codeKey = `callSiteProps:${name}`
          if (baseline && Object.is(baseline[codeKey], value)) continue
          if (writtenAtOrigin.has(codeKey)) continue
          if (!isPropWritableToSource(node, codeKey)) continue
          const editKey = emit({ kind: 'prop', nodeId: node.id, prop: codeKey, value })
          bumps.push({ nodeId: node.id, key: codeKey, value, editKey })
        }
      }

      writeInlineStyles(node, baseline, node.id)
    }
  }

  return { edits, bumps, drops, inlineStyleRefusals, rowTemplateWrites }
}
