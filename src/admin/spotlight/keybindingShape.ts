/**
 * keybindingShape — what a keybinding IS (the type), and how one is spelled
 * for a human (the platform-aware label formatter). No bindings in it.
 *
 * Its own module for one concrete reason: `keybindings.ts` spreads
 * `keybindingGestures.ts` into its registry, and the gestures need this
 * type. A type import from `keybindings.ts` would close that loop, and
 * `no-circular-dependencies.test.ts` is right to refuse it — a cycle through
 * a module with top-level array construction is a real initialisation order
 * hazard, not a lint nicety.
 *
 * `keybindings.ts` re-exports all four names, which is where every consumer
 * already imports them from.
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
   * A SECOND keystroke the same `match` accepts, shown alongside `shortcut` in
   * the help sheet.
   *
   * One binding per command is the rule — `HelpKeybindingsList` keys its rows
   * by `commandId`, and two rows for one action is exactly the duplication this
   * registry exists to prevent. But some actions honestly have two keys the
   * user might reach for (`⌥↑` is the a11y-safe reorder, `⌘]` is what a Figma
   * user's hands already know), and a key the sheet does not list is a key
   * nobody discovers. So the alias lives on the binding it belongs to, and the
   * `match` predicate accepts both — the same shape `editor.redo` uses for its
   * Ctrl+Y alias, promoted to something the help screen can render.
   */
  aliasShortcut?: CommandShortcut
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
