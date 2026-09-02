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
 */

import type { CommandId, CommandShortcut } from './types'

// ─── Key event shape ──────────────────────────────────────────────────────────
// Subset of KeyboardEvent that both native KeyboardEvent and React.KeyboardEvent<T>
// satisfy — allows match functions to be called from either context.

export interface KeyEventLike {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly key: string
}

// ─── Binding definition ───────────────────────────────────────────────────────

export interface KeybindingDefinition {
  /**
   * Maps 1:1 to a Command id in the spotlight registry.
   * When no matching command exists (e.g. for 'spotlight.open' itself),
   * `displayName` is used as the fallback title in the help screen.
   */
  commandId: CommandId
  /** Fallback display title used in the help screen when no command matches commandId. */
  displayName?: string
  /** Human-readable shortcut labels rendered in the UI and help screen. */
  shortcut: CommandShortcut
  /**
   * Machine-readable ARIA keyshortcuts attribute value, e.g. "Meta+I".
   * Used on buttons that have an associated aria-keyshortcuts attribute.
   */
  ariaKeyshortcuts?: string
  /** Predicate that returns true when the event matches this binding. */
  match: (e: KeyEventLike) => boolean
  /** Activation scope — handlers gate firing based on this. */
  scope: 'global' | 'editor' | 'canvas' | 'panels'
  /**
   * When true, the binding should NOT fire when focus is inside an
   * input, textarea, or contenteditable. Handlers are responsible for
   * enforcing this — the flag is advisory/documentary.
   */
  ignoreInEditableField?: boolean
  /** Optional capability gate string (not enforced here — advisory only). */
  capability?: string
}

// ─── Platform detection ───────────────────────────────────────────────────────

/** Returns true when running on a macOS / iOS platform. */
export function isPlatformMac(): boolean {
  if (typeof navigator === 'undefined') return false
  // navigator.userAgentData.platform is the modern API (replaces navigator.platform)
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ''
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

// ─── Format shortcut for display ─────────────────────────────────────────────

/**
 * Returns the platform-appropriate shortcut label from a CommandShortcut.
 * Used for button tooltips, aria-label, and help screen rows.
 */
export function formatShortcut(shortcut: CommandShortcut): string {
  return isPlatformMac() ? shortcut.mac : shortcut.win
}

// ─── Registry ─────────────────────────────────────────────────────────────────

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
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c',
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

  // ── Canvas viewport (zoom to fit / selection — D3) ──────────────────────
  // Virtual ids: no matching spotlight Command yet (a discrete viewport
  // action, not a palette-run gesture) — `displayName` is the help-screen
  // fallback title, same pattern as `spotlight.open`/`board.selectAllFrames`.
  {
    commandId: 'canvas.zoomToFit',
    displayName: 'Zoom to fit',
    shortcut: { mac: '⇧1', win: 'Shift+1' },
    ariaKeyshortcuts: 'Shift+1',
    match: (e) => e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '1',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'canvas.zoomToSelection',
    displayName: 'Zoom to selection',
    shortcut: { mac: '⇧2', win: 'Shift+2' },
    ariaKeyshortcuts: 'Shift+2',
    match: (e) => e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '2',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  // ── Layers (keyboard reorder — G12) ──────────────────────────────────────
  // `layers.moveUp`/`layers.moveDown` already exist as spotlight Commands
  // (`spotlight/commands/layers.ts`) but had no keyboard binding — reordering
  // a node required a mouse. Alt+↑/↓ rather than a plain arrow key: plain
  // arrows are free today but are the obvious future home for "select
  // previous/next sibling" (`layers.selectParent`'s siblings, also unbound),
  // and Alt+↑/↓ doesn't collide with `CanvasTreeLadderOverlay`'s Alt-HOLD
  // hover-ladder gesture (that overlay only intercepts Arrow keys while its
  // ladder is actively showing, i.e. Alt held AND hovering a valid node —
  // see its own `handleKeyDown`; a bare Alt+↑ tap while not hovering falls
  // through to this binding untouched).
  {
    // Real spotlight Command (`spotlight/commands/layers.ts`) — no
    // `displayName` needed, the command's own `title` is the help-screen label.
    commandId: 'layers.moveUp',
    shortcut: { mac: '⌥↑', win: 'Alt+↑' },
    ariaKeyshortcuts: 'Alt+ArrowUp',
    match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp',
    scope: 'canvas',
    ignoreInEditableField: true,
  },

  {
    commandId: 'layers.moveDown',
    shortcut: { mac: '⌥↓', win: 'Alt+↓' },
    ariaKeyshortcuts: 'Alt+ArrowDown',
    match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown',
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

  // ── Board (studio frame multi-select — WS-7.1) ──────────────────────────
  // Virtual id: no matching spotlight Command (frame selection isn't a
  // palette action) — `displayName` is the help-screen fallback title, same
  // pattern as `spotlight.open`.
  {
    commandId: 'board.selectAllFrames',
    displayName: 'Select all frames',
    shortcut: { mac: '⌘A', win: 'Ctrl+A' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+A' : 'Control+A',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'a',
    scope: 'canvas',
    ignoreInEditableField: true,
  },
]

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
