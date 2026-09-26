/**
 * keybindingLayerCommands — P5-E's layer commands: align (⌥A ⌥D ⌥W ⌥S ⌥H
 * ⌥V, IX-20), bring to front / send to back (⌘⇧] ⌘⇧[, IX-9), add flex
 * layout (⇧A, IX-10) and copy / paste style (⌘⌥C ⌘⌥V, IX-props) — and
 * P5-F's quick styles: opacity on the digits and flip on ⇧H / ⇧V (IX-misc,
 * `canvas/layerQuickStyles.ts`) — and P5-C's detach instance (⌘⌥B, Figma's
 * key, DET-5: the store's one `detachInstances` action).
 *
 * Its own module because `keybindings.ts` sits at the 700-line ceiling; the
 * shape and the rules are the registry's. Every one of these is
 * COMPONENT-OWNED (`shortcutDispatch.ts`): `useCanvasLayerCommandKeys` handles
 * them on the `node` rung, scoped by intent (a layer is selected) the way
 * Delete is, so they work after a click into the inspector too. The spotlight
 * commands with the same ids (`commands/layerArrange.ts`) and the right-click
 * menu run the SAME functions (`canvas/layerCommands.ts`), and read their
 * shortcut labels from here.
 *
 * ## Letters with ⌥ are matched on `code`, not `key`
 *
 * On a Mac, Option turns a letter into another character: ⌥A arrives as
 * `key: 'å'`, ⌘⌥C as `key: 'ç'`. `event.code` (`'KeyA'`) is the physical key
 * whatever the layout does to it, which is the thing a shortcut names. `key`
 * is still accepted for a synthetic event that carries no `code` (a test, a
 * clone from a frame that did not copy it).
 */
import type { KeyEventLike, KeybindingDefinition } from './keybindingShape'

/** The physical letter key — `code` first (see the module doc), `key` for an event without one. */
function isLetter(e: KeyEventLike, letter: string): boolean {
  if (e.code) return e.code === `Key${letter.toUpperCase()}`
  return e.key.toLowerCase() === letter
}

/**
 * The digit a bare key press names, or `null` — `key` (what an AZERTY layout
 * and a synthetic event report) or the physical `Digit` / `Numpad` code.
 */
export function opacityDigit(e: KeyEventLike): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  const fromCode = e.code ? /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] : undefined
  const digit = fromCode ?? (/^[0-9]$/.test(e.key) ? e.key : undefined)
  return digit === undefined ? null : Number(digit)
}

/** ⇧ + a letter and nothing else. */
const shiftLetter = (letter: string) => (e: KeyEventLike) =>
  e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isLetter(e, letter)

/** ⌥ + a letter and nothing else — Figma's align chords. */
const altLetter = (letter: string) => (e: KeyEventLike) =>
  e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && isLetter(e, letter)

/** The align commands, in the order Figma lists them. `edge` is `AlignEdge` (`@ui/components/AlignBar`). */
export const ALIGN_COMMANDS = [
  { commandId: 'layers.alignLeft', edge: 'left', letter: 'a', label: 'Align left' },
  { commandId: 'layers.alignHorizontalCenter', edge: 'center', letter: 'h', label: 'Align horizontal centres' },
  { commandId: 'layers.alignRight', edge: 'right', letter: 'd', label: 'Align right' },
  { commandId: 'layers.alignTop', edge: 'top', letter: 'w', label: 'Align top' },
  { commandId: 'layers.alignVerticalCenter', edge: 'middle', letter: 'v', label: 'Align vertical centres' },
  { commandId: 'layers.alignBottom', edge: 'bottom', letter: 's', label: 'Align bottom' },
] as const

export const LAYER_COMMAND_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  // IX-20 — one row per edge. A flow child aligns through `align-self` /
  // `justify-self` (or its parent's `justify-content` when it is the only
  // child); an absolute layer moves its offsets inside its parent; two or
  // more absolute layers align to each other (`canvas/layerAlign.ts`).
  ...ALIGN_COMMANDS.map(({ commandId, letter, label }): KeybindingDefinition => ({
    commandId,
    displayName: label,
    shortcut: { mac: `⌥${letter.toUpperCase()}`, win: `Alt+${letter.toUpperCase()}` },
    ariaKeyshortcuts: `Alt+${letter.toUpperCase()}`,
    match: altLetter(letter),
    scope: 'canvas',
    ignoreInEditableField: true,
  })),

  // IX-9 — FRONT means painted on top: the LAST child, because later siblings
  // paint over earlier ones when they overlap (absent a z-index). That is the
  // opposite end of the Layers list from where ⌘] steps: ⌘[ / ⌘] follow the
  // Layers list (up = earlier in the code, K4), front / back follow paint
  // order (Figma's words). The conflict register in `keybindings.ts` records
  // the split. ⌘⇧↑ / ⌘⇧↓ are Penpot's keys for the same two commands.
  {
    commandId: 'layers.bringToFront',
    displayName: 'Bring to front (last in the code, paints on top)',
    shortcut: { mac: '⌘⇧]', win: 'Ctrl+Shift+]' },
    aliasShortcut: { mac: '⌘⇧↑', win: 'Ctrl+Shift+↑' },
    ariaKeyshortcuts: 'Control+Shift+BracketRight',
    match: (e) =>
      (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey &&
      (e.code === 'BracketRight' || e.key === '}' || e.key === 'ArrowUp'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.sendToBack',
    displayName: 'Send to back (first in the code, paints underneath)',
    shortcut: { mac: '⌘⇧[', win: 'Ctrl+Shift+[' },
    aliasShortcut: { mac: '⌘⇧↓', win: 'Ctrl+Shift+↓' },
    ariaKeyshortcuts: 'Control+Shift+BracketLeft',
    match: (e) =>
      (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey &&
      (e.code === 'BracketLeft' || e.key === '{' || e.key === 'ArrowDown'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // IX-10 — Figma's "add auto layout". A container becomes `display: flex`
  // in the direction its children already run; pressed again it goes back to
  // block. Two or more siblings are grouped first, then the group is laid out.
  {
    commandId: 'layers.toggleFlexLayout',
    displayName: 'Add flex layout (again removes it; several layers are grouped first)',
    shortcut: { mac: '⇧A', win: 'Shift+A' },
    ariaKeyshortcuts: 'Shift+A',
    match: (e) => e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isLetter(e, 'a'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // P5-F (IX-misc) — Penpot's `opacity-N` and Figma's digit keys: 1–9 set
  // 10–90 %, 0 is 100 % (it clears the layer's own opacity). Bare digits,
  // canvas-scoped like every layer command, so a digit typed in a field is
  // the field's. ⇧0 / ⇧1 / ⇧2 stay the zoom keys (they carry Shift).
  {
    commandId: 'layers.opacity',
    displayName: 'Opacity — 1 to 9 set 10–90 %, 0 sets 100 %',
    shortcut: { mac: '0–9', win: '0–9' },
    match: (e) => opacityDigit(e) !== null,
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // P5-F (IX-misc) — Figma's and Penpot's flip keys, reserved for this in the
  // conflict register since P2-B. The standalone `scale` property, one axis's
  // sign (`panels/PropertiesPanel/flipValue.ts`).
  {
    commandId: 'layers.flipHorizontal',
    displayName: 'Flip horizontal',
    shortcut: { mac: '⇧H', win: 'Shift+H' },
    ariaKeyshortcuts: 'Shift+H',
    match: shiftLetter('h'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.flipVertical',
    displayName: 'Flip vertical',
    shortcut: { mac: '⇧V', win: 'Shift+V' },
    ariaKeyshortcuts: 'Shift+V',
    match: shiftLetter('v'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // IX-props — Figma's copy / paste properties. The layer's own inline style
  // and its classes; position and size stay behind (Figma's rule too).
  {
    commandId: 'layers.copyStyle',
    displayName: 'Copy style',
    shortcut: { mac: '⌘⌥C', win: 'Ctrl+Alt+C' },
    ariaKeyshortcuts: 'Control+Alt+C',
    match: (e) => (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && isLetter(e, 'c'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.pasteStyle',
    displayName: 'Paste style onto the selection',
    shortcut: { mac: '⌘⌥V', win: 'Ctrl+Alt+V' },
    ariaKeyshortcuts: 'Control+Alt+V',
    match: (e) => (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && isLetter(e, 'v'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // P5-C (DET-5) — Figma's detach instance. The selected component instances
  // become the markup they render, in the file; a selection with none does
  // nothing. The button, both context menus and the refusal remedy run the
  // same store action (`instanceActions.ts`).
  {
    commandId: 'layers.detachInstance',
    displayName: 'Detach instance',
    shortcut: { mac: '⌘⌥B', win: 'Ctrl+Alt+B' },
    ariaKeyshortcuts: 'Control+Alt+B',
    match: (e) => (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && isLetter(e, 'b'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },
]

/** The ids above, for `shortcutDispatch.ts`'s component-owned set. */
export const LAYER_COMMAND_IDS: ReadonlyArray<string> = LAYER_COMMAND_KEYBINDINGS.map((binding) => binding.commandId)
