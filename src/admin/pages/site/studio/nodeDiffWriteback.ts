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
  canWriteInlineStyleForModule,
  hasWritableSourceLocation,
  isPropWritableToSource,
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

export interface NodeDiffResult {
  edits: StudioEditPayload[]
  bumps: NodeValueBump[]
  drops: NodeValueDrop[]
  inlineStyleRefusals: InlineStyleModuleRefusal[]
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
  // node-value edit pushed below, so `loadedValues` can be advanced to
  // exactly what this batch wrote once the POST confirms it landed. See
  // `commitNodeValuesBaseline`'s doc for why this is E1's fix and why it is
  // gated on `unexplainedSkips === 0` below rather than committed
  // unconditionally.
  const bumps: NodeValueBump[] = []
  // `style-03`'s counterpart: the `(nodeId, key)` pairs this batch REMOVES
  // from source, which have no value to record — see `dropNodeValuesBaseline`.
  const drops: NodeValueDrop[] = []
  // `font-revert` — inline-style drift on a node whose MODULE has no
  // `style=""` target (`pkg.*`, `studio.instance`). Collected rather than
  // dropped, and toasted below: see `inlineStyleUnsavedNotice.ts`.
  const inlineStyleRefusals: InlineStyleModuleRefusal[] = []

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
          edits.push({ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: value })
          bumps.push({ nodeId: node.id, key: textProp, value })
        }
      }

      // No single source location to write to (a synthetic `index:body` root, a
      // `.map` iteration). Reached only after the text-origin branch above,
      // which is why a `.map` row can still have its own copy edited.
      if (!hasWritableSourceLocation(node.id)) continue

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
          edits.push({ kind: 'tag', nodeId: node.id, tag })
          // `effectiveTag(baseline)` reads BOTH raw keys — bump both so a
          // later save's `baselineTag` recomputes from what's now on disk,
          // not from the as-loaded pair.
          const rawTag = node.props?.tag
          if (typeof rawTag === 'string') bumps.push({ nodeId: node.id, key: 'tag', value: rawTag })
          const rawCustomTag = node.props?.customTag
          if (typeof rawCustomTag === 'string') bumps.push({ nodeId: node.id, key: 'customTag', value: rawCustomTag })
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
        // A code-valued prop the evaluator traced to a real literal
        // (`title={t.home.skipTheTaxiQueue}` -> `skipTheTaxiQueue: '…'` in
        // `i18n/translations.ts`) is editable — but ONLY at that literal.
        // `isPropWritableToSource` authorises it on exactly this promise;
        // falling through to the `kind: 'prop'` write below would bake a
        // string over the binding, which is the thing the whole rule exists
        // to prevent. Same shape as the `textOrigin` branch above.
        const propOrigin = node.resolvedProps?.[prop]?.origin
        if (propOrigin) {
          edits.push({
            kind: 'literal',
            nodeId: `${propOrigin.rel}:${propOrigin.line}:${propOrigin.col}`,
            text: String(value),
          })
          bumps.push({ nodeId: node.id, key: prop, value })
          continue
        }
        // Second gate on the same rule the store applies, here because THIS is
        // the boundary that writes files: `updateNodeProps` refuses a
        // code-valued prop, but a tree can also arrive from an agent or a
        // plugin, and a mis-aimed `setJsxProp` bakes a literal over a binding.
        if (!isPropWritableToSource(node, prop)) continue
        // Already emitted as a `literal` edit aimed at its origin, above.
        if (prop === textProp && node.textOrigin) continue
        if (prop === textProp) {
          edits.push({ kind: 'text', nodeId: node.id, text: String(value) })
        } else {
          edits.push({ kind: 'prop', nodeId: node.id, prop, value })
        }
        bumps.push({ nodeId: node.id, key: prop, value })
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
          if (!isPropWritableToSource(node, codeKey)) continue
          edits.push({ kind: 'prop', nodeId: node.id, prop: codeKey, value })
          bumps.push({ nodeId: node.id, key: codeKey, value })
        }
      }

      // Inline style edits (a colour, a shadow, a width dragged off a resize
      // handle) write a `style={{}}` attribute onto the source element.
      // `canWriteInlineStyleForModule` rather than a second inline copy of
      // the rule: it is the one predicate every OFFER has to agree with
      // (`StyleSurface`'s composer, `CanvasResizeHandles`'s handles), and S4
      // is what happens when a copy drifts. See it for which modules qualify.
      const { changed, removed } = diffInlineStyles(node, baseline)
      if (Object.keys(changed).length > 0 || removed.length > 0) {
        if (canWriteInlineStyleForModule(node.moduleId)) {
          edits.push({
            kind: 'style',
            nodeId: node.id,
            style: changed,
            ...(removed.length > 0 ? { remove: removed } : {}),
          })
          for (const [k, v] of Object.entries(changed)) bumps.push({ nodeId: node.id, key: styleValueKey(k), value: v })
          for (const property of removed) drops.push({ nodeId: node.id, key: styleValueKey(property) })
        } else {
          // `font-revert` — this used to be an `if` around the block above,
          // so a `pkg.*` / `studio.instance` node's style drift was dropped
          // in SILENCE: the canvas showed it, the save reported success, and
          // the next reload put the old value back. Refused out loud now,
          // at the one chokepoint every write path (single composer, multi
          // composer, canvas handles, agent) already passes through.
          inlineStyleRefusals.push({
            nodeLabel: node.label ?? node.id,
            moduleId: node.moduleId,
            properties: [...Object.keys(changed), ...removed],
          })
        }
      }
    }
  }

  return { edits, bumps, drops, inlineStyleRefusals }
}
