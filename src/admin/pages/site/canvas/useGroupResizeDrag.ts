/**
 * useGroupResizeDrag — the pointer half of resizing a MULTI-selection as one
 * box (P5-F, IX-6g), on handles portalled into the frame like the single
 * element's (`useElementResizeDrag` — read its docblock for why the listeners
 * are native and why there is no zoom division here; both apply unchanged).
 *
 * The geometry is `groupResize.ts`: the union box resizes by the single
 * element rules, every member scales with it, and each member's write is the
 * single-element pipeline's own — box-sizing (IX-6a), Fixed companions
 * (IX-6b), authored anchors (IX-21) — so a group resize can never write CSS a
 * one-layer resize to the same size would not. The pointer, key and lifetime
 * plumbing (⇧ / ⌥ live, Escape, ERR-12, one write per frame, the gesture
 * freeze) is `resizeHandleDragSession.ts`, shared with the single drag.
 *
 * ## One write
 *
 * Every member's preview is on its own element, at frame rate. On release
 * the previews are restored and ONE `setNodesInlineStylesPerNode` writes
 * every member's patch: one undo entry, one save.
 *
 * ## Not (yet) here
 *
 * The group's moving edge does not snap (a single element's does, IX-6e),
 * and a double-click on a group handle does nothing beyond staying on the
 * handle. Both are follow-ups named in the P5-F handoff.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  readResizeBoxStart,
  RESIZE_HANDLE_ATTR,
  RESIZE_SIZE_BADGE_ATTR,
  writeSizeBadge,
  type ResizeBoxStart,
  type ResizeHandle,
} from '@core/studio-runtime'
import { presentedElementForNode } from './canvasNodeLookup'
import { findNodeById } from './InPlaceInspector/findNodeById'
import {
  createInlineStylePreview,
  planResizeSizing,
  resizeInlinePatch,
  type InlineStylePreview,
  type ResizeInlinePatch,
  type ResizeSizingPlan,
} from './elementResizeSizing'
import { anchorResizePatch } from './elementResizeAnchoring'
import { authoredOffsets, planNudge, type NudgePlan } from './canvasNodeArrowMove'
import { groupUnionRect, memberResizeStep, resizeGroupBox, type GroupResizeMember } from './groupResize'
import type { SnapRect } from './boardSnapping'
import { startResizeHandleDrag } from './resizeHandleDragSession'

/** A node with no `style={{…}}` of its own — stable, so no fallback object is built per press. */
const NO_INLINE_STYLES: Readonly<Record<string, unknown>> = {}

interface GroupResizeDragOptions {
  /** The handle container portalled into the iframe overlay root, or `null`. */
  frame: HTMLElement | null
  /** The iframe document the selected elements live in. */
  iframeDoc: Document | null
  /**
   * The selected node ids, joined with a space — a string, so the effect
   * re-arms when the SELECTION changes rather than when an array identity does.
   */
  nodeIdsKey: string
}

/** Everything one member needs for the length of a drag, read once at pointerdown. */
interface MemberSession extends GroupResizeMember {
  plan: ResizeSizingPlan
  anchors: NudgePlan | null
  preview: InlineStylePreview
}

function memberPatch(member: MemberSession, union: SnapRect, next: SnapRect): ResizeInlinePatch | null {
  const step = memberResizeStep(member, union, next)
  return anchorResizePatch(resizeInlinePatch(member.start, step, member.plan), member.start, step, member.anchors)
}

export function useGroupResizeDrag({ frame, iframeDoc, nodeIdsKey }: GroupResizeDragOptions): void {
  useEffect(() => {
    const view = iframeDoc?.defaultView
    const nodeIds = nodeIdsKey.split(' ').filter(Boolean)
    if (!frame || !iframeDoc || !view || nodeIds.length < 2) return

    const cleanups: Array<() => void> = []
    let cancelActive: (() => void) | null = null

    // The handles sit inside the page's body: without this, the click that
    // ends a drag would bubble into the body's click-to-select and select
    // the PAGE (the same guard the single drag has).
    const swallowHandleClick = (event: MouseEvent) => {
      if (!frame.contains(event.target as Node | null)) return
      event.preventDefault()
      event.stopPropagation()
    }
    iframeDoc.addEventListener('click', swallowHandleClick, true)
    iframeDoc.addEventListener('dblclick', swallowHandleClick, true)
    cleanups.push(() => {
      iframeDoc.removeEventListener('click', swallowHandleClick, true)
      iframeDoc.removeEventListener('dblclick', swallowHandleClick, true)
    })

    for (const handleEl of frame.querySelectorAll<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`)) {
      const handle = handleEl.getAttribute(RESIZE_HANDLE_ATTR) as ResizeHandle | null
      if (!handle) continue

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()

        // Every member resolved per press, like the single drag: a write
        // re-renders the page, and an element captured before it may no
        // longer be the one on screen. One member gone = no gesture.
        const state = useEditorStore.getState()
        const members: MemberSession[] = []
        for (const nodeId of nodeIds) {
          const element = presentedElementForNode(iframeDoc, nodeId)
          if (!element) return
          const start: ResizeBoxStart = readResizeBoxStart(view, element)
          const box = element.getBoundingClientRect()
          const node = findNodeById(state, nodeId)
          members.push({
            nodeId,
            rect: { x: box.left, y: box.top, width: box.width, height: box.height },
            start,
            plan: planResizeSizing(view, element, start, node?.inlineStyles ?? NO_INLINE_STYLES),
            anchors: start.offsets && node
              ? planNudge(view.getComputedStyle(element), authoredOffsets(node, state.site?.styleRules))
              : null,
            preview: createInlineStylePreview(element),
          })
        }
        const union = groupUnionRect(members.map((member) => member.rect))
        let next = union

        const badge = frame.querySelector<HTMLElement>(`[${RESIZE_SIZE_BADGE_ATTR}]`)
        if (badge) writeSizeBadge(badge, union.width, union.height)

        cancelActive = startResizeHandleDrag({
          event,
          handleEl,
          frame,
          iframeDoc,
          scaleTool: state.canvasTool === 'scale',
          callbacks: {
            step: (dx, dy, modifiers) => {
              next = resizeGroupBox(handle, union, dx, dy, modifiers)
            },
            paint: () => {
              for (const member of members) member.preview.apply(memberPatch(member, union, next) ?? {})
            },
            end: (commit) => {
              cancelActive = null
              // Restore every preview BEFORE the commit — the preview-then-
              // commit contract `useElementResizeDrag` documents.
              for (const member of members) member.preview.clear()
              if (!commit) return
              const patches = members.flatMap((member) => {
                const patch = memberPatch(member, union, next)
                return patch
                  ? [{
                      nodeId: member.nodeId,
                      patch: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null])),
                    }]
                  : []
              })
              if (patches.length > 0) useEditorStore.getState().setNodesInlineStylesPerNode(patches)
            },
          },
        })
      }

      handleEl.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => handleEl.removeEventListener('pointerdown', onPointerDown))
    }

    return () => {
      cancelActive?.()
      for (const cleanup of cleanups) cleanup()
    }
  }, [frame, iframeDoc, nodeIdsKey])
}
