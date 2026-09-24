/**
 * keybindings.ts — Unified keybindings registry (Phase 5).
 *
 * Single source of truth for every keyboard shortcut in the admin/editor.
 * Both the keyboard handlers (PanelRail, CanvasRoot, usePersistence,
 * SpotlightProvider, UndoRedoButtons) and the help screen (HelpKeybindingsList)
 * read exclusively from this registry.
 *
 * Shape:
 *   - commandId  → must match a spotlight Command id (or a virtual id for
 *                  bindings that don't map to a palette command, e.g. spotlight.open).
 *                  displayName is used as a fallback when no command is found.
 *   - shortcut   → { mac, win } display labels for UI hints and the help screen.
 *   - ariaKeyshortcuts → machine-readable ARIA attribute value (e.g. "Meta+I").
 *   - match      → predicate that tests a KeyboardEvent (or any KeyEventLike value).
 *   - scope      → where the binding is active:
 *                  'global'  = fires anywhere in the admin shell
 *                  'editor'  = fires within the editor workspace
 *                  'canvas'  = fires on layer-operation surfaces
 *                              (canvas or Layers tree)
 *                  'panels'  = fires in the panel rail / sidebar region
 *   - ignoreInEditableField → advisory flag; handlers enforce this themselves.
 *
 * Adding a new shortcut:
 *   1. Add an entry to KEYBINDINGS below.
 *   2. Wire the match predicate in the appropriate handler (PanelRail, CanvasRoot, etc.).
 *   3. If the commandId doesn't exist yet, add it to the spotlight commands registry.
 *   4. Re-run the architecture test: bun test src/__tests__/architecture/keybindings-registry-single-source.test.ts
 *   5. Check the conflict register below. A key that Figma or Penpot gives a
 *      different meaning gets a row there BEFORE it gets a binding here.
 *
 * ## Conflict register (OD-3, `docs/decisions.md`)
 *
 * Studio follows Figma's shortcut meanings. Penpot (the reference clone the
 * audit compared against: `docs/audits/2026-09-23-studio-audit/04-interactions.md`
 * §1) disagrees on a handful of keys. Each row is decided ONCE, here, so no
 * bundle re-litigates it. P2-B owns this file for Phase 2; P2-C, P2-E, P5-C,
 * P5-D and P5-E append a row when they bind a contested key.
 *
 *   Key        | Penpot meaning              | Studio meaning                  | Why
 *   -----------|-----------------------------|---------------------------------|-------------------------------------
 *   ⌘K         | create component            | Spotlight                       | The palette is the editor's hub
 *   F          | focus mode                  | container inside the selection  | Figma's F = frame
 *   ⌘⇧C        | toggle comments             | copy the selection as PNG       | Figma's
 *   ⌘⇧G        | toggle snap to ruler guides | ungroup                         | Figma's
 *   ⌘I         | italic                      | AI panel (outside a text edit)  | Inside an edit the element owns keys
 *   ⌘-drag     | marquee over shapes         | free move (feel plan, dec. 6)   | In-frame marquee gets another trigger (OD-6)
 *   ⇧-click    | toggle                      | TOGGLE on the canvas (P2-B)     | Was a tree RANGE; range stays in Layers
 *   ⌘-click    | deep select                 | toggle, an alias of ⇧-click     | Innermost-wins already is deep select
 *   Tab / ⇧Tab | next / previous sibling     | the same, canvas-scoped (P2-B)  | Never in a panel: Tab keeps its a11y role
 *   ⌘A         | select all in the parent    | siblings; again climbs a level; | Penpot's set + Figma's climb
 *              |                             | frames when nothing is selected |
 *   V          | move tool                   | move tool, disarms every tool   | P2-B
 *   ⇧0         | reset zoom                  | zoom to 100%, alias of ⌘0       | P2-B
 *   ⌘[ / ⌘]    | (unbound)                   | reorder ±1 in flow order        | "Up" = earlier in the DOM (IX-9)
 *   H          | toggle history              | hand tool (latched)             | Figma's
 *   ⇧H / ⇧V    | flip                        | unbound                         | Reserved for flip (IX-misc)
 *   ← ↑ → ↓    | nudge / move a flex child   | the same, by what is selected:  | P2-C (IX-1). Canvas-scoped like Tab:
 *              |                             | a frame or note nudges; an      | in a panel the arrows stay the
 *              |                             | absolute layer nudges its       | panel's (a tree, a field)
 *              |                             | offsets; a layout child         |
 *              |                             | reorders ±1 along its axis      |
 *   held arrow | repeats the step            | a nudge repeats, and writes     | A structural write per repeat
 *              |                             | ONCE on keyup; a reorder is     | would queue 30 writes a second
 *              |                             | one step per press              |
 *   arrows     | (Layers keeps focus)        | OD-15: a POINTER pick in Layers | Figma's. `returnKeyboardToCanvas`;
 *   after a    |                             | hands focus to the canvas, so   | Tab-ing into the tree keeps ↑/↓
 *   Layers     |                             | the arrows move the layer; a    | as row navigation (the a11y
 *   click      |                             | keyboard entry keeps the tree's | path), and a rename field keeps
 *              |                             | ↑/↓ (select the next row)       | its caret (P2-B's input guard)
 *   ⌥ held     | measure; nothing hovered →  | the same (P2-E, IX-19): hovered | The tree ladder keeps ⌥ over the
 *              | measure to the parent frame | layer, else the selection's     | selection; once a node was hovered
 *              |                             | parent                          | in the hold, no parent fallback
 */

import { GESTURE_KEYBINDINGS } from './keybindingGestures'
import { VIEWPORT_KEYBINDINGS } from './keybindingViewport'

// The binding SHAPE lives one module over so the gesture rows can name it
// without importing this file — see `keybindingShape.ts`. Re-exported here
// because this is the module every consumer already imports them from.
export type { KeyEventLike, KeybindingDefinition } from './keybindingShape'
export { isPlatformMac, formatShortcut } from './keybindingShape'
import type { KeyEventLike, KeybindingDefinition } from './keybindingShape'
import type { CommandId } from './types'
import { isPlatformMac } from './keybindingShape'

export const KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  // ── Global ──────────────────────────────────────────────────────────────────

  {
    commandId: 'spotlight.open',
    displayName: 'Open Command Spotlight',
    shortcut: { mac: '⌘K', win: 'Ctrl+K' },
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k',
    scope: 'global',
  },

  {
    commandId: 'editor.save',
    shortcut: { mac: '⌘S', win: 'Ctrl+S' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+S' : 'Control+S',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's',
    scope: 'global',
  },

  {
    commandId: 'settings.open',
    shortcut: { mac: '⌘,', win: 'Ctrl+,' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === ',',
    scope: 'global',
  },

  {
    commandId: 'help.shortcuts',
    shortcut: { mac: '?', win: '?' },
    match: (e) => e.key === '?' && !e.metaKey && !e.ctrlKey,
    scope: 'global',
    ignoreInEditableField: true,
  },

  // ── Editor (undo/redo — available in editor workspace) ───────────────────

  {
    commandId: 'editor.undo',
    shortcut: { mac: '⌘Z', win: 'Ctrl+Z' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Z' : 'Control+Z',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z',
    scope: 'editor',
    ignoreInEditableField: true,
  },

  {
    commandId: 'editor.redo',
    // Display/ARIA stay the canonical binding; `match` also recognises
    // Ctrl/Cmd+Y, the Windows/Linux redo alias — this used to be a second,
    // inline `(e.metaKey || e.ctrlKey) && e.key === 'y'` check hand-rolled in
    // `UndoRedoButtons.tsx` alongside a lookup of THIS same binding, which is
    // exactly the drift `keybindings-registry-single-source.test.ts` exists to
    // catch. Folding the alias into one `match` (rather than a second registry
    // entry) keeps a single canonical shortcut LABEL for redo everywhere it is
    // displayed (help screen, button tooltip) while still accepting either
    // keystroke — unchanged behavior from what `UndoRedoButtons.tsx` did by hand.
    shortcut: { mac: '⌘⇧Z', win: 'Ctrl+Shift+Z' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+Z' : 'Control+Shift+Z',
    match: (e) =>
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.shiftKey) ||
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y' && !e.shiftKey),
    scope: 'editor',
    ignoreInEditableField: true,
  },

  // ── Panels (sidebar focus cycling) ──────────────────────────────────────────

  {
    commandId: 'panels.cycleFocus',
    shortcut: { mac: 'F6', win: 'F6' },
    match: (e) => e.key === 'F6',
    scope: 'panels',
  },

  {
    commandId: 'ai.open',
    shortcut: { mac: '⌘I', win: 'Ctrl+I' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+I' : 'Control+I',
    match: (e) =>
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'i',
    scope: 'panels',
    ignoreInEditableField: true,
    capability: 'ai.chat',
  },

  // ── Canvas + Layers tree (layer operations) ─────────────────────────────────

  {
    commandId: 'layers.duplicate',
    shortcut: { mac: '⌘D', win: 'Ctrl+D' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.copy',
    shortcut: { mac: '⌘C', win: 'Ctrl+C' },
    // `!e.shiftKey` is load-bearing, not tidying: ⌘⇧C is `export.copySelectionPng`
    // below, and without this guard the same keystroke ALSO copied the node to
    // the layer clipboard — two commands, one press, in an order decided by
    // whichever listener happened to be registered first.
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.cut',
    shortcut: { mac: '⌘X', win: 'Ctrl+X' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.paste',
    shortcut: { mac: '⌘V', win: 'Ctrl+V' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.delete',
    shortcut: { mac: '⌘⌫', win: 'Ctrl+Backspace' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Backspace' : 'Control+Backspace',
    match: (e) =>
      ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'Backspace') ||
      (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey &&
        (e.key === 'Delete' || e.key === 'Backspace')),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Canvas viewport (zoom, fit, Space-pan — D3, IX-15) ──────────────────
  // In `keybindingViewport.ts`, handled by one `global`-rung scope
  // (`hooks/useCanvasViewportKeys.ts`).
  ...VIEWPORT_KEYBINDINGS,

  // ── Layers (keyboard reorder — G12) ──────────────────────────────────────
  // `layers.moveUp`/`layers.moveDown` already exist as spotlight Commands
  // (`spotlight/commands/layers.ts`) but had no keyboard binding — reordering
  // a node required a mouse. Alt+↑/↓ rather than a plain arrow key, for two
  // reasons that both still hold:
  //
  //  1. Plain arrows are not free. `canvas.moveSelection` below owns them,
  //     scoped by WHAT IS SELECTED, never globally grabbed: selected frames
  //     and notes nudge (`viewport-01`), and a selected node moves (P2-C,
  //     IX-1) — an absolute one nudges its offsets, a layout child reorders
  //     along its parent's axis. Sibling SELECTION went to Tab / ⇧Tab
  //     (P2-B, IX-3), not to the arrows.
  //  2. Alt+↑/↓ doesn't collide with `CanvasTreeLadderOverlay`'s Alt-HOLD
  //     hover-ladder gesture (that overlay only intercepts Arrow keys while
  //     its ladder is actively showing, i.e. Alt held AND hovering a valid
  //     node — see its own `handleKeyDown`; a bare Alt+↑ tap while not
  //     hovering falls through to this binding untouched).
  //
  // `K4` added `⌘]` / `⌘[` as ALIASES on these same two bindings, not as two
  // more entries: it is Figma's own reorder pair and the first thing a
  // designer's hands try, while ⌥↑/↓ stays because it is the one that works
  // without a meta key. Both live in one `match` so the help sheet keeps ONE
  // row per action (it keys rows by `commandId`) and shows both keycaps.
  // ⌘[ / ⌘] is browser back/forward on macOS and IS cancellable from page
  // script, which is why the handler `preventDefault`s.
  {
    // Real spotlight Command (`spotlight/commands/layers.ts`) — no
    // `displayName` needed, the command's own `title` is the help-screen label.
    commandId: 'layers.moveUp',
    shortcut: { mac: '⌥↑', win: 'Alt+↑' },
    aliasShortcut: { mac: '⌘]', win: 'Ctrl+]' },
    ariaKeyshortcuts: 'Alt+ArrowUp',
    match: (e) =>
      (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp') ||
      ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ']'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.moveDown',
    shortcut: { mac: '⌥↓', win: 'Alt+↓' },
    aliasShortcut: { mac: '⌘[', win: 'Ctrl+[' },
    ariaKeyshortcuts: 'Alt+ArrowDown',
    match: (e) =>
      (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown') ||
      ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '['),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Layers (selection traversal — viewport-01) ───────────────────────────
  // `layers.selectParent`/`layers.selectFirstChild` have existed as spotlight
  // Commands since the palette shipped and, like `layers.moveUp/Down` before
  // G12, had no keys — walking the tree needed a mouse or the palette.
  //
  // Enter / ⇧Enter, NOT Escape. Figma's own bindings are Enter = select
  // child, ⇧Enter = select parent, Esc = deselect, and Escape here is already
  // the load-bearing "get me back to nothing selected" ladder that
  // `select-01` shipped to fix a reported "I can't deselect" bug
  // (`useCanvasSelectionKeyboard.ts` documents it at length). Re-pointing
  // Escape at "select parent" would turn one press into N presses for a
  // deeply nested node and re-open exactly that bug, so the traversal takes
  // the keys Figma actually uses for it and Escape is left alone.
  //
  // Both are COMPONENT-OWNED (`shortcutDispatch.ts`): plain Enter has to
  // interleave with `enterSelectedInstance` (which claims it first, in the
  // capture phase), and both must fire from ANYWHERE — the generic dispatcher
  // requires focus to still be inside the canvas / layer tree, which one
  // click into the Properties panel ends for the session.
  {
    commandId: 'layers.selectFirstChild',
    shortcut: { mac: '↵', win: 'Enter' },
    ariaKeyshortcuts: 'Enter',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Enter',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.selectParent',
    shortcut: { mac: '⇧↵', win: 'Shift+Enter' },
    ariaKeyshortcuts: 'Shift+Enter',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key === 'Enter',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // Tab / ⇧Tab — the next / previous SIBLING, in source order, wrapping
  // (Penpot `select-next`/`select-prev`, IX-3). Virtual ids, component-owned by
  // `useCanvasSelectionKeyboard`.
  //
  // CANVAS-SCOPED, unlike every other `node`-rung key: Tab is how a keyboard
  // user walks the inspector's fields, so it acts only while focus is on the
  // canvas, a frame, or nowhere (`isCanvasKeyboardSurface`) — never inside a
  // panel. A frame's own Tab is cancelled inside the iframe and forwarded as a
  // clone, so it can neither walk the authored page's links nor go missing.
  {
    commandId: 'layers.selectNextSibling',
    displayName: 'Select the next sibling',
    shortcut: { mac: 'Tab', win: 'Tab' },
    ariaKeyshortcuts: 'Tab',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Tab',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.selectPreviousSibling',
    displayName: 'Select the previous sibling',
    shortcut: { mac: '⇧Tab', win: 'Shift+Tab' },
    ariaKeyshortcuts: 'Shift+Tab',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key === 'Tab',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Layers (rename / visibility — viewport-01) ───────────────────────────
  // ⌘R is Figma's rename key and IS cancellable from page script (unlike
  // ⌘1…8 — see the canvas-viewport block above), so `preventDefault` keeps
  // the browser from reloading the editor. Component-owned: `layers.rename`
  // takes a text arg, so the generic shortcut dispatcher skips it anyway, and
  // the canvas already owns a rename UI (`useCanvasRenameDialog`) that the
  // right-click menu opens — this binding opens the same dialog.
  {
    commandId: 'layers.rename',
    shortcut: { mac: '⌘R', win: 'Ctrl+R' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+R' : 'Control+R',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ⌘⇧H, Figma's own hide/show key. NOT component-owned — `layers.toggleVisibility`
  // is an argument-free, non-destructive spotlight Command, so the generic
  // dispatcher (`shortcutDispatch.ts`) runs it with no bespoke handler. It
  // acts on the multi-selection ANCHOR, exactly like the palette entry does.
  {
    commandId: 'layers.toggleVisibility',
    shortcut: { mac: '⌘⇧H', win: 'Ctrl+Shift+H' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+H' : 'Control+Shift+H',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ⌘⇧L, Figma's own lock/unlock key, and `layers.toggleVisibility`'s exact
  // twin: `layers.toggleLock` has existed as a spotlight Command since the
  // palette shipped (`commands/layers.ts`) and simply had no key, so locking a
  // layer meant the palette or the DOM panel's row button. Argument-free and
  // non-destructive, so — like ⌘⇧H — it needs NO bespoke handler: the generic
  // dispatcher in `shortcutDispatch.ts` runs it against the multi-selection
  // ANCHOR, exactly as the palette entry does. Adding a canvas handler here
  // would double-fire it.
  {
    commandId: 'layers.toggleLock',
    shortcut: { mac: '⌘⇧L', win: 'Ctrl+Shift+L' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+L' : 'Control+Shift+L',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Tools (bare-letter tool switches — Figma's own T / F / C) ───────────
  // Bare letters, no modifier: these are the muscle-memory keys every design
  // tool binds, and the cost of getting them wrong is high (a stray `c` while
  // typing must never arm a canvas tool). Two guards, both enforced by
  // `useCanvasToolShortcuts`: `ignoreInEditableField` stands them down inside
  // any input/textarea/contenteditable — which covers the reply box, every
  // inspector field, the agent prompt, and canvas inline text editing — and
  // each `match` rejects every modifier, so ⌘C stays copy and ⌘T stays "new
  // browser tab". Virtual ids: inserting at the selection is a canvas gesture,
  // not a palette action, so `displayName` is the help-screen label.
  {
    commandId: 'tools.text',
    displayName: 'Insert text',
    shortcut: { mac: 'T', win: 'T' },
    ariaKeyshortcuts: 'T',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.frame',
    displayName: 'Insert container',
    shortcut: { mac: 'F', win: 'F' },
    ariaKeyshortcuts: 'F',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.comment',
    displayName: 'Comment',
    shortcut: { mac: 'C', win: 'C' },
    ariaKeyshortcuts: 'C',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // V — the move tool (IX-11). Not a toggle like H / K: it is the way HOME,
  // so it puts away the hand and scale tools AND disarms the comment tool.
  // Pressing it with nothing armed is a harmless no-op.
  {
    commandId: 'tools.move',
    displayName: 'Move tool (puts every other tool away)',
    shortcut: { mac: 'V', win: 'V' },
    ariaKeyshortcuts: 'V',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // `K4` — the four Figma tool letters Studio was missing. Same two guards as
  // T / F / C above: `ignoreInEditableField` plus a `match` that rejects every
  // modifier, so ⌘K stays the palette, ⌘R stays rename and ⌘H/⌘O stay the
  // browser's. All four are LATCHED TOGGLES on their own key — pressing H
  // again puts the hand tool away. A latched tool with no way back out from
  // the keyboard is how a canvas ends up feeling stuck, and Escape is not
  // reliably available here (the selection ladder claims it first whenever
  // anything is selected — see `editorKeyDispatcher.ts`).
  {
    commandId: 'tools.hand',
    displayName: 'Hand tool (drag to pan)',
    shortcut: { mac: 'H', win: 'H' },
    ariaKeyshortcuts: 'H',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'h',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.scale',
    displayName: 'Scale tool (resize proportionally)',
    shortcut: { mac: 'K', win: 'K' },
    ariaKeyshortcuts: 'K',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // R and O are Figma's rectangle and ellipse. Studio's document is a React
  // tree, not a shape canvas, so both insert a `base.container` — the box every
  // layout is built from — as the NEXT SIBLING of the selection rather than
  // arming a draw gesture. `O` adds `border-radius: 50%` inline, which is what
  // an ellipse IS in CSS. `F` stays "container inside the selection", so the
  // pair is genuinely distinct: F nests, R/O extend the row you are in.
  {
    commandId: 'tools.rectangle',
    displayName: 'Insert a box beside the selection',
    shortcut: { mac: 'R', win: 'R' },
    ariaKeyshortcuts: 'R',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'tools.ellipse',
    displayName: 'Insert a round box beside the selection',
    shortcut: { mac: 'O', win: 'O' },
    ariaKeyshortcuts: 'O',
    match: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Export (copy the selection as an image) ──────────────────────
  // ⌘⇧C / Ctrl+Shift+C — Figma's own "copy as PNG". Virtual id: exporting the
  // selection is a canvas gesture with a live target, not an argument-free
  // palette action, so `displayName` is the help-screen label and
  // `useCopyAsPngShortcut` owns the handler.
  //
  // It shares a letter with `layers.copy` (⌘C) and with `tools.comment` (bare
  // `c`), and the three are separated by modifiers ALONE — which is why
  // `layers.copy`'s match now rejects Shift above. `tools.comment` already
  // rejects every modifier.
  {
    commandId: 'export.copySelectionPng',
    displayName: 'Copy as PNG',
    shortcut: { mac: '⌘⇧C', win: 'Ctrl+Shift+C' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+C' : 'Control+Shift+C',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Select all (WS-7.1 frames, P2-B nodes) ──────────────────────────────
  // ONE chord, one row, a ladder of meanings decided by what is selected:
  //   - a node → its siblings (Penpot `select-all`: not hidden, not locked);
  //   - all of those already → climb one level (Figma), up to the frame root;
  //   - the root, or nothing → every frame on the board (WS-7.1).
  // The `node` rung (`useCanvasSelectionKeyboard`) takes the first two and the
  // `board` rung (`useBoardSelectAllShortcut`) the last. With a node selected
  // the keystroke used to reach the BROWSER, which highlighted admin text.
  {
    commandId: 'canvas.selectAll',
    displayName: 'Select all (siblings; again climbs a level; frames when nothing is selected)',
    shortcut: { mac: '⌘A', win: 'Ctrl+A' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+A' : 'Control+A',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'a',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // Arrow keys move the selection (viewport-01 for frames, P2-C / IX-1 for
  // nodes). Virtual id — moving a selection is a canvas gesture, not a
  // palette action.
  //
  // This is the ONE binding in the registry that claims a bare arrow key, and
  // it is scoped by SELECTION rather than by key. Three handlers read it, one
  // per kind of selection, and the editor key ladder decides between them:
  //   - `useBoardAnnotationKeyboard` (annotation rung): selected notes / docs;
  //   - `useCanvasNodeArrowKeys` (node rung): the selected layer — an
  //     absolute one nudges its offsets, a layout child reorders ±1 along its
  //     parent's axis (`canvasNodeArrowMove.ts`). Canvas-scoped like Tab: in
  //     a panel the arrows stay the panel's;
  //   - `useBoardFrameNudge` (board rung): selected board frames.
  // With nothing selected nobody claims them. `ignoreInEditableField` plus
  // each hook's own text-input / overlay guards keep arrows working normally
  // in every input, inspector field, and inline text edit.
  //
  // Direction and step are decoded by `nudgeDelta` below from `event.key` /
  // `event.shiftKey` (1 unit, 10 with Shift) — one binding for the whole
  // gesture, the same shape `layers.delete` uses to match both Delete and
  // Backspace. Alt is excluded so `layers.moveUp/moveDown` keep ⌥↑/⌥↓.
  {
    commandId: 'canvas.moveSelection',
    displayName: 'Move the selection: nudge, or reorder a layout child (Shift for 10)',
    shortcut: { mac: '← ↑ → ↓', win: '← ↑ → ↓' },
    match: (e) =>
      !e.metaKey && !e.ctrlKey && !e.altKey &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown'),
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Group / ungroup (K3) ────────────────────────────────────────────────
  // Figma's own pair, on Figma's own chord. They share a letter and are
  // separated by Shift ALONE, which is why `layers.group` rejects it
  // explicitly — the same discipline `layers.copy` follows against
  // `export.copySelectionPng`.
  //
  // Appended at the END of the registry on purpose: entries are resolved by
  // `getKeybindingForCommand(id)`, never by position, so a new pair goes at
  // the bottom rather than in the middle of a block another change is
  // restructuring.
  {
    commandId: 'layers.group',
    shortcut: { mac: '⌘G', win: 'Ctrl+G' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+G' : 'Control+G',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.ungroup',
    shortcut: { mac: '⌘⇧G', win: 'Ctrl+Shift+G' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+G' : 'Control+Shift+G',
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  ...GESTURE_KEYBINDINGS,
]

/**
 * Units one arrow press moves the selection, and the Shift step: board units
 * for a frame or a note, CSS px for an absolute layer.
 */
export const NUDGE_STEP = 1
export const NUDGE_STEP_LARGE = 10

/**
 * Decode a `canvas.moveSelection` keystroke into a delta, in the units of
 * whatever is being moved. Returns `null` for any event the binding doesn't
 * cover, so the caller can fall through. Lives here (not in a handler) so the
 * registry entry above and its meaning stay in one file — the same reason
 * `layers.redo`'s Ctrl+Y alias lives in its `match` rather than in
 * `UndoRedoButtons.tsx`. A reorder reads only the delta's direction.
 */
export function nudgeDelta(e: KeyEventLike): { dx: number; dy: number } | null {
  const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
  switch (e.key) {
    case 'ArrowLeft': return { dx: -step, dy: 0 }
    case 'ArrowRight': return { dx: step, dy: 0 }
    case 'ArrowUp': return { dx: 0, dy: -step }
    case 'ArrowDown': return { dx: 0, dy: step }
    default: return null
  }
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** Map for O(1) lookup by commandId. Built once at module load time. */
const KEYBINDINGS_MAP = new Map<string, KeybindingDefinition>(
  KEYBINDINGS.map((kb) => [kb.commandId, kb]),
)

/**
 * Returns the keybinding for the given command id, or undefined if no binding
 * is registered for that command.
 */
export function getKeybindingForCommand(commandId: CommandId): KeybindingDefinition | undefined {
  return KEYBINDINGS_MAP.get(commandId)
}
