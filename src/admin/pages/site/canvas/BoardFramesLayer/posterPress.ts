/**
 * posterPress — the press that promotes a poster frame is not lost (SB-5).
 *
 * A poster has no document to press on. A click on one selects the FRAME
 * (which makes it live: a selected frame is always in the live set), and
 * that is the whole answer below the readable zoom, where a frame is a
 * thumbnail. At a readable zoom the user meant a layer, so the click is
 * remembered here, and once the promoted frame's tree has committed it is
 * replayed against the frame's rect index: the layer under the pointer is
 * resolved by the ONE press-depth rule (`pressSelectionTarget`) and selected,
 * exactly as if the frame had been live when the button went down.
 *
 * The replay is dropped when the view moved or the user did anything else in
 * between, since a layer chosen for a screen position that no longer holds it
 * would be a surprise, not a convenience.
 */
import { useEditorStore } from '@site/store/store'
import { pressSelectionTarget } from '../canvasPressSelect'
import { hitTestBoard } from '../frameGeometry/frameGeometryRegistry'
import { POSTER_ZOOM } from './liveFrameCap'

interface PosterPress {
  frameId: string
  clientX: number
  clientY: number
  deep: boolean
  zoom: number
  panX: number
  panY: number
}

let pending: PosterPress | null = null

/** A click landed on a poster at `clientX/Y`. Below the poster zoom this is only the frame selection. */
export function armPosterPress(frameId: string, click: { clientX: number; clientY: number; deep: boolean }): void {
  const { zoom, panX, panY } = useEditorStore.getState()
  pending = zoom < POSTER_ZOOM ? null : { frameId, ...click, zoom, panX, panY }
}

/** Drop a remembered press (the frame went away, or the user moved on). */
export function cancelPosterPress(): void {
  pending = null
}

/** Replay the press remembered for `frameId`, if any, now that its frame is live and committed. */
export async function replayPosterPress(frameId: string, pageId: string): Promise<void> {
  const press = pending
  if (!press || press.frameId !== frameId) return
  pending = null
  const before = useEditorStore.getState()
  if (before.zoom !== press.zoom || before.panX !== press.panX || before.panY !== press.panY) return
  const found = await hitTestBoard({ x: press.clientX, y: press.clientY })
  const hit = found?.hits[0]
  if (!hit) return
  // The user did something else while the frame was loading: their newer intent wins.
  const state = useEditorStore.getState()
  if (state.selectedNodeIds.length > 0 || state.selectedFrameIds.join() !== before.selectedFrameIds.join()) return
  const target = pressSelectionTarget(state, pageId, frameId, hit.nodeId, { button: 0, shiftKey: false, metaKey: press.deep, ctrlKey: false })
  if (target === null) return
  state.setSelectedFrameIds([])
  state.selectNode(target, 'replace', { frameId })
}
