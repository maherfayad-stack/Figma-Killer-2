/**
 * AlignSection — Penpot's Align row: the second unlabeled content row of
 * the Design tab, right below Layer (`STATE.md` `panel-25`, item 2 of the
 * P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3).
 *
 * ## What P0 actually showed
 *
 * There is no `02-measurements.md` table for this row — none of the four
 * baseline fixtures happened to need it — so this section is built directly
 * off the raw screenshots instead (per this work order's own instruction to
 * re-check the fixture screenshot, not just the summary table, before
 * writing a section). Two real, confirmed facts from
 * `docs/audits/penpot-inspector-baseline/screenshots/`:
 *
 *   - `f1-rectangle/dark/design.png` (a bare rectangle, no layout parent):
 *     the row directly below the tab strip is the BOOLEAN-OPERATIONS icon
 *     group (union/subtract/intersect/exclude/flatten) — there is NO align
 *     row at all.
 *   - `f3-flexboard/dark/design-child.png` (a rectangle that IS a flex
 *     child): the align row (6 edge buttons, matching this repo's own
 *     `AlignBar`) appears ABOVE the boolean-ops row, as the panel's very
 *     first content row.
 *
 * Penpot's align row is therefore not a permanently-resident, sometimes-
 * disabled control — it doesn't exist in the DOM at all unless the
 * selection has a flex/grid parent to align within. This section reproduces
 * that exactly: it renders `null` whenever EVERY edge's `resolveAlignWrite`
 * comes back `unavailable` (no parent, no live frame, or a non-flex/grid
 * parent), matching rule 2's "nothing rendered that lies" instead of
 * `SingleNodeAlignRow`'s old behavior of showing all six buttons disabled
 * with a reason tooltip. A PARTIAL disable (e.g. a flex parent's main axis
 * refusing because of siblings, while the cross axis stays honest) still
 * renders normally — only the "nothing here would ever work" case hides
 * the row.
 *
 * ## What this claims
 *
 * `alignSelf`/`justifySelf` on the SELECTED node (`resolveAlignWrite`'s
 * `self` target) and, when this node is its flex parent's only child, the
 * PARENT's `justifyContent` (`resolveAlignWrite`'s `parent` target) — see
 * that module's own doc for the full honesty rule. The parent write is
 * always the parent's own inline `style=""`, never one of its (possibly
 * shared) classes — ported unchanged from `SingleNodeAlignRow.tsx`'s own
 * rationale: a class write here would have an unbounded blast radius, the
 * parent's inline style is a single, real, per-node location nothing else
 * is affected by. Because that write targets a DIFFERENT node than the one
 * `useSelectionModel()`/`useInspectorCommit()` are scoped to, it goes
 * through `setNodeInlineStyles` directly rather than `commit.commitStyle` —
 * the same posture `LayerSection.tsx` already established for
 * `setNodesHidden`/`setNodesLocked` (store actions outside the single-node
 * style-commit contract are read directly, not routed through a model built
 * for the SELECTED node's own bag).
 *
 * `alignSelf`/`justifySelf` had a second, pre-existing live UI at the time
 * this section landed: the old `LayoutSection/LayoutSettingsButton.tsx`'s
 * "always shown" advanced-settings popover exposed the same two properties
 * for fine control, and `classStyleSections.ts`'s `layout` claim covered
 * them too — an intentional, pre-existing dual-path this migration did not
 * introduce (quick align-bar shortcut vs. advanced settings drawer).
 * **P3 item 4 (`STATE.md` `panel-25`, the new `inspector/sections/
 * LayoutSection.tsx`) later closed that dual-path**: `LayoutSettingsButton`
 * dropped its own `alignSelf`/`justifySelf` rows once Layout's own
 * migration made the "two components racing to write the same property"
 * hazard real for the first time (Align and the new Layout section would
 * otherwise both be live `INSPECTOR_SECTIONS` entries), and `alignSelf`/
 * `justifySelf` moved into `classStyleSections.ts`'s `MIGRATED_SECTION_PROPERTIES`
 * export, credited to Align. This section's own claim on them is therefore
 * now exclusive.
 *
 * ## Locked (code-valued) properties
 *
 * `alignSelf`/`justifySelf` set from an expression in code are refused by
 * `commitApi.ts`'s own `lockedPropertySet` gate already. This section also
 * disables the SPECIFIC edge button client-side (via `AlignBar`'s existing
 * `alignDisabledReasons`) with a lock reason, the same per-field (never
 * per-row) posture `LayerSection.tsx` established.
 */
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { getParent, styleValueKey, type CSSPropertyBag } from '@core/page-tree'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { AlignBar, type AlignEdge } from '@ui/components/AlignBar'
import { ALL_ALIGN_EDGES, resolveAlignWrite, type ParentLayoutInfo } from './resolveAlignWrite'
import styles from './AlignSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

export function AlignSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const page = useEditorStore(selectActiveCanvasPage)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)

  const { selectedNodeId, selectedNode } = model

  // Hooks run unconditionally before the early-return, same order every
  // render — `parentNode`/`parentComputed` are `undefined`/`null` pre-
  // selection, which `resolveAlignWrite` already treats as "unavailable".
  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined
  const { value: parentComputed } = useFrameComputedStyleValues(parentNode?.id ?? null, activeBreakpointId, [
    'display',
    'flexDirection',
  ])

  if (!selectedNodeId || !selectedNode) return null

  const parentLayout: ParentLayoutInfo | null =
    parentNode && parentComputed
      ? {
          display: parentComputed.display,
          flexDirection: parentComputed.flexDirection || 'row',
          siblingCount: parentNode.children.length,
        }
      : null

  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  const resolutions = ALL_ALIGN_EDGES.map((edge) => ({ edge, resolution: resolveAlignWrite(edge, parentLayout) }))

  // Penpot's own confirmed behavior (see this file's doc): the row doesn't
  // exist in the DOM at all when nothing on it could ever write anything —
  // not a fully-disabled row.
  const everyEdgeUnavailable = resolutions.every(({ resolution }) => resolution.target === 'unavailable')
  if (everyEdgeUnavailable) return null

  const alignDisabledReasons: Partial<Record<AlignEdge, string>> = {}
  for (const { edge, resolution } of resolutions) {
    if (resolution.target === 'unavailable') {
      alignDisabledReasons[edge] = resolution.reason
    } else if (resolution.target === 'self' && lockedProperties.has(resolution.property)) {
      alignDisabledReasons[edge] = `${resolution.property} is set from an expression in code`
    }
  }

  function handleAlign(edge: AlignEdge) {
    const resolution = resolveAlignWrite(edge, parentLayout)
    if (resolution.target === 'unavailable') return
    if (resolution.target === 'self') {
      if (lockedProperties.has(resolution.property)) return
      commit.commitStyle(resolution.property as keyof CSSPropertyBag, resolution.value)
      return
    }
    if (parentNode) {
      setNodeInlineStyles(parentNode.id, { [resolution.property]: resolution.value })
    }
  }

  return (
    <div className={styles.alignRow} data-testid="inspector-align-row">
      <AlignBar count={1} minAlign={0} onAlign={handleAlign} alignDisabledReasons={alignDisabledReasons} />
    </div>
  )
}
