/**
 * useSpacingHandleDrag — the pointer half of the padding / gap handles
 * (P5-E, IX-17), wired imperatively onto bands that live INSIDE the frame's
 * iframe (the same reason `useElementResizeDrag` gives: React does not
 * delegate from a portal into a second document).
 *
 * ## Preview, then ONE commit through the inspector's write target
 *
 * Every move writes the patch straight onto the element's own `style` (at
 * most once per animation frame), so the padding tracks the pointer and the
 * ring follows for free. On release the real edit is ONE `commitStyleMany`
 * through the inspector's own commit API (`runSelectionStyleCommand`): the
 * inline style, or the one class that already sets the property — exactly
 * where the Layout section's padding field would have written it, so the two
 * surfaces can never disagree (the audit's IX-17 requirement). One undo
 * entry, one source write.
 *
 * The preview is cleared INSIDE that command, immediately before the commit —
 * the command runs in a layout effect, so the cleared preview and the
 * committed value reach the screen in the same paint. `canvasGesture` is held
 * until then, so the ring's parent-document anchor and the frame's auto
 * height do not chase the drag (the resize drag's rule).
 *
 * ⇧ and ⌥ are read on every move and every modifier key change (claimed, so
 * ⌥ does not also open the Alt-hover ladder). Escape and a window blur
 * cancel: the preview is restored and nothing is written.
 */
import { useEffect, useEffectEvent } from 'react'
import { guardDragSession } from '@core/studio-runtime'
import { beginCanvasGesture, endCanvasGesture } from './canvasGesture'
import { presentedElementForNode } from './canvasNodeLookup'
import { createInlineStylePreview } from './elementResizeSizing'
import { runSelectionStyleCommand } from './selectionStyleCommands'
import { spacingPatch, type SpacingBand, type SpacingGeometry, type SpacingModifiers } from './spacingHandleRules'

/** The attribute each band carries: its index in the band list. */
export const SPACING_BAND_ATTR = 'data-canvas-spacing-band'

interface SpacingHandleDragOptions {
  /** The band layer portalled into the iframe overlay, or `null`. */
  layer: HTMLElement | null
  iframeDoc: Document | null
  nodeId: string
  /** The bands and the geometry they came from — read at pointerdown. */
  readBands: () => { bands: readonly SpacingBand[]; geometry: SpacingGeometry } | null
  /** Live feedback while dragging: the band, and the patch being previewed (`null` when the drag ends). */
  onDragChange: (drag: { band: SpacingBand; patch: Record<string, string> } | null) => void
}

function modifiersOf(event: { shiftKey: boolean; altKey: boolean }): SpacingModifiers {
  return { axisPair: event.shiftKey, allSides: event.altKey }
}

export function useSpacingHandleDrag({ layer, iframeDoc, nodeId, readBands, onDragChange }: SpacingHandleDragOptions): void {
  // Latest-closure reads, NOT effect dependencies: the drag reports progress
  // through `onDragChange`, which re-renders the owner, and a re-attached
  // listener would cancel the drag in flight.
  const readLatestBands = useEffectEvent(() => readBands())
  const reportDrag = useEffectEvent((drag: { band: SpacingBand; patch: Record<string, string> } | null) => onDragChange(drag))

  useEffect(() => {
    if (!layer || !iframeDoc) return
    let cancelActive: (() => void) | null = null

    // The click that ends a drag lands on a band inside the page's body, and
    // would select the page (the resize handles' finding).
    const swallowBandClick = (event: MouseEvent) => {
      if (!layer.contains(event.target as Node | null)) return
      event.preventDefault()
      event.stopPropagation()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const bandEl = (event.target as Element | null)?.closest?.(`[${SPACING_BAND_ATTR}]`)
      if (!bandEl || !layer.contains(bandEl)) return
      const read = readLatestBands()
      const band = read?.bands[Number(bandEl.getAttribute(SPACING_BAND_ATTR))]
      const target = presentedElementForNode(iframeDoc, nodeId)
      if (!read || !band || !target) return
      event.preventDefault()
      event.stopPropagation()

      const { geometry } = read
      const preview = createInlineStylePreview(target)
      const startX = event.clientX
      const startY = event.clientY
      let pointer = { x: startX, y: startY }
      let modifiers = modifiersOf(event)
      let patch = spacingPatch(band, geometry, 0, 0, modifiers)
      let moved = false
      const gesture = beginCanvasGesture()
      try {
        ;(bandEl as HTMLElement).setPointerCapture(event.pointerId)
      } catch (_err) {
        // The document listeners below still drive the drag.
      }

      let pendingFrame: number | null = null
      const applyPending = () => {
        pendingFrame = null
        preview.apply(patch)
        reportDrag({ band, patch })
      }
      const step = () => {
        patch = spacingPatch(band, geometry, pointer.x - startX, pointer.y - startY, modifiers)
        pendingFrame ??= requestAnimationFrame(applyPending)
      }
      const onMove = (moveEvent: PointerEvent) => {
        pointer = { x: moveEvent.clientX, y: moveEvent.clientY }
        if (Math.hypot(pointer.x - startX, pointer.y - startY) >= 1) moved = true
        modifiers = modifiersOf(moveEvent)
        step()
      }

      // Keys go to whichever document holds focus, so both are heard, in the
      // capture phase, and what this drag uses is claimed.
      const keyDocuments = [iframeDoc, document]
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.type === 'keydown' && keyEvent.key === 'Escape') {
          keyEvent.preventDefault()
          keyEvent.stopPropagation()
          finish(false)
          return
        }
        if (keyEvent.key !== 'Shift' && keyEvent.key !== 'Alt') return
        keyEvent.stopPropagation()
        if (keyEvent.key === 'Alt') keyEvent.preventDefault()
        modifiers = modifiersOf(keyEvent)
        step()
      }

      const finish = (commit: boolean) => {
        cancelActive = null
        disposeGuard()
        if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
        iframeDoc.removeEventListener('pointermove', onMove)
        iframeDoc.removeEventListener('pointerup', onUp)
        iframeDoc.removeEventListener('pointercancel', onCancel)
        for (const doc of keyDocuments) {
          doc.removeEventListener('keydown', onKey, true)
          doc.removeEventListener('keyup', onKey, true)
        }
        try {
          ;(bandEl as HTMLElement).releasePointerCapture(event.pointerId)
        } catch (_err) {
          // Already released with the pointer.
        }
        reportDrag(null)
        if (!commit || !moved) {
          preview.clear()
          endCanvasGesture(gesture)
          return
        }
        const finalPatch = patch
        runSelectionStyleCommand((commitApi) => {
          // Cleared HERE, in the same layout effect as the commit, so the
          // screen goes from the preview straight to the committed value.
          preview.clear()
          commitApi.commitStyleMany(finalPatch)
          endCanvasGesture(gesture)
        })
      }
      const onUp = () => finish(true)
      const onCancel = () => finish(false)
      cancelActive = onCancel

      // ERR-12 — before the move listener, so a move with the button already
      // up finishes the drag instead of being a step.
      const disposeGuard = guardDragSession({
        documents: [iframeDoc],
        focusWindow: window,
        onReleaseLost: () => finish(true),
        onAbandon: () => finish(false),
      })
      iframeDoc.addEventListener('pointermove', onMove)
      iframeDoc.addEventListener('pointerup', onUp)
      iframeDoc.addEventListener('pointercancel', onCancel)
      for (const doc of keyDocuments) {
        doc.addEventListener('keydown', onKey, true)
        doc.addEventListener('keyup', onKey, true)
      }
    }

    layer.addEventListener('pointerdown', onPointerDown)
    iframeDoc.addEventListener('click', swallowBandClick, true)
    iframeDoc.addEventListener('dblclick', swallowBandClick, true)
    return () => {
      cancelActive?.()
      layer.removeEventListener('pointerdown', onPointerDown)
      iframeDoc.removeEventListener('click', swallowBandClick, true)
      iframeDoc.removeEventListener('dblclick', swallowBandClick, true)
    }
  }, [layer, iframeDoc, nodeId])
}
