/**
 * canvasRevealFrame - bring a page's board frame into view when something
 * OUTSIDE the canvas (a row in the Pages list) asks for that page.
 *
 * Clicking a page row used to make the page active and nothing more: with the
 * frame off-screen the click changed the URL and the Properties panel while the
 * board stayed where it was, so the row looked dead. Figma moves the viewport
 * to what you picked; this does the same, with the two rules that keep it from
 * being annoying:
 *
 *   - it only moves when the frame is NOT already (even partly) in the visible
 *     part of the canvas - a click on a row whose frame you are looking at must
 *     not make the board jump;
 *   - a page the author just CREATED is shown whole (`whole: true`): a new frame
 *     that sits half under the Properties panel is not "in front of them";
 *   - it pans, it never zooms: the zoom is the author's, and a pan is enough to
 *     put the frame in front of them (a frame bigger than the viewport is
 *     centred, the way a fit would).
 *
 * The visible part is the canvas root minus the margins a fit leaves
 * (`measureCanvasFitInsets`): the floating notch on top and the docked
 * Properties panel's reserved width on the right.
 */
import { FRAME_HEADER_HEIGHT, FRAME_HEIGHT, FRAME_WIDTH, getActiveBoard } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { measureCanvasFitInsets } from './canvasViewportCommands'
import { DEFAULT_ZOOM_FIT_PADDING_PX } from './canvasZoomFit'

/**
 * True when the camera moved. `whole` asks for the entire frame card to be on
 * screen; otherwise any part of it is enough.
 */
export function revealPageFrame(pageId: string, options: { whole?: boolean } = {}): boolean {
  const state = useEditorStore.getState()
  const frame = getActiveBoard(state.boards, state.activeBoardId)?.frames.find((candidate) => candidate.pageId === pageId)
  const root = document.querySelector<HTMLElement>('[data-testid="canvas-root"]')
  if (!frame || !root) return false

  const { zoom, panX, panY } = state
  const rootRect = root.getBoundingClientRect()
  const insets = measureCanvasFitInsets(root, DEFAULT_ZOOM_FIT_PADDING_PX)

  // The frame card in canvas-root-relative screen px: its header strip plus its body.
  const left = frame.x * zoom + panX
  const top = (frame.y - FRAME_HEADER_HEIGHT) * zoom + panY
  const width = (frame.width ?? FRAME_WIDTH) * zoom
  const height = ((frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT) * zoom

  const visibleRight = rootRect.width - insets.right
  const visibleBottom = rootRect.height - insets.bottom
  const overlaps = left < visibleRight && left + width > insets.left && top < visibleBottom && top + height > insets.top
  const contained = left >= insets.left && left + width <= visibleRight && top >= insets.top && top + height <= visibleBottom
  // A card bigger than the visible area can never be contained: it is in view once it overlaps.
  const fits = width <= visibleRight - insets.left && height <= visibleBottom - insets.top
  const inView = options.whole && fits ? contained : overlaps
  if (inView) return false

  const centreX = insets.left + (visibleRight - insets.left) / 2
  const centreY = insets.top + (visibleBottom - insets.top) / 2
  state.setCanvasTransform(zoom, panX + centreX - (left + width / 2), panY + centreY - (top + height / 2))
  return true
}
