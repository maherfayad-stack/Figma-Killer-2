/**
 * keybindingTools — the bare-letter TOOL keys: V T F C H K R O (E) P.
 *
 * Moved out of `keybindings.ts` in P5-E, when the armed draw tools (IX-12,
 * OD-5) and the layer commands pushed that file past the 700-line ceiling.
 * "The keys that pick what a drag means" is a seam its comments had already
 * drawn. Spread into `KEYBINDINGS` at the spot the block used to sit, so the
 * `?` sheet keeps its order.
 *
 * Bare letters, no modifier: these are the muscle-memory keys every design
 * tool binds, and the cost of getting them wrong is high (a stray `c` while
 * typing must never arm a canvas tool). Two guards, both enforced by
 * `useCanvasToolShortcuts`: `ignoreInEditableField` stands them down inside
 * any input/textarea/contenteditable — which covers the reply box, every
 * inspector field, the agent prompt, and canvas inline text editing — and
 * each `match` rejects every modifier, so ⌘C stays copy and ⌘T stays "new
 * browser tab". Virtual ids: arming a tool is a canvas gesture, not a palette
 * action, so `displayName` is the help-screen label.
 *
 * ## The draw tools (P5-E, IX-12, OD-5)
 *
 * R, O (E is Penpot's ellipse key, an alias), T and F ARM a draw tool instead
 * of inserting at once. Inside a frame the hover shows where the element will
 * land (the same drop line an insertion drag shows); a click inserts it there
 * and a drag also gives it the drawn size; T opens the new text for typing.
 * Each is a toggle on its own key, V / Escape put it away, and a draw puts it
 * away by itself. ⏎ with a tool armed still inserts at the selection, so a
 * keyboard-only user is never stranded (`useCanvasToolShortcuts`).
 *
 * ## The pen (P5-D, SVG-7)
 *
 * P arms the pen, Figma's key. Clicks place corner points, a drag places a
 * smooth one (⌥ breaks the handles' symmetry, ⇧ snaps to 45°), clicking the
 * first point closes the path, and ⏎ / Escape finish it — ONE new inline
 * `<svg>`, one write. ⌘Z inside a path takes back the last point. P again, or
 * V, puts it away. (⇧P / ⇧C, the pencil, is a follow-up; OD-10 D2 reserves
 * them.)
 */
import type { KeybindingDefinition } from './keybindingShape'

const noModifier = (e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) =>
  !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

export const TOOL_KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  {
    commandId: 'tools.text',
    displayName: 'Text tool — click or drag inside a frame, then type',
    shortcut: { mac: 'T', win: 'T' },
    ariaKeyshortcuts: 'T',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 't',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.frame',
    displayName: 'Frame tool — draw a container inside a frame',
    shortcut: { mac: 'F', win: 'F' },
    ariaKeyshortcuts: 'F',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'f',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.comment',
    displayName: 'Comment',
    shortcut: { mac: 'C', win: 'C' },
    ariaKeyshortcuts: 'C',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'c',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // V — the move tool (IX-11). Not a toggle like H / K: it is the way HOME,
  // so it puts away the hand, scale and draw tools AND disarms the comment
  // tool. Pressing it with nothing armed is a harmless no-op.
  {
    commandId: 'tools.move',
    displayName: 'Move tool (puts every other tool away)',
    shortcut: { mac: 'V', win: 'V' },
    ariaKeyshortcuts: 'V',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'v',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // `K4` — H and K are LATCHED TOGGLES on their own key: pressing H again puts
  // the hand tool away. A latched tool with no way back out from the keyboard
  // is how a canvas ends up feeling stuck, and Escape is not reliably
  // available here (the selection ladder claims it first whenever anything is
  // selected — see `editorKeyDispatcher.ts`).
  {
    commandId: 'tools.hand',
    displayName: 'Hand tool (drag to pan)',
    shortcut: { mac: 'H', win: 'H' },
    ariaKeyshortcuts: 'H',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'h',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.scale',
    displayName: 'Scale tool (resize proportionally)',
    shortcut: { mac: 'K', win: 'K' },
    ariaKeyshortcuts: 'K',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'k',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // R and O are Figma's rectangle and ellipse. Studio's document is a React
  // tree, so both draw a `base.container` — the box every layout is built
  // from — where the pointer lands in the frame's layout. `O` adds
  // `border-radius: 50%` inline, which is what an ellipse IS in CSS.
  {
    commandId: 'tools.rectangle',
    displayName: 'Rectangle tool — click or drag inside a frame',
    shortcut: { mac: 'R', win: 'R' },
    ariaKeyshortcuts: 'R',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'r',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ⇧K — Figma's "place image": opens the file picker (P5-B's `insert.image`
  // palette command, `spotlight/commands/images.ts`). NOT component-owned: an
  // argument-free command the generic dispatcher runs, gated on
  // `site.structure.edit`. K alone stays the scale tool (it rejects ⇧).
  {
    commandId: 'insert.image',
    displayName: 'Place an image (opens the file picker)',
    shortcut: { mac: '⇧K', win: 'Shift+K' },
    ariaKeyshortcuts: 'Shift+K',
    match: (e) => e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'k',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.pen',
    displayName: 'Pen — click for corners, drag for curves, ⏎ to finish',
    shortcut: { mac: 'P', win: 'P' },
    ariaKeyshortcuts: 'P',
    match: (e) => noModifier(e) && e.key.toLowerCase() === 'p',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.ellipse',
    displayName: 'Ellipse tool — click or drag inside a frame',
    shortcut: { mac: 'O', win: 'O' },
    aliasShortcut: { mac: 'E', win: 'E' },
    ariaKeyshortcuts: 'O E',
    match: (e) => noModifier(e) && (e.key.toLowerCase() === 'o' || e.key.toLowerCase() === 'e'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },
]
