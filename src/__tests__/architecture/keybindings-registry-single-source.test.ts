/**
 * Architecture Gate — keybindings registry is the single source of truth.
 *
 * Every keyboard shortcut in src/admin/ that combines a meta/ctrl modifier
 * with a letter/symbol key must be registered in keybindings.ts and handled
 * via `getKeybindingForCommand(id).match(e)`.
 *
 * This test greps for inline key-combo matchers (e.g. `e.metaKey && e.key === 'k'`)
 * that bypass the registry, and fails if it finds any in files outside the allowlist.
 *
 * Its sibling gate, `keybindings-single-dispatcher.test.ts`, covers the other
 * half of the same rule: this file gates WHAT a shortcut is, that one gates WHO
 * hears it (one `keydown` listener under `canvas/`, plus justified exemptions).
 *
 * Allowlisted files — consolidation touchpoints and legitimate exceptions:
 *   - keybindings.ts           — registry itself (defines match functions)
 *   - HelpKeybindingsList.tsx  — reads from registry, renders <kbd> tags
 *   - SpotlightRow.tsx         — reads from registry, renders <kbd> tags
 *   - usePersistence.ts        — uses getKeybindingForCommand().match(e)
 *   - SpotlightRoot.tsx        — uses getKeybindingForCommand().match(e)
 *   - Spotlight.tsx            — ⌘ symbol appears only in a JSDoc comment
 *
 * `CanvasRoot.tsx` and `UndoRedoButtons.tsx` were on this list until `K1` and
 * have been removed: neither matches a chord any more. `useCanvas.ts` followed
 * in P2-B, when its zoom keys moved onto the dispatcher
 * (`useCanvasViewportKeys.ts`, which matches through the registry). CanvasRoot registers
 * scope handlers, and the undo/redo keystroke moved to
 * `useEditorHistoryShortcuts`. A stale allowlist entry is a hole, not a
 * comment — it silently permits a future inline matcher in that file.
 */

import { describe, it, expect } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'

import { join, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const SRC_ROOT = join(import.meta.dir, '../../')
const ADMIN_SRC = join(SRC_ROOT, 'admin')

// ─── Allowlist (relative to SRC_ROOT) ────────────────────────────────────────

const ALLOWLIST = new Set([
  // The registry — allowed to contain match functions and shortcut strings
  'admin/spotlight/keybindings.ts',
  // Renderers — allowed to render <kbd> from registry data
  'admin/spotlight/HelpKeybindingsList.tsx',
  'admin/spotlight/SpotlightRow.tsx',
  // ⌘ symbol appears only in a JSDoc comment, not JSX output
  'admin/spotlight/Spotlight.tsx',
  // Handlers that use getKeybindingForCommand().match(e)
  'admin/pages/site/hooks/usePersistence.ts',
  'admin/spotlight/SpotlightRoot.tsx',
  // Canvas-specific zoom/pan shortcuts (Ctrl+0, f, 1, 2) — not global commands.
  // These are canvas viewport controls that don't belong in the palette registry.
])

const collectTsFiles = (dir: string): string[] => walkSourceTree(dir, ['.ts', '.tsx'])

/**
 * Strips single-line comments (//) from source before pattern testing
 * so that e.g. `// (first ⌘K)` in a JSDoc block doesn't false-positive.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      // Remove everything from the first '//' that isn't inside a string.
      // Simple heuristic: if the line (trimmed) starts with '*' or '//',
      // it's a comment line — strip it entirely.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''
      return line
    })
    .join('\n')
}

/**
 * Patterns that indicate an inline key-combo matcher bypassing the registry.
 *
 * We only flag POSITIVE modifier checks (e.metaKey || e.ctrlKey) combined
 * with an e.key check for a single-character key. This excludes:
 *   - Negated modifiers: !(e.metaKey ...) or !e.ctrlKey
 *   - Long key names: 'Escape', 'Enter', 'Tab', 'ArrowUp', etc.
 *   - ShiftKey-only patterns (Enter+Shift for multiline textarea, etc.)
 *
 * The pattern requires:
 *   1. A POSITIVE e.metaKey or e.ctrlKey reference (not preceded by `!`)
 *   2. Followed (within 80 chars) by e.key === 'X' where X is a single char
 */
const INLINE_MATCHER_PATTERN =
  /(?<![!|(])e\.(metaKey|ctrlKey)\b.{0,80}\be\.key\s*===?\s*['"][a-zA-Z0-9,./;\\]['"]/

/**
 * Reverse pattern: e.key check followed by a POSITIVE modifier.
 */
const INLINE_MATCHER_PATTERN_REVERSED =
  /\be\.key\s*===?\s*['"][a-zA-Z0-9,./;\\]['"].{0,80}(?<![!|(])e\.(metaKey|ctrlKey)\b/

describe('Keybindings registry — single source of truth', () => {
  it('admin/ files do not contain inline key-combo matchers (metaKey/ctrlKey+letter) outside the allowlist', () => {
    const files = collectTsFiles(ADMIN_SRC)
    const violations: string[] = []

    for (const file of files) {
      const rel = toPosixPath(relative(SRC_ROOT, file))
      if (ALLOWLIST.has(rel)) continue

      const rawSource = readSource(file)
      // Check line by line to avoid cross-line false positives and skip comment lines.
      const lines = rawSource.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()

        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        if (INLINE_MATCHER_PATTERN.test(line) || INLINE_MATCHER_PATTERN_REVERSED.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
          break // one violation per file is enough
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[keybindings-registry] Inline key-combo matchers found outside the registry.\n' +
          'Add your shortcut to src/admin/spotlight/keybindings.ts and use\n' +
          'getKeybindingForCommand(commandId).match(e) in the handler instead.\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('admin/ TSX files do not render hand-written ⌘/⌃/⌥/⇧ shortcut symbols outside the allowlist', () => {
    const files = collectTsFiles(ADMIN_SRC)
    const violations: string[] = []

    // Pattern: modifier symbol inside what looks like JSX text content or a
    // JSX attribute string value. We only check .tsx files (not .ts logic files).
    //
    // Match: a modifier symbol appearing in a JSX attribute value or text content:
    //   tooltip="Save (⌘S)"         → should flag
    //   <span>⌘S</span>             → should flag
    //   // comment with ⌘K          → should NOT flag (comment line)
    //   * JSDoc with ⌘K             → should NOT flag (comment line)
    const SHORTCUT_SYMBOL_RE = /[⌘⌥⌃⇧]/

    for (const file of files) {
      if (!file.endsWith('.tsx')) continue

      const rel = toPosixPath(relative(SRC_ROOT, file))
      if (ALLOWLIST.has(rel)) continue

      const lines = readSource(file).split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()

        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        if (SHORTCUT_SYMBOL_RE.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
          break
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[keybindings-registry] Hand-written shortcut symbols (⌘, ⌃, ⌥, ⇧) found in TSX outside renderers.\n' +
          'Use formatShortcut(getKeybindingForCommand(id).shortcut)\n' +
          'to get the platform-aware label from the registry.\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
