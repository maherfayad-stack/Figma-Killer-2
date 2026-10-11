/**
 * FrameGeometryIndex — where every node of ONE frame is, queryable in BOARD
 * space without touching the frame's document.
 *
 * Built from the batched `adapter.measureAll()` snapshot, it answers the
 * questions the canvas used to ask the DOM:
 *
 *  - {@link FrameGeometryIndex.nodesAt} / {@link FrameGeometryIndex.hitTest}:
 *    what is under this board point, topmost first (replaces
 *    `elementsFromPoint` + `closest('[data-node-id]')`);
 *  - {@link FrameGeometryIndex.rectOf}: a node's box in board units, with no
 *    `getBoundingClientRect` and no conversion chain
 *    (`elementRect x zoom + iframeOffset + panOffset`) to go stale;
 *  - {@link FrameGeometryIndex.nodesIn}: every node meeting a board rect
 *    (marquee).
 *
 * It is the foundation SB-4 draws the selection chrome from, and the only way
 * to hit-test a frame that has no live document (a poster).
 *
 * ## Board space, and why moving a frame is free
 *
 * Rects in a snapshot are body-relative; the frame's board position is
 * supplied separately as `origin` (where the frame's viewport top-left sits on
 * the board). The R-tree is built in frame-viewport units and the origin is
 * added/subtracted at the API edge, so dragging a frame is {@link
 * FrameGeometryIndex.setOrigin}, O(1), never a rebuild. Zoom needs no handling
 * at all: the board's zoom is a transform on the whole layer, so a frame's CSS
 * px ARE board units.
 *
 * ## What a hit test reproduces from the browser's, and what it does not
 *
 * Reproduced from the snapshot's flags: the deepest box wins over its ancestors;
 * siblings are ordered by paint rank, then document order; `pointer-events: none`
 * and `visibility: hidden` nodes are skipped; a point outside a clipping
 * ancestor (`overflow` not `visible`) cannot hit its descendants.
 *
 * NOT reproduced, so reported as `approximate: true` instead of guessed: a node
 * (or ancestor) with a `transform` (its rect is the bounds of a quad); and any
 * hit in a `truncated` snapshot (a late node may sit on top). Also not modelled:
 * stacking contexts created by `opacity`/`filter`/`isolation`, floats and
 * `clip-path`/`mask`. A caller that must be exact on those (a drag that commits
 * to a drop target) confirms with the native hit test while the frame is live;
 * a poster frame has nothing else to ask.
 */
import type { FrameGeometrySnapshot } from './frameGeometryTypes'
import { PackedRTree } from './packedRTree'

export interface BoardPoint {
  x: number
  y: number
}

export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameHit {
  nodeId: string
  /** The node's box in board units. */
  rect: BoardRect
  /** The index cannot vouch for this hit: see the module doc. */
  approximate: boolean
}

const CLIPS = 1
const INERT = 2
const TRANSFORMED = 4

export class FrameGeometryIndex {
  readonly truncated: boolean
  private originX: number
  private originY: number
  private readonly ids: string[]
  private readonly parents: Int32Array
  private readonly flags: Uint8Array
  private readonly paints: Int32Array
  /** `minX, minY, maxX, maxY` per node, in frame-viewport units. */
  private readonly boxes: Float64Array
  private readonly tree: PackedRTree
  private readonly byId = new Map<string, number>()
  private readonly union: BoardRect | null

  private constructor(snapshot: FrameGeometrySnapshot, origin: BoardPoint) {
    const nodes = snapshot.nodes
    this.truncated = snapshot.truncated
    this.originX = origin.x
    this.originY = origin.y
    this.ids = nodes.map((node) => node.nodeId)
    this.parents = Int32Array.from(nodes, (node) => node.parent)
    this.paints = Int32Array.from(nodes, (node) => node.paint)
    this.flags = Uint8Array.from(nodes, (node) => (node.clips ? CLIPS : 0) | (node.inert ? INERT : 0) | (node.transformed ? TRANSFORMED : 0))
    this.boxes = new Float64Array(nodes.length * 4)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    nodes.forEach((node, i) => {
      const left = node.rect.x + snapshot.origin.x
      const top = node.rect.y + snapshot.origin.y
      this.boxes[i * 4] = left
      this.boxes[i * 4 + 1] = top
      this.boxes[i * 4 + 2] = left + node.rect.width
      this.boxes[i * 4 + 3] = top + node.rect.height
      if (left < minX) minX = left
      if (top < minY) minY = top
      if (left + node.rect.width > maxX) maxX = left + node.rect.width
      if (top + node.rect.height > maxY) maxY = top + node.rect.height
      if (!this.byId.has(node.nodeId)) this.byId.set(node.nodeId, i)
    })
    this.union = nodes.length === 0 ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    this.tree = new PackedRTree(this.boxes)
  }

  /**
   * Builds the index for one frame. `origin` is where the frame's viewport top-left sits on the board. Entries
   * with a non-finite rect or a `parent` that is not an earlier entry are dropped/re-rooted rather than trusted:
   * a bridge snapshot crosses a process boundary.
   */
  static fromSnapshot(snapshot: FrameGeometrySnapshot, origin: BoardPoint): FrameGeometryIndex {
    return new FrameGeometryIndex(sanitize(snapshot), origin)
  }

  get nodeCount(): number {
    return this.ids.length
  }

  /** Moves the frame on the board. O(1): the tree is in frame-viewport units. */
  setOrigin(origin: BoardPoint): void {
    this.originX = origin.x
    this.originY = origin.y
  }

  get origin(): BoardPoint {
    return { x: this.originX, y: this.originY }
  }

  /** The union of every node's box, in board units; `null` for an empty frame. */
  bounds(): BoardRect | null {
    return this.union === null ? null : { x: this.union.x + this.originX, y: this.union.y + this.originY, width: this.union.width, height: this.union.height }
  }

  has(nodeId: string): boolean {
    return this.byId.has(nodeId)
  }

  /** The node's box in board units, or `null` when the frame has no box for it. */
  rectOf(nodeId: string): BoardRect | null {
    const index = this.byId.get(nodeId)
    return index === undefined ? null : this.rectAt(index)
  }

  /**
   * The node's box in the FRAME's own viewport px (the iframe element's coordinate space, which is also the
   * space of the chrome the parent paints beside it), or `null` when the frame has no box for it. Independent
   * of the frame's place on the board, so chrome that rides its frame needs no board origin at all.
   */
  localRectOf(nodeId: string): BoardRect | null {
    const index = this.byId.get(nodeId)
    if (index === undefined) return null
    const at = index * 4
    return { x: this.boxes[at]!, y: this.boxes[at + 1]!, width: this.boxes[at + 2]! - this.boxes[at]!, height: this.boxes[at + 3]! - this.boxes[at + 1]! }
  }

  /** The listed ancestors of `nodeId`, nearest first. Empty for a root or an unknown node. */
  ancestorsOf(nodeId: string): string[] {
    const out: string[] = []
    let at = this.byId.get(nodeId)
    if (at === undefined) return out
    for (at = this.parents[at]!; at >= 0; at = this.parents[at]!) out.push(this.ids[at]!)
    return out
  }

  /**
   * Every node a pointer at `point` (board units) is over, topmost first: the hit, then what it sits on, ending at
   * the page root. Same shape as the browser's `elementsFromPoint` mapped through `closest('[data-node-id]')`.
   */
  nodesAt(point: BoardPoint): FrameHit[] {
    const x = point.x - this.originX
    const y = point.y - this.originY
    const candidates: number[] = []
    this.tree.searchPoint(x, y, (i) => {
      if (this.coversPoint(i, x, y) && (this.flags[i]! & INERT) === 0 && this.passesClips(i, x, y)) candidates.push(i)
    })
    if (candidates.length > 1) {
      const chains = new Map<number, number[]>(candidates.map((i) => [i, this.chainTo(i)]))
      candidates.sort((a, b) => this.compareStacking(chains.get(b)!, chains.get(a)!))
    }
    return candidates.map((i) => ({ nodeId: this.ids[i]!, rect: this.rectAt(i), approximate: this.truncated || this.isTransformed(i) }))
  }

  /** The topmost node at `point`, or `null` over empty frame. */
  hitTest(point: BoardPoint): FrameHit | null {
    return this.nodesAt(point)[0] ?? null
  }

  /** Every node whose box overlaps `rect` (board units), in document order. For marquee selection. */
  nodesIn(rect: BoardRect): string[] {
    const minX = rect.x - this.originX
    const minY = rect.y - this.originY
    const found: number[] = []
    this.tree.search(minX, minY, minX + rect.width, minY + rect.height, (i) => {
      const at = i * 4
      // Edge contact is not overlap.
      if (this.boxes[at + 2]! > minX && this.boxes[at]! < minX + rect.width && this.boxes[at + 3]! > minY && this.boxes[at + 1]! < minY + rect.height) found.push(i)
    })
    return found.sort((a, b) => a - b).map((i) => this.ids[i]!)
  }

  private rectAt(i: number): BoardRect {
    const at = i * 4
    return {
      x: this.boxes[at]! + this.originX,
      y: this.boxes[at + 1]! + this.originY,
      width: this.boxes[at + 2]! - this.boxes[at]!,
      height: this.boxes[at + 3]! - this.boxes[at + 1]!,
    }
  }

  /** Half-open, like the browser: the left/top edge hits, the right/bottom edge does not. */
  private coversPoint(i: number, x: number, y: number): boolean {
    const at = i * 4
    return x >= this.boxes[at]! && x < this.boxes[at + 2]! && y >= this.boxes[at + 1]! && y < this.boxes[at + 3]!
  }

  private passesClips(i: number, x: number, y: number): boolean {
    for (let ancestor = this.parents[i]!; ancestor >= 0; ancestor = this.parents[ancestor]!) {
      if ((this.flags[ancestor]! & CLIPS) !== 0 && !this.coversPoint(ancestor, x, y)) return false
    }
    return true
  }

  private isTransformed(i: number): boolean {
    for (let at = i; at >= 0; at = this.parents[at]!) if ((this.flags[at]! & TRANSFORMED) !== 0) return true
    return false
  }

  /** Root first, `i` last. */
  private chainTo(i: number): number[] {
    const chain: number[] = []
    for (let at = i; at >= 0; at = this.parents[at]!) chain.push(at)
    return chain.reverse()
  }

  /** Positive when the node at the end of `a` paints above the one ending `b`: a descendant over its ancestor, else the first branch that differs decides by paint rank, then document order. */
  private compareStacking(a: number[], b: number[]): number {
    const shared = Math.min(a.length, b.length)
    for (let depth = 0; depth < shared; depth += 1) {
      const left = a[depth]!
      const right = b[depth]!
      if (left === right) continue
      return this.paints[left]! !== this.paints[right]! ? this.paints[left]! - this.paints[right]! : left - right
    }
    return a.length - b.length
  }
}

function sanitize(snapshot: FrameGeometrySnapshot): FrameGeometrySnapshot {
  const nodes = snapshot.nodes
  const clean = nodes.every(
    (node, i) =>
      Number.isFinite(node.rect.x) && Number.isFinite(node.rect.y) && Number.isFinite(node.rect.width) && Number.isFinite(node.rect.height) &&
      node.rect.width >= 0 && node.rect.height >= 0 && node.parent >= -1 && node.parent < i,
  )
  if (clean && Number.isFinite(snapshot.origin.x) && Number.isFinite(snapshot.origin.y)) return snapshot
  // Drop unusable entries and remap `parent` to the nearest surviving ancestor.
  const remap = new Map<number, number>()
  const kept: FrameGeometrySnapshot['nodes'] = []
  nodes.forEach((node, i) => {
    const usable =
      Number.isFinite(node.rect.x) && Number.isFinite(node.rect.y) && Number.isFinite(node.rect.width) && Number.isFinite(node.rect.height) &&
      node.rect.width >= 0 && node.rect.height >= 0
    if (!usable) return
    // Walk up through dropped ancestors; every step must go strictly earlier, or the link is garbage and the node becomes a root.
    let parent = node.parent < i ? node.parent : -1
    while (parent >= 0 && !remap.has(parent)) {
      const next = nodes[parent]!.parent
      parent = next < parent ? next : -1
    }
    remap.set(i, kept.length)
    kept.push({ ...node, parent: parent < 0 ? -1 : remap.get(parent)! })
  })
  const origin = Number.isFinite(snapshot.origin.x) && Number.isFinite(snapshot.origin.y) ? snapshot.origin : { x: 0, y: 0 }
  return { origin, nodes: kept, truncated: snapshot.truncated }
}
