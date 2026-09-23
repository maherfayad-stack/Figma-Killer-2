/**
 * keybindingViewport — the keys that move the VIEW, not the document: zoom in,
 * zoom out, zoom to 100%, fit, fit the selection, and Space-to-pan.
 *
 * Their own module for the same reason `keybindingGestures.ts` is one: the
 * registry file sits under the 700-line ceiling, and "keys that change what the
 * user is looking at" is a seam its comments had already drawn. Spread into
 * `KEYBINDINGS` right where the old block stood, so the `?` sheet keeps its
 * order.
 *
 * ## Who handles them (P2-B, IX-15)
 *
 * All six are handled by ONE scope on the editor key ladder —
 * `hooks/useCanvasViewportKeys.ts`, on the `global` rung. Until P2-B, +/−/⇧1/⇧2
 * were a React `onKeyDown` on the canvas div (dead the moment focus moved into
 * a panel — the `board-02`/`select-01` defect class a third time) and Space and
 * ⌘0 were two raw `document` listeners with hand-copied guards. The
 * single-dispatcher gate now scans `hooks/` as well as `canvas/`, which is why
 * none of that can come back unseen.
 *
 * ## Shift+digit matches the PHYSICAL key
 *
 * ⇧1 on a US layout is `key: '!'`, so a `match` that tests `e.key === '1'` never
 * fires from a real keyboard. The digit bindings accept `code: 'Digit1'` as well
 * as `key: '1'` (the latter is what an AZERTY layout, and a synthetic test
 * event, report). See `KeyEventLike.code`.
 */
import { isPlatformMac, type KeyEventLike, type KeybindingDefinition } from './keybindingShape'

/** True when `e` is the physical/logical digit `digit` (see the module doc). */
function isDigit(e: KeyEventLike, digit: string): boolean {
  return e.key === digit || e.code === `Digit${digit}`
}

function hasModifierOtherThanShift(e: KeyEventLike): boolean {
  return e.metaKey || e.ctrlKey || e.altKey
}

export const VIEWPORT_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  // Virtual ids: no matching spotlight Command (a discrete viewport action,
  // not a palette-run gesture) — `displayName` is the help-screen title.
  //
  // NOT bound: ⌘1 / ⌘2 as fit/selection aliases. `viewport-01` checked and
  // they are free in this registry — but Cmd/Ctrl+1…8 is reserved by every
  // major browser for tab switching and is NOT cancellable from page script
  // (unlike ⌘0 and ⌘R, which are). Registering them would put two rows in the
  // help sheet for keystrokes that never reach the app.
  {
    commandId: 'canvas.zoomIn',
    displayName: 'Zoom in',
    shortcut: { mac: '+', win: '+' },
    // `=` is the same physical key without Shift. ⌘= / Ctrl+= are accepted
    // too: they are browser page zoom otherwise, which `AdminZoomGuard` already
    // refuses — so the canvas zooming is what the user meant.
    match: (e) => !e.altKey && (e.key === '=' || e.key === '+'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'canvas.zoomOut',
    displayName: 'Zoom out',
    shortcut: { mac: '−', win: '−' },
    // `_` is Shift+`-` — Penpot binds both, and a hand that just pressed ⇧+
    // to zoom in is still holding Shift.
    match: (e) => !e.altKey && (e.key === '-' || e.key === '_'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'canvas.zoomReset',
    displayName: 'Zoom to 100%',
    shortcut: { mac: '⌘0', win: 'Ctrl+0' },
    // ⇧0 is Figma's and Penpot's own "100%" key; ⌘0 is the browser's, kept
    // because it is cancellable from page script and hands already know it.
    aliasShortcut: { mac: '⇧0', win: 'Shift+0' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+0' : 'Control+0',
    match: (e) =>
      ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && isDigit(e, '0')) ||
      (e.shiftKey && !hasModifierOtherThanShift(e) && isDigit(e, '0')),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'canvas.zoomToFit',
    displayName: 'Zoom to fit',
    shortcut: { mac: '⇧1', win: 'Shift+1' },
    ariaKeyshortcuts: 'Shift+1',
    match: (e) => e.shiftKey && !hasModifierOtherThanShift(e) && isDigit(e, '1'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'canvas.zoomToSelection',
    displayName: 'Zoom to selection',
    shortcut: { mac: '⇧2', win: 'Shift+2' },
    ariaKeyshortcuts: 'Shift+2',
    match: (e) => e.shiftKey && !hasModifierOtherThanShift(e) && isDigit(e, '2'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // Space is a HOLD, not a chord: keydown raises the pan flag and keyup (or
  // the window losing focus — ERR-11) lowers it. Any modifier is accepted,
  // exactly as before P2-B: a user who is already holding Shift for an axis
  // lock still expects Space to grab the board.
  {
    commandId: 'canvas.spacePan',
    displayName: 'Hold to pan (drag the board)',
    shortcut: { mac: 'Space', win: 'Space' },
    match: (e) => e.code === 'Space' || e.key === ' ',
    scope: 'canvas',
    ignoreInEditableField: true,
  },
]
