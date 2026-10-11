/**
 * studioBoardLayersChunk — the board's own chunk (`StudioBoardLayers`: frames,
 * sticky notes, doc blocks, guides), as a `prewarmedLazy` component.
 *
 * It stays a separate chunk, but it is no longer fetched only once the canvas
 * first renders a board: every Studio project opens on a board, so
 * `AdminCanvasLayout` preloads it together with the editor body (P6-B). A plain
 * `lazy()` here requested it only after the body chunk had arrived AND the
 * document was in the store — two waits in a row before the first frame could
 * even exist (measured ~1 s of a warm open under the dev server).
 */
import { prewarmedLazy } from '@admin/lib/prewarmedLazy'

export const StudioBoardLayers = prewarmedLazy(
  () => import('./StudioBoardLayers').then((m) => ({ default: m.StudioBoardLayers })),
  { displayName: 'StudioBoardLayers' },
)
