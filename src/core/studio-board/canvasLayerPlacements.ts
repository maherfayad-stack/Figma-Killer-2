/**
 * canvasLayerPlacements — the pure `Board -> Board` transforms for P5-G's loose
 * layers (`canvasLayers.ts`), in the same copy-on-write shape as every other
 * board collection in `boardsModel.ts`: an untouched placement keeps its object
 * identity, so a renderer that compares references re-renders only what moved.
 *
 * The key is omitted from the board entirely when the list becomes empty, the
 * same rule `serialize.ts` reads with — a board that never held a loose layer
 * and a board whose last one was placed into a frame serialize identically.
 */
import type { Board, BoardsFile, CanvasLayerPlacement } from './types'

/** The board's loose layers, in stored order. */
export function boardLayers(board: Board): readonly CanvasLayerPlacement[] {
  return board.layers ?? []
}

function withLayers(board: Board, layers: CanvasLayerPlacement[]): Board {
  if (layers.length > 0) return { ...board, layers }
  if (board.layers === undefined) return board
  const { layers: _dropped, ...rest } = board
  return rest
}

/** Add a placement, or replace the one with the same id. */
export function upsertLayerPlacement(board: Board, placement: CanvasLayerPlacement): Board {
  const layers = boardLayers(board)
  const index = layers.findIndex((layer) => layer.id === placement.id)
  return withLayers(
    board,
    index === -1 ? [...layers, placement] : layers.map((layer, i) => (i === index ? placement : layer)),
  )
}

/** Drop every placement whose id is in `ids`. Returns `board` itself when none matched. */
export function removeLayerPlacements(board: Board, ids: ReadonlySet<string>): Board {
  const layers = boardLayers(board)
  if (!layers.some((layer) => ids.has(layer.id))) return board
  return withLayers(board, layers.filter((layer) => !ids.has(layer.id)))
}

/** Move placements to absolute board positions. Returns `board` itself when nothing changed. */
export function moveLayerPlacements(board: Board, moves: ReadonlyMap<string, { x: number; y: number }>): Board {
  const layers = boardLayers(board)
  let changed = false
  const next = layers.map((layer) => {
    const to = moves.get(layer.id)
    if (!to || (to.x === layer.x && to.y === layer.y)) return layer
    changed = true
    return { ...layer, x: to.x, y: to.y }
  })
  return changed ? withLayers(board, next) : board
}

/** Which board holds a placement, and the placement itself — `null` when no board does. */
export function findLayerPlacement(
  file: BoardsFile,
  id: string,
): { boardId: string; placement: CanvasLayerPlacement } | null {
  for (const board of file.boards) {
    const placement = boardLayers(board).find((layer) => layer.id === id)
    if (placement) return { boardId: board.id, placement }
  }
  return null
}

/** The `z` that paints a new layer above every existing one on `board`. */
export function nextLayerZ(board: Board): number {
  let top = 0
  for (const layer of boardLayers(board)) {
    if (typeof layer.z === 'number' && layer.z > top) top = layer.z
  }
  return top + 1
}

/** Loose layers in paint order, lowest first: unordered ones (no `z`) in stored order, then ordered ones by `z`. */
export function layerPaintOrder(layers: readonly CanvasLayerPlacement[]): CanvasLayerPlacement[] {
  const unordered = layers.filter((layer) => layer.z === undefined)
  const ordered = layers.filter((layer) => layer.z !== undefined).sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
  return [...unordered, ...ordered]
}
