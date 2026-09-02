/**
 * unexplainedSkipsNotice — the rendering half of
 * `STUDIO-FIGMA-PARITY-PLAN.md` item 0.7.
 *
 * The problem: `fsCodemodAdapter.ts`'s `unexplainedSkips` toast
 * ("N edit(s) had no writable location in the code…") never named which
 * node(s) were affected — a bare count, batched, no selection jump. This
 * module is the piece that CAN name them: given the server's
 * `unexplainedSkips: { nodeId, kind }[]` (added to `StudioEditBatchResult` /
 * `StudioSaveResponseSchema` in this same change — see
 * `server/handlers/studioWriteback.ts` and `studioSaveRequests.ts`), it
 * resolves each id to a display name via the CURRENT page tree and renders
 * one toast that:
 *   - names up to 3 affected nodes by their real label, with a "+N more" tail
 *   - offers a "Select" action that jumps the canvas/Properties panel
 *     straight to the first affected node (switching page if needed) — real,
 *     not just described
 *
 * Why this file exists separately from `fsCodemodAdapter.ts` rather than
 * being inlined at its call site: `fsCodemodAdapter.ts` is store-engineer
 * owned this wave (Phase 0 dispatch). This module is fully self-contained
 * and ready to call from there — the only change still needed in that file
 * is swapping its current `pushToast({...})` call for
 * `notifyUnexplainedSkips(result.unexplainedSkips ?? [])`, See STATE.md /
 * the panel-designer handoff for the exact before/after.
 */
import { useEditorStore } from '@site/store/store'
import { getNodeDisplayName } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { pushToast } from '@ui/components/Toast'

export interface UnexplainedSkipDetail {
  nodeId: string
  /** `StudioEdit['kind']` on the server — kept as a bare string here so this module doesn't need the server's edit-kind union. */
  kind: string
}

interface ResolvedSkip {
  nodeId: string
  pageId: string
  label: string
}

/** Find which page (if any) currently holds `nodeId`, and its display name. Returns `null` for an id the loaded tree doesn't contain — e.g. a node deleted in the same session before this save's response came back, or a synthetic `css`-edit nodeId with no page-tree entry at all. */
function resolveSkippedNode(nodeId: string): ResolvedSkip | null {
  const site = useEditorStore.getState().site
  if (!site) return null
  for (const page of site.pages) {
    const node = page.nodes[nodeId]
    if (!node) continue
    return {
      nodeId,
      pageId: page.id,
      label: getNodeDisplayName(node, registry.get(node.moduleId), site.visualComponents),
    }
  }
  return null
}

const MAX_NAMED = 3

/**
 * Select every resolved skip that lives on `targets[0]`'s page (switching to
 * it first if needed), so a same-page batch really does land as a real
 * multi-selection — not just the first node under an overpromising label.
 * A skip on a DIFFERENT page is left unselected; there is no single-gesture
 * "select across pages" in this store, and silently dropping it from the
 * selection is honest where claiming to select it would not be.
 */
function selectSkippedNodes(targets: readonly ResolvedSkip[]): void {
  const [first, ...rest] = targets
  if (!first) return
  const state = useEditorStore.getState()
  if (state.activePageId !== first.pageId) state.setActivePage(first.pageId)
  const samePageIds = [first.nodeId, ...rest.filter((r) => r.pageId === first.pageId).map((r) => r.nodeId)]
  if (samePageIds.length > 1) useEditorStore.getState().selectMany(samePageIds)
  else useEditorStore.getState().selectNode(first.nodeId)
}

/**
 * Toast the batch's unwritable-location skips, naming what the old aggregate
 * count couldn't. No-ops for an empty list (mirrors every other refusal
 * toast in this codebase, which only fires when there's something to say).
 */
export function notifyUnexplainedSkips(skips: readonly UnexplainedSkipDetail[]): void {
  if (skips.length === 0) return

  const resolved = skips
    .map((skip) => resolveSkippedNode(skip.nodeId))
    .filter((r): r is ResolvedSkip => r !== null)
  const unresolvedCount = skips.length - resolved.length

  const named = resolved.slice(0, MAX_NAMED).map((r) => r.label)
  const remaining = resolved.length - named.length
  const nameList =
    named.length === 0
      ? null
      : remaining > 0
        ? `${named.join(', ')}, and ${remaining} more`
        : named.join(', ')

  const bodyParts = [
    nameList ? `${nameList} — no writable location in the code.` : null,
    unresolvedCount > 0
      ? `${unresolvedCount} more edit${unresolvedCount === 1 ? '' : 's'} had no writable location.`
      : null,
    'Text that comes from a prop or a variable cannot be edited on the canvas yet — edit it where the value is defined.',
  ].filter((part): part is string => part !== null)

  const first = resolved[0]
  const selectableCount =
    first === undefined ? 0 : 1 + resolved.slice(1).filter((r) => r.pageId === first.pageId).length
  pushToast({
    kind: 'error',
    title: 'Some changes were not saved to source',
    body: bodyParts.join(' '),
    action:
      first !== undefined
        ? {
            label: selectableCount === 1 ? 'Select node' : `Select ${selectableCount} nodes`,
            onSelect: () => selectSkippedNodes(resolved),
          }
        : undefined,
  })
}
