/**
 * keybindingGestures — the canvas affordances that are MODIFIERS, not chords.
 *
 * Alt-hover measurement (K5), Alt+drag duplicate (K2), ⌘-drag free move
 * (K6), the Shift/Escape pair a drag session owns (S2), and the two D2
 * gestures that carry no modifier at all — dragging across a frame boundary
 * (G3) and dropping a file from the desktop (G15). None of them can be fired
 * by a keystroke: the modifier (or the drop) is read off a POINTER/DRAG event
 * by the gesture that owns it, so every `match` here is constant-false and no
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

  // D2 G3 — a drag that leaves the frame it started in. No modifier at all,
  // which is exactly why it belongs on the sheet: nothing about the gesture
  // announces that it crosses files, and the one thing a user needs to know
  // (Alt still means copy over there) is not discoverable by trying.
  {
    commandId: 'canvas.crossFrameDrag',
    displayName: 'Drag an element into another frame — moves it between files (⌥ copies)',
    shortcut: { mac: 'Drag across frames', win: 'Drag across frames' },
    match: () => false,
    scope: 'canvas',
  },

  // D2 G15 — an image file dragged in from the operating system. Not a
  // modifier either, and the only gesture on this sheet whose input device is
  // the desktop rather than the keyboard.
  {
    commandId: 'canvas.dropImageFile',
    displayName: 'Drop an image file onto a frame to add an <img>',
    shortcut: { mac: 'Drop a file', win: 'Drop a file' },
    match: () => false,
    scope: 'canvas',
  },
]
