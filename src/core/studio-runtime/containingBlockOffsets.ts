/**
 * containingBlockOffsets (PA-1) — the offsets an absolutely positioned box
 * carries to sit at a given rect, measured against its REAL containing block,
 * never `offsetLeft` against `offsetParent`.
 *
 * `offsetParent` is the nearest POSITIONED ancestor; the containing block of an
 * absolute box is also established by `transform`, `perspective`, `filter`,
 * `contain` and `will-change`. When they disagree, `offsetLeft` is measured
 * from the wrong box and the written inset lands hundreds of px off (the
 * `left:-421px` class of bug). This is fed rects of the box and of the block
 * that really contains it, in one coordinate space, so it cannot disagree with
 * the browser.
 *
 * Offsets measure from the PADDING box (the block's border is subtracted).
 * `scale` is rendered / layout size of the block (an ancestor
 * `transform: scale()`) so the result is in CSS px. Pure; {@link readContainingBlock}
 * is the DOM half.
 */

export interface BoxRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ContainingBlockBox {
  /** The block's border-box rect, in the same space as the placed rect. */
  rect: BoxRect
  borderLeft: number
  borderTop: number
  borderRight: number
  borderBottom: number
  /** Rendered / layout size of the block (1 unless a transform scales it). */
  scale: number
  /** The block's own scroll offset — an absolute child scrolls with its content. */
  scrollLeft: number
  scrollTop: number
}

export interface ContainingBlockOffsets {
  left: number
  top: number
  right: number
  bottom: number
}

/** Round to a whole CSS px — what the source stores. `-0` is `0`. */
const whole = (value: number) => Math.round(value) + 0

export function containingBlockOffsets(placed: BoxRect, block: ContainingBlockBox): ContainingBlockOffsets {
  const scale = block.scale > 0 ? block.scale : 1
  const originX = block.rect.left + block.borderLeft * scale
  const originY = block.rect.top + block.borderTop * scale
  const paddingWidth = block.rect.width / scale - block.borderLeft - block.borderRight
  const paddingHeight = block.rect.height / scale - block.borderTop - block.borderBottom
  const left = (placed.left - originX) / scale + block.scrollLeft
  const top = (placed.top - originY) / scale + block.scrollTop
  return {
    left: whole(left),
    top: whole(top),
    right: whole(paddingWidth - left - placed.width / scale),
    bottom: whole(paddingHeight - top - placed.height / scale),
  }
}

/** `true` when this computed style makes the element the containing block of absolute descendants. */
export function establishesContainingBlock(style: {
  position: string
  transform: string
  perspective: string
  filter: string
  contain: string
  willChange: string
}): boolean {
  if (style.position !== 'static') return true
  if (style.transform !== 'none' && style.transform !== '') return true
  if (style.perspective !== 'none' && style.perspective !== '') return true
  if (style.filter !== 'none' && style.filter !== '') return true
  if (/layout|paint|strict|content/.test(style.contain)) return true
  return /transform|perspective|filter/.test(style.willChange)
}

const px = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The measured box of `node` as a containing block — its padding-box origin, scale and scroll. */
export function containingBlockBoxOf(view: Window, node: HTMLElement): ContainingBlockBox {
  const style = view.getComputedStyle(node)
  const rect = node.getBoundingClientRect()
  return {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    borderLeft: px(style.borderLeftWidth),
    borderTop: px(style.borderTopWidth),
    borderRight: px(style.borderRightWidth),
    borderBottom: px(style.borderBottomWidth),
    scale: node.offsetWidth > 0 ? rect.width / node.offsetWidth : 1,
    scrollLeft: node.scrollLeft,
    scrollTop: node.scrollTop,
  }
}

/**
 * The element that actually contains `element` once it is absolute, with its
 * measured box — or `null` when no ancestor establishes one (the initial
 * containing block: nothing the tree can name, so callers refuse).
 */
export function readContainingBlock(
  view: Window,
  element: HTMLElement,
): { element: HTMLElement; box: ContainingBlockBox } | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (!establishesContainingBlock(view.getComputedStyle(node))) continue
    return { element: node, box: containingBlockBoxOf(view, node) }
  }
  return null
}
