/**
 * Architecture Gate — the canvas has ONE keyboard dispatcher (`K1`).
 *
 * Its sibling, `keybindings-registry-single-source.test.ts`, gates WHAT a
 * shortcut is (every chord comes from `keybindings.ts`). This one gates WHO
 * hears it.
 *
 * Before `K1` the editor workspace owned 21 `keydown` listeners, nine of them
 * persistent parent-`document` shortcut listeners that each re-implemented the
 * same four guards. Which one won a shared keystroke was decided by mount
 * order — so moving a hook call inside `CanvasRoot` could silently change
 * whether Delete removed a prototype connector or the element underneath it,
 * and three separate docblocks had to describe the resulting ordering in prose.
 *
 * The rule now: under `src/admin/pages/site/canvas/`, exactly one file may
 * attach a `keydown` listener for the shortcut layer — `useEditorKeyDispatcher`
 * — plus a short, justified allowlist of listeners that are NOT the shortcut
 * layer (the iframe bridge, and listeners that exist only for the duration of
 * an in-flight gesture). Everything else registers a scope handler with
 * `editorKeyDispatcher.ts`.
 *
 * The allowlist is asserted for EQUALITY, not containment: removing one of
 * these without updating the list fails too, so the list cannot rot into a
 * description of a tree that has moved on.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const SITE_DIR = join(import.meta.dir, '../../admin/pages/site')
const CANVAS_DIR = join(SITE_DIR, 'canvas')

/** The one file allowed to own the editor's shortcut keydown listener. */
const DISPATCHER = 'useEditorKeyDispatcher.ts'

/**
 * Listeners under `canvas/` that are deliberately NOT on the ladder, with the
 * reason each one is exempt. All of them are either in a DIFFERENT DOCUMENT
 * (an iframe realm the parent dispatcher cannot reach) or bound only while a
 * specific gesture is in flight — neither is a standing shortcut whose
 * precedence against other shortcuts could drift.
 */
const ALLOWED_NON_DISPATCHER_LISTENERS: ReadonlyMap<string, string> = new Map([
  [
    'useIframeEventForwarding.ts',
    'The bridge itself: listens in the FRAME iframe document and re-dispatches ' +
      'a clone on the parent document, which is how the dispatcher hears a ' +
      'keystroke born inside a frame at all. It also stands the whole layer ' +
      'down during an inline edit by refusing to forward.',
  ],
  [
    'useElementResizeDrag.ts',
    'Escape-cancels an IN-FLIGHT resize drag, bound on the iframe document for ' +
      'the length of that one gesture. A different realm and a different ' +
      'lifetime from the shortcut layer.',
  ],
  [
    'CanvasTreeLadderOverlay.tsx',
    'The Alt-HOLD hover ladder binds Arrow/Enter/Escape in every frame ' +
      'document AND the parent, only while the ladder is actually showing. It ' +
      'claims with preventDefault, which stands the dispatcher down — the ' +
      '"a more local handler already answered" contract.',
  ],
  [
    'BoardCommentsLayer/CommentPin.tsx',
    'Escape aborts an in-flight comment-pin drag. Capture-phase, bound for the ' +
      'length of the drag only.',
  ],
  [
    'BoardCommentsLayer/CommentPlacementLayer.tsx',
    'Escape disarms the comment tool, bound only while the tool is armed — ' +
      'deliberately not global, so it never competes with the many other ' +
      'Escape handlers.',
  ],
  [
    'BoardPrototypeLayer/usePrototypeLinkPick.ts',
    'Escape cancels an in-flight prototype-link pick, bound only while the ' +
      'pick is running.',
  ],
])

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (full.includes('node_modules')) continue
    if (statSync(full).isDirectory()) results.push(...collectTsFiles(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) results.push(full)
  }
  return results
}

/** Any `<something>.addEventListener('keydown'`, in either quote style. */
const KEYDOWN_LISTENER = /addEventListener\(\s*['"]keydown['"]/

/**
 * One filesystem walk for the whole gate. Scoped to the editor workspace
 * (`pages/site/`) rather than all of `src/admin/`: a second mount of the
 * dispatcher, or a rogue canvas keydown listener, can only live here, and
 * walking the full admin tree costs ~30 s on Windows — a gate nobody waits for
 * is a gate nobody runs.
 */
const SITE_SOURCES: ReadonlyArray<{ rel: string; source: string }> = collectTsFiles(SITE_DIR)
  .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
  .map((file) => ({ rel: toPosixPath(relative(SITE_DIR, file)), source: readFileSync(file, 'utf8') }))

function filesAttachingKeydown(): string[] {
  const canvasPrefix = `${toPosixPath(relative(SITE_DIR, CANVAS_DIR))}/`
  const found: string[] = []
  for (const { rel, source } of SITE_SOURCES) {
    if (!rel.startsWith(canvasPrefix)) continue
    const hit = source.split('\n').some((line) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
      return KEYDOWN_LISTENER.test(line)
    })
    if (hit) found.push(rel.slice(canvasPrefix.length))
  }
  return found.sort()
}

describe('Canvas keyboard — one dispatcher', () => {
  it('attaches exactly one shortcut keydown listener, plus the justified exemptions', () => {
    const expected = [DISPATCHER, ...ALLOWED_NON_DISPATCHER_LISTENERS.keys()].sort()
    expect(filesAttachingKeydown()).toEqual(expected)
  })

  it('every exemption states why it is not on the ladder', () => {
    for (const [file, reason] of ALLOWED_NON_DISPATCHER_LISTENERS) {
      expect(reason.length).toBeGreaterThan(40)
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(true)
    }
  })

  it('the dispatcher is mounted exactly once, in SitePage', () => {
    const mounts = SITE_SOURCES
      .filter(({ rel, source }) =>
        rel !== 'canvas/useEditorKeyDispatcher.ts' && /useEditorKeyDispatcher\(\)/.test(source))
      .map(({ rel }) => rel)
    expect(mounts).toEqual(['SitePage.tsx'])
  })

  it('the precedence ladder is the one the plan specifies', () => {
    // The order IS the contract — reordering it silently changes which
    // selection a shared Delete acts on.
    const src = readFileSync(join(CANVAS_DIR, 'editorKeyDispatcher.ts'), 'utf8')
    const match = src.match(/EDITOR_KEY_SCOPE_ORDER = \[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const ids = [...match![1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(ids).toEqual(['inline-edit', 'prototype-link', 'annotation', 'node', 'board', 'global'])
  })
})
