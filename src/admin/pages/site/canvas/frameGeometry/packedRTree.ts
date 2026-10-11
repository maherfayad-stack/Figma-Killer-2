/**
 * PackedRTree — a static, bulk-loaded R-tree over axis-aligned boxes, stored in
 * typed arrays. It is the spatial structure under `FrameGeometryIndex`.
 *
 * ## Why a packed, static tree
 *
 * A frame's geometry is read in one batch (`adapter.measureAll()`), so the tree
 * is built once per snapshot and never edited: a dirty frame is re-read and
 * rebuilt, not patched. That allows a layout with no pointers and no per-node
 * objects: one `Float64Array` of boxes per level, one `Uint32Array` of item ids
 * for the leaves. A 300-node frame builds in well under a millisecond and a
 * point query touches a handful of cache lines.
 *
 * ## Layout
 *
 * Items are ordered by Sort-Tile-Recursive packing (sort by x centre, cut into
 * vertical slices, sort each slice by y centre), cut into runs of
 * {@link NODE_SIZE}, and each run becomes one node of the level above, whose
 * box is the union of its run. The levels repeat until one node remains. Level
 * 0 holds the items themselves; node `j` of level `k` owns children
 * `j * NODE_SIZE ... (j + 1) * NODE_SIZE` of level `k - 1`. No child pointers
 * are stored: the position IS the pointer.
 *
 * The tree answers "which boxes contain / intersect this", and nothing else.
 * Ordering of overlapping hits (z-order, ancestry) is the caller's business:
 * `FrameGeometryIndex` sorts them, because that depends on document facts this
 * structure knows nothing about.
 */

/** Children per node. 16 keeps a node's boxes within a couple of cache lines. */
const NODE_SIZE = 16

export class PackedRTree {
  /** Number of items the tree was built over. */
  readonly size: number
  /** Per level, `4 * count` floats: `minX, minY, maxX, maxY` of each node. Level 0 is the items in packed order. */
  private readonly levels: Float64Array[]
  /** For level 0: the caller's index of the item at each packed position. */
  private readonly itemIds: Uint32Array

  /**
   * @param boxes `4 * n` numbers: `minX, minY, maxX, maxY` of item `i` at `4 * i`. Read once, never kept.
   */
  constructor(boxes: ArrayLike<number>) {
    const count = Math.floor(boxes.length / 4)
    this.size = count
    const order = packOrder(boxes, count)
    this.itemIds = Uint32Array.from(order)
    const leaves = new Float64Array(count * 4)
    for (let i = 0; i < count; i += 1) {
      const source = order[i]! * 4
      leaves[i * 4] = boxes[source]!
      leaves[i * 4 + 1] = boxes[source + 1]!
      leaves[i * 4 + 2] = boxes[source + 2]!
      leaves[i * 4 + 3] = boxes[source + 3]!
    }
    this.levels = [leaves]
    let below = leaves
    let belowCount = count
    while (belowCount > 1) {
      const nodeCount = Math.ceil(belowCount / NODE_SIZE)
      const level = new Float64Array(nodeCount * 4)
      for (let node = 0; node < nodeCount; node += 1) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        const end = Math.min((node + 1) * NODE_SIZE, belowCount)
        for (let child = node * NODE_SIZE; child < end; child += 1) {
          const at = child * 4
          if (below[at]! < minX) minX = below[at]!
          if (below[at + 1]! < minY) minY = below[at + 1]!
          if (below[at + 2]! > maxX) maxX = below[at + 2]!
          if (below[at + 3]! > maxY) maxY = below[at + 3]!
        }
        level[node * 4] = minX
        level[node * 4 + 1] = minY
        level[node * 4 + 2] = maxX
        level[node * 4 + 3] = maxY
      }
      this.levels.push(level)
      below = level
      belowCount = nodeCount
    }
  }

  /** Calls `visit(itemIndex)` for every item whose box intersects the query box (edges inclusive). */
  search(minX: number, minY: number, maxX: number, maxY: number, visit: (itemIndex: number) => void): void {
    if (this.size === 0) return
    const top = this.levels.length - 1
    const topCount = this.levels[top]!.length / 4
    for (let node = 0; node < topCount; node += 1) this.searchNode(top, node, minX, minY, maxX, maxY, visit)
  }

  /** Calls `visit(itemIndex)` for every item whose box contains the point (edges inclusive). */
  searchPoint(x: number, y: number, visit: (itemIndex: number) => void): void {
    this.search(x, y, x, y, visit)
  }

  private searchNode(level: number, node: number, minX: number, minY: number, maxX: number, maxY: number, visit: (itemIndex: number) => void): void {
    const boxes = this.levels[level]!
    const at = node * 4
    if (boxes[at + 2]! < minX || boxes[at]! > maxX || boxes[at + 3]! < minY || boxes[at + 1]! > maxY) return
    if (level === 0) {
      visit(this.itemIds[node]!)
      return
    }
    const childCount = this.levels[level - 1]!.length / 4
    const end = Math.min((node + 1) * NODE_SIZE, childCount)
    for (let child = node * NODE_SIZE; child < end; child += 1) {
      this.searchNode(level - 1, child, minX, minY, maxX, maxY, visit)
    }
  }
}

/** Sort-Tile-Recursive order of the items: spatially coherent runs of {@link NODE_SIZE}. */
function packOrder(boxes: ArrayLike<number>, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i)
  const centreX = (item: number) => boxes[item * 4]! + boxes[item * 4 + 2]!
  const centreY = (item: number) => boxes[item * 4 + 1]! + boxes[item * 4 + 3]!
  order.sort((a, b) => centreX(a) - centreX(b))
  const leafCount = Math.ceil(count / NODE_SIZE)
  const sliceSize = Math.max(1, Math.ceil(Math.sqrt(leafCount))) * NODE_SIZE
  for (let start = 0; start < count; start += sliceSize) {
    const slice = order.slice(start, start + sliceSize).sort((a, b) => centreY(a) - centreY(b))
    for (let i = 0; i < slice.length; i += 1) order[start + i] = slice[i]!
  }
  return order
}
