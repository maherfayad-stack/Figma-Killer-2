/**
 * canvasFrameSelection (PA-6) — the gesture behind Frame selection (⌥⌘G, or
 * Ctrl+Alt+G on Windows): measure the selected layers and their container
 * once, plan the frame (`canvasFrameSelectionPlan.ts`), and hand the store ONE
 * `groupNodes` write that carries it — so the frame, its size, and every
 * member's rebased offsets are one source write and one undo.
 *
 * Kept apart from the pure plan because it is the part that reads the canvas
 * (through the frame adapters, so a live bridge frame answers the same
 * question a portal frame does) and speaks to the user.
 */
import { getParent } from '@core/page-tree'
import { establishesContainingBlock } from '@core/studio-runtime'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { FrameRequest } from '@site/store/slices/site/frameRequest'
import { authoredOffsetValues, OWN_PROPERTIES, readOwn, type NudgeOffsetProperty } from './canvasNodeArrowMove'
import { planFrameSelection, type FrameMemberFacts, type FrameParentFacts } from './canvasFrameSelectionPlan'
import { measureInRenderingFrame } from './canvasSelectionMeasure'
import type { NodeMeasurement } from './frameAdapter/FrameDocumentAdapter'

const PARENT_PROPERTIES = [
  'position', 'transform', 'perspective', 'filter', 'contain', 'will-change', 'direction',
  'display', 'flex-direction', 'flex-wrap', 'column-gap', 'row-gap', 'align-items', 'justify-content',
  'border-left-width', 'border-top-width', 'border-right-width', 'border-bottom-width',
]
const MEMBER_PROPERTIES = [...OWN_PROPERTIES, 'flex-grow']

const TITLE = 'Frame selection'

/** A plain length: `12`, `12px`, `-3.5px`. Anything else (`50%`, `calc()`, `var()`) is an expression. */
const PLAIN_LENGTH = /^-?\d+(\.\d+)?(px)?$/

const px = (value: string | undefined) => {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function parentFacts(measurement: NodeMeasurement | undefined): FrameParentFacts {
  const style = measurement?.computedStyle ?? {}
  const rect = measurement?.rect
  return {
    box: {
      rect: { left: rect?.x ?? 0, top: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 },
      borderLeft: px(style['border-left-width']),
      borderTop: px(style['border-top-width']),
      borderRight: px(style['border-right-width']),
      borderBottom: px(style['border-bottom-width']),
      scale: 1,
      // The adapters do not report scroll; a frame grows to its content, so a container
      // that scrolls its own content is the rare case this does not see.
      scrollLeft: 0,
      scrollTop: 0,
    },
    containsAbsolute:
      rect != null &&
      establishesContainingBlock({
        position: style.position ?? 'static',
        transform: style.transform ?? 'none',
        perspective: style.perspective ?? 'none',
        filter: style.filter ?? 'none',
        contain: style.contain ?? 'none',
        willChange: style['will-change'] ?? 'auto',
      }),
    direction: style.direction ?? 'ltr',
    display: style.display ?? '',
    flexDirection: style['flex-direction'] ?? '',
    flexWrap: style['flex-wrap'] ?? '',
    columnGap: style['column-gap'] ?? '',
    rowGap: style['row-gap'] ?? '',
    alignItems: style['align-items'] ?? '',
    justifyContent: style['justify-content'] ?? '',
  }
}

function refuseGesture(body: string): void {
  pushToast({ kind: 'warning', title: TITLE, body, location: 'site-editor' })
}

/** ⌥⌘G: put the selected layers in a frame sized to their bounds, each keeping its place. */
export async function frameSelection(nodeIds?: readonly string[]): Promise<void> {
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  if (!tree) return
  const selected = (nodeIds ?? store.selectedNodeIds).filter((id) => id !== tree.rootNodeId && tree.nodes[id])
  if (selected.length === 0) return

  const parent = getParent(tree, selected[0]!)
  if (!parent || selected.some((id) => getParent(tree, id)?.id !== parent.id)) {
    refuseGesture('These layers sit in different containers. Select layers that share one container, side by side.')
    return
  }
  // Source order: the order the container lists them in.
  const ordered = [...selected].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b))

  const byId = await measureInRenderingFrame([...ordered, parent.id], [...new Set([...MEMBER_PROPERTIES, ...PARENT_PROPERTIES])], store.activeBreakpointId, ordered)
  if (!byId) {
    refuseGesture('Studio cannot measure these layers right now. Switch the board to the editable canvas, or wait for the frame to load.')
    return
  }

  const members: FrameMemberFacts[] = []
  for (const nodeId of ordered) {
    const measurement = byId.get(nodeId)
    const node = tree.nodes[nodeId]
    if (!measurement?.rect || !node || measurement.computedStyle.display === 'contents') {
      refuseGesture('One of these layers draws no box of its own (a component call or a fragment), so there is nothing to size a frame around. Frame the elements inside it instead.')
      return
    }
    const values = authoredOffsetValues(node, store.site?.styleRules)
    members.push({
      nodeId,
      rect: { left: measurement.rect.x, top: measurement.rect.y, width: measurement.rect.width, height: measurement.rect.height },
      style: readOwn(measurement),
      flexGrow: measurement.computedStyle['flex-grow'] ?? '0',
      authored: new Set(values.keys()),
      expressive: new Set<NudgeOffsetProperty>(
        [...values].filter(([, value]) => !PLAIN_LENGTH.test(String(value).trim())).map(([property]) => property),
      ),
    })
  }

  const plan = planFrameSelection(members, parentFacts(byId.get(parent.id)))
  if (!plan.ok) {
    refuseGesture(plan.message)
    return
  }
  const frame: FrameRequest = {
    wrapperStyle: plan.wrapperStyle,
    memberStyles: Object.fromEntries(ordered.map((nodeId, index) => [nodeId, plan.memberStyles[index] ?? {}])),
  }
  const wrapperId = useEditorStore.getState().groupNodes(ordered, undefined, undefined, frame)
  // A CMS tree mints the frame at once: select it. A source write selects it when it lands.
  if (typeof wrapperId === 'string' && wrapperId) useEditorStore.getState().selectNode(wrapperId)
}
