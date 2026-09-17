/**
 * keybindingGestures — the canvas affordances that are MODIFIERS, not chords.
 *
 * Alt-hover measurement (K5), Alt+drag duplicate (K2), ⌘-drag free move
 * (K6) and the Shift/Escape pair a drag session owns (S2). None of them can
 * be fired by a keystroke: the modifier is read off a POINTER event by the
 * gesture that owns it, so every `match` here is constant-false and no
 * dispatcher will ever route to one.
 *
 * They live in the registry anyway, because that array IS the `?` sheet
 * (`HelpKeybindingsList` renders exactly it) and a modifier nobody can
 * discover is a feature nobody has. Documenting them anywhere else would
 * fork the single source of truth
 * (`keybindings-registry-single-source.test.ts`).
 *
 * They are a separate module from `keybindings.ts` for the ordinary reason:
 * that file hit the 700-line ceiling, and "chords the dispatcher routes" and
 * "gestures it cannot" is the seam that was already drawn in its comments.
 * Spread LAST into `KEYBINDINGS`, because the registry's order is the
 * sheet's order and these are the newest canvas affordances.
 */
import type { KeybindingDefinition } from './keybindingShape'

export const GESTURE_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  // K5 — Alt-hover measurement: the distances between the selection and the
  // node under the pointer (`MeasureLayer.tsx`).
  {
    commandId: 'canvas.measureHover',
    displayName: 'Measure distance to the hovered element',
    shortcut: { mac: '⌥+Hover', win: 'Alt+Hover' },
    match: () => false,
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // K2 — the modifier is read off the pointer event by
  // `useCanvasReorderDrag` for elements and `BoardFrameView` for frames.
  {
    commandId: 'canvas.altDragDuplicate',
    displayName: 'Drag a copy instead of moving (elements and frames)',
    shortcut: { mac: '⌥ + drag', win: 'Alt + drag' },
    match: () => false,
    scope: 'canvas',
  },

  // K6 — ⌘/Ctrl while dragging places an element by coordinates instead of
  // reordering it; it refuses, with a one-click remedy, when the container
  // is `position: static`.
  {
    commandId: 'canvas.freeDragPosition',
    displayName: 'Drag to a position instead of reordering (needs a positioned parent)',
    shortcut: { mac: '⌘ + drag', win: 'Ctrl + drag' },
    match: () => false,
    scope: 'canvas',
  },

  // Shift constrains a drag to one axis, and Escape abandons it. Both are
  // real keys, but neither is dispatched — the drag session that owns the
  // pointer reads them itself, because a cancel must be handled by that
  // session and by nothing else.
  {
    commandId: 'canvas.dragAxisLock',
    displayName: 'Constrain a drag to one axis',
    shortcut: { mac: '⇧ + drag', win: 'Shift + drag' },
    match: () => false,
    scope: 'canvas',
  },
]
