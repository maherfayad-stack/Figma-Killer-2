/**
 * canvasKeyboardFocus — hand the keyboard back to the canvas after a POINTER
 * pick somewhere else (OD-15, 2026-09-24).
 *
 * The node rung's canvas-scoped keys (the arrows, Tab) only act while focus is
 * on the canvas surface (`isCanvasKeyboardSurface`), because inside a panel
 * those keys are the panel's: a field's caret, a tree's own navigation. Figma
 * draws the line by HOW the layer was picked, not where focus happens to be: a
 * click on a Layers row selects the layer and the arrows then move it, exactly
 * as after a canvas click; Tab-ing into the tree keeps the tree's keyboard.
 *
 * So a pointer pick calls this, and focus lands where a click on the canvas
 * would have put it — the canvas root. Keyboard entry never calls it, so the
 * tree keeps its accessibility path. Esc, a canvas click and every intent-
 * scoped shortcut (Delete, ⌘D…) are unaffected: they already worked from
 * anywhere.
 */
import { CANVAS_ROOT_SELECTOR } from './editorKeyGuards'

export function returnKeyboardToCanvas(doc: Document = document): void {
  const root = doc.querySelector<HTMLElement>(CANVAS_ROOT_SELECTOR)
  if (root) {
    root.focus({ preventScroll: true })
    return
  }
  // No canvas mounted (a panel rendered on its own): release focus to the
  // body, which the canvas-scoped keys also treat as the canvas.
  const active = doc.activeElement
  if (active && active !== doc.body && typeof (active as HTMLElement).blur === 'function') {
    ;(active as HTMLElement).blur()
  }
}
