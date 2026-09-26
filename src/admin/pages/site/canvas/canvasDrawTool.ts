/**
 * canvasDrawTool — the armed draw tools R / O (E) / T / F (P5-E, IX-12, OD-5):
 * what each one inserts, the drawn rectangle, and the seam P5-G points at the
 * empty board.
 *
 * ## The model
 *
 * A key ARMS a tool (`canvasTool` in the canvas slice). While armed, the
 * canvas shows a crosshair and, inside a frame, the SAME drop line an
 * insertion drag shows (`resolveCanvasPointerInsertionDrop`), so where the
 * element lands is visible before the press. Then:
 *
 *   - a CLICK inserts the element there. Its position comes from the parent's
 *     layout — the honest answer in a React tree (parity §15.3). A box gets
 *     Figma's 100 × 100 so it is visible at all; text keeps its natural size;
 *   - a DRAG inserts it at the press point and also writes the drawn `width`
 *     / `height` (⇧ keeps it square, ⌥ draws from the centre);
 *   - T then opens the new text for typing, once its source write lands
 *     (`createdNodeFollowUp.ts`).
 *
 * One insert is one structural `insert` edit, with the size riding the insert
 * itself as a `style` prop — the channel `O`'s `border-radius` already used —
 * so the element and its size are ONE write and ONE undo entry. The tool puts
 * itself away after a draw (Figma's default).
 *
 * ## For P5-G (the free canvas)
 *
 * A press on the EMPTY board is not a frame draw. Instead of dropping it, the
 * gesture offers it to `registerBoardDrawHandler`'s handler — P5-G's free
 * canvas registers one to create a loose layer there. With no handler the
 * board press is ignored and the tool stays armed. The handler receives the
 * tool, what it inserts, and the drawn rectangle in BOARD units; it returns
 * whether it created something (which disarms the tool, as a frame draw does).
 */
import type { DrawTool } from '@site/store/slices/canvasSlice'

export interface DrawToolSpec {
  moduleId: string
  /** The ghost's word for it. */
  label: string
  /** Inline styles every insert of this tool carries, React-style keys. */
  inlineStyles: Readonly<Record<string, string>>
  /**
   * The size a CLICK (no drag) gives it, frame px — `null` keeps the module's
   * natural size. A box with no size and no content has no area at all.
   */
  clickSize: { width: number; height: number } | null
  /**
   * Where ⏎ with the tool armed inserts it relative to the selection (the
   * pre-P5-E immediate insert, kept so a keyboard-only user is never
   * stranded): `inside` a container target, or `after` the selection.
   */
  keyboardPlacement: 'inside' | 'after'
}

/**
 * Figma's default fill, so a drawn rectangle or ellipse is visible the moment
 * it lands; it is an ordinary inline `background`, one click away in the
 * inspector. The frame and text tools add none.
 */
const DEFAULT_SHAPE_FILL = '#d9d9d9'

export const DRAW_TOOL_SPECS: Readonly<Record<DrawTool, DrawToolSpec>> = {
  rectangle: {
    moduleId: 'base.container',
    label: 'Rectangle',
    inlineStyles: { background: DEFAULT_SHAPE_FILL },
    clickSize: { width: 100, height: 100 },
    keyboardPlacement: 'after',
  },
  ellipse: {
    moduleId: 'base.container',
    label: 'Ellipse',
    inlineStyles: { background: DEFAULT_SHAPE_FILL, borderRadius: '50%' },
    clickSize: { width: 100, height: 100 },
    keyboardPlacement: 'after',
  },
  frame: {
    moduleId: 'base.container',
    label: 'Frame',
    inlineStyles: {},
    clickSize: { width: 100, height: 100 },
    keyboardPlacement: 'inside',
  },
  // P5-F / IX-13 — B. Inside a frame it IS the frame tool; on the empty board
  // it draws a new board frame instead (`boardDrawTool.ts`).
  board: {
    moduleId: 'base.container',
    label: 'Board',
    inlineStyles: {},
    clickSize: { width: 100, height: 100 },
    keyboardPlacement: 'inside',
  },
  text: {
    moduleId: 'base.text',
    label: 'Text',
    inlineStyles: {},
    clickSize: null,
    keyboardPlacement: 'inside',
  },
}

const DRAW_TOOLS: ReadonlySet<string> = new Set(Object.keys(DRAW_TOOL_SPECS))

export function isDrawTool(tool: string): tool is DrawTool {
  return DRAW_TOOLS.has(tool)
}

/** Screen px the pointer must travel before a press is a drag rather than a click. */
export const DRAW_DRAG_THRESHOLD_PX = 4

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DrawModifiers {
  /** ⇧ — a square. */
  square: boolean
  /** ⌥ — the press point is the centre, not a corner. */
  fromCenter: boolean
}

/** The rectangle drawn from `start` to `current` (any space), under the modifiers. Never negative. */
export function drawnRect(start: DrawPoint, current: DrawPoint, modifiers: DrawModifiers): DrawRect {
  let dx = current.x - start.x
  let dy = current.y - start.y
  if (modifiers.square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * side
    dy = Math.sign(dy || 1) * side
  }
  if (modifiers.fromCenter) {
    return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
  }
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  }
}

/** Whether the pointer travelled far enough (screen px) for the press to be a drag. */
export function isDrawDrag(start: DrawPoint, current: DrawPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAW_DRAG_THRESHOLD_PX
}

/**
 * The inline styles one draw inserts with: the tool's own, plus the size —
 * the drawn one (screen px ÷ the frame's scale, whole CSS px), or the click
 * size. `scale` is the frame's on-screen scale (the canvas zoom).
 */
export function drawInsertStyles(
  spec: DrawToolSpec,
  drawn: DrawRect | null,
  scale: number,
): Record<string, string> {
  const styles: Record<string, string> = { ...spec.inlineStyles }
  const size = drawn
    ? { width: Math.max(1, Math.round(drawn.width / scale)), height: Math.max(1, Math.round(drawn.height / scale)) }
    : spec.clickSize
  if (size) {
    styles.width = `${size.width}px`
    styles.height = `${size.height}px`
  }
  return styles
}

// ── A draw in flight ─────────────────────────────────────────────────────────

let drawGestureActive = false

/**
 * Set by `CanvasDrawToolLayer` for the length of one press. While a draw is
 * in flight Escape belongs to IT (the `node` rung's deselect stands down and
 * the `board` rung puts the tool away, which ends the draw) — otherwise, with
 * a layer selected, Escape would deselect and leave the rectangle still
 * following the pointer.
 */
export function setDrawGestureActive(active: boolean): void {
  drawGestureActive = active
}

export function isDrawGestureActive(): boolean {
  return drawGestureActive
}

// ── The empty-board seam (P5-G) ─────────────────────────────────────────────

export interface CanvasBoardDraw {
  tool: DrawTool
  spec: DrawToolSpec
  /** The drawn rectangle in BOARD units; a click is a zero-size rect at the press point. */
  boardRect: DrawRect
  /** True when the pointer was dragged (the rect carries a size). */
  dragged: boolean
}

/** Returns true when it created something for the draw. */
export type BoardDrawHandler = (draw: CanvasBoardDraw) => boolean

let boardDrawHandler: BoardDrawHandler | null = null

/**
 * Let the empty board take draws (P5-G). One handler at a time — the free
 * canvas is the only thing that owns the board's empty space. Returns the
 * unregister function.
 */
export function registerBoardDrawHandler(handler: BoardDrawHandler): () => void {
  boardDrawHandler = handler
  return () => {
    if (boardDrawHandler === handler) boardDrawHandler = null
  }
}

/** Offer a board draw to the registered handler; `false` when none took it. */
export function offerBoardDraw(draw: CanvasBoardDraw): boolean {
  return boardDrawHandler?.(draw) ?? false
}

/** Whether anything accepts draws on the empty board — the ghost says so when nothing does. */
export function acceptsBoardDraws(): boolean {
  return boardDrawHandler !== null
}
