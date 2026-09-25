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
 * The rule now: under `src/admin/pages/site/canvas/` AND `hooks/`, exactly one
 * file may attach a `keydown` listener for the shortcut layer —
 * `useEditorKeyDispatcher` — plus a short, justified allowlist of listeners
 * that are NOT the shortcut layer (the iframe bridge, and listeners that exist
 * only for the duration of an in-flight gesture). Everything else registers a
 * scope handler with `editorKeyDispatcher.ts`.
 *
 * `hooks/` joined the scan in P2-B (IX-15): the gate used to read `canvas/`
 * only, and `hooks/useCanvas.ts` carried three key paths beside the
 * dispatcher — a Space listener, a ⌘0 listener and a React `onKeyDown` for
 * the zoom keys — that it never saw. A hook that hands a key handler back for
 * someone else to bind is caught by its own test below.
 *
 * The allowlist is asserted for EQUALITY, not containment: removing one of
 * these without updating the list fails too, so the list cannot rot into a
 * description of a tree that has moved on.
 */

import { describe, it, expect } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'
import { readFileSync } from 'fs'
import { join, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const SITE_DIR = join(import.meta.dir, '../../admin/pages/site')
const CANVAS_DIR = join(SITE_DIR, 'canvas')
/** Every directory whose `keydown` listeners this gate accounts for, relative to `SITE_DIR`. */
const SCANNED_DIRS = ['canvas', 'hooks'] as const

/** The one file allowed to own the editor's shortcut keydown listener. */
const DISPATCHER = 'canvas/useEditorKeyDispatcher.ts'

/**
 * Listeners under `canvas/` that are deliberately NOT on the ladder, with the
 * reason each one is exempt. All of them are either in a DIFFERENT DOCUMENT
 * (an iframe realm the parent dispatcher cannot reach) or bound only while a
 * specific gesture is in flight — neither is a standing shortcut whose
 * precedence against other shortcuts could drift.
 */
const ALLOWED_NON_DISPATCHER_LISTENERS: ReadonlyMap<string, string> = new Map([
  [
    'canvas/useIframeEventForwarding.ts',
    'The bridge itself: listens in the FRAME iframe document and re-dispatches ' +
      'a clone on the parent document, which is how the dispatcher hears a ' +
      'keystroke born inside a frame at all. It also stands the whole layer ' +
      'down during an inline edit by refusing to forward.',
  ],
  [
    'canvas/useElementResizeDrag.ts',
    'Escape-cancels an IN-FLIGHT resize drag, bound on the iframe document for ' +
      'the length of that one gesture. A different realm and a different ' +
      'lifetime from the shortcut layer.',
  ],
  [
    'canvas/useSpacingHandleDrag.ts',
    'P5-E (IX-17) — the padding / gap handle drag: ⇧ / ⌥ change which sides it writes and Escape cancels it, bound on the frame document AND the parent for the length of that one gesture only — the same exemption as the resize drag, for its sibling handles.',
  ],
  [
    'canvas/CanvasTreeLadderOverlay.tsx',
    'The Alt-HOLD hover ladder binds Arrow/Enter/Escape in every frame ' +
      'document AND the parent, only while the ladder is actually showing. It ' +
      'claims with preventDefault, which stands the dispatcher down — the ' +
      '"a more local handler already answered" contract.',
  ],
  [
    'canvas/BoardCommentsLayer/CommentPin.tsx',
    'Escape aborts an in-flight comment-pin drag. Capture-phase, bound for the ' +
      'length of the drag only.',
  ],
  [
    'canvas/BoardCommentsLayer/CommentPlacementLayer.tsx',
    'Escape disarms the comment tool, bound only while the tool is armed — ' +
      'deliberately not global, so it never competes with the many other ' +
      'Escape handlers.',
  ],
  [
    'canvas/BoardPrototypeLayer/usePrototypeLinkPick.ts',
    'Escape cancels an in-flight prototype-link pick, bound only while the ' +
      'pick is running.',
  ],
  [
    'canvas/MeasureLayer.tsx',
    'K5 Alt-hover measurement tracks the Alt KEY ITSELF, on the parent document AND every frame document, only while a selection exists. It is a modifier gesture, not a chord: it claims no key, prevents no default and cannot shadow a shortcut — `canvas.measureHover` is in `keybindings.ts` with `match: () => false` purely so the `?` sheet lists it.',
  ],
  [
    'canvas/useCanvasReorderDrag.ts',
    'S2 — Shift constrains the axis and Escape abandons the drag, read by the session that owns the pointer, bound for the length of that one gesture. A cancel must be handled by the session and by nothing else, which is exactly the in-flight-gesture exemption above.',
  ],
  [
    'canvas/BoardCanvasLayer/useCanvasLayerPointer.ts',
    'P5-G — Escape abandons a loose-layer drag on the free canvas and puts every layer back, bound only for the length of that one gesture: the same in-flight-gesture exemption as the element and frame drags.',
  ],
  [
    'canvas/BoardFramesLayer/useBoardFrameMoveDrag.ts',
    'K2 — the same Shift/Escape pair for the frame HEADER drag, bound for the length of that gesture. Separate from the element drag because a frame copy is a `boards.json` object rather than a source write.',
  ],
  [
    'canvas/usePrototypePlayTriggers.ts',
    'P7 — the `key` prototype trigger, bound on the parent document only while the PLAYER is armed. Play is not the editing surface the scope ladder arbitrates: no editor shortcut is live there, and the listener unmounts the moment Play does.',
  ],
  [
    'hooks/usePersistence.ts',
    "⌘S is a WINDOW-level admin-shell shortcut that must survive an inline text edit (saving mid-edit is the point), which the ladder's `inline-edit` rung would halt. `editorKeyDispatcher.ts` names it as deliberately off the ladder, beside ⌘K.",
  ],
])

const collectTsFiles = (dir: string): string[] => walkSourceTree(dir, ['.ts', '.tsx'])

/** Any `<something>.addEventListener('keydown'`, in either quote style. */
const KEYDOWN_LISTENER = /addEventListener\(\s*['"]keydown['"]/

/**
 * A hook that RETURNS a React key handler for someone else to bind — the shape
 * `useCanvas`'s `handleKeyDown` had. It is a key path exactly as much as a
 * listener is, and focus-scoped besides (`board-02`, `select-01`).
 */
const RETURNED_KEY_HANDLER = /^\s*handleKey(?:Down|Up),?\s*$/

/**
 * One filesystem walk for the whole gate. Scoped to the editor workspace
 * (`pages/site/`) rather than all of `src/admin/`: a second mount of the
 * dispatcher, or a rogue canvas keydown listener, can only live here, and
 * walking the full admin tree costs ~30 s on Windows — a gate nobody waits for
 * is a gate nobody runs.
 */
const SITE_SOURCES: ReadonlyArray<{ rel: string; source: string }> = collectTsFiles(SITE_DIR)
  .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
  .map((file) => ({ rel: toPosixPath(relative(SITE_DIR, file)), source: readSource(file) }))

function isScanned(rel: string): boolean {
  return SCANNED_DIRS.some((dir) => rel.startsWith(`${dir}/`))
}

function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trimStart()
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
  })
}

function filesAttachingKeydown(): string[] {
  const found: string[] = []
  for (const { rel, source } of SITE_SOURCES) {
    if (!isScanned(rel)) continue
    if (codeLines(source).some((line) => KEYDOWN_LISTENER.test(line))) found.push(rel)
  }
  return found.sort()
}

describe('Canvas keyboard — one dispatcher', () => {
  it('attaches exactly one shortcut keydown listener, plus the justified exemptions', () => {
    const expected = [DISPATCHER, ...ALLOWED_NON_DISPATCHER_LISTENERS.keys()].sort()
    expect(filesAttachingKeydown()).toEqual(expected)
  })

  it('no hook under hooks/ hands out a React key handler for the canvas to bind', () => {
    const offenders = SITE_SOURCES
      .filter(({ rel }) => rel.startsWith('hooks/'))
      .filter(({ source }) => codeLines(source).some((line) => RETURNED_KEY_HANDLER.test(line)))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('every exemption states why it is not on the ladder', () => {
    for (const [file, reason] of ALLOWED_NON_DISPATCHER_LISTENERS) {
      expect(reason.length).toBeGreaterThan(40)
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(true)
      expect(isScanned(file)).toBe(true)
    }
  })

  it('the dispatcher is mounted exactly once, in SitePage', () => {
    const mounts = SITE_SOURCES
      .filter(({ rel, source }) =>
        rel !== 'canvas/useEditorKeyDispatcher.ts' && /useEditorKeyDispatcher\(\)/.test(source))
      .map(({ rel }) => rel)
    expect(mounts).toEqual(['SitePage.tsx'])
  })

})

/** Any `<something>.addEventListener('copy' | 'cut' | 'paste'`, in either quote style. */
const CLIPBOARD_LISTENER = /addEventListener\(\s*['"](?:copy|cut|paste)['"]/

/**
 * P5-A — the clipboard has ONE bridge (`canvasClipboardBridge.ts`), for the
 * same reason the keyboard has one dispatcher: two `paste` listeners on one
 * document would each read the clipboard and each insert what they found, and
 * which one won would depend on mount order. The bridge is installed on the
 * editor's own document and on every portal frame's, and nowhere else.
 */
describe('Canvas clipboard — one bridge', () => {
  it('only the bridge attaches copy / cut / paste listeners anywhere in the editor workspace', () => {
    const found = SITE_SOURCES
      .filter(({ source }) => codeLines(source).some((line) => CLIPBOARD_LISTENER.test(line)))
      .map(({ rel }) => rel)
    expect(found).toEqual(['canvas/canvasClipboardBridge.ts'])
  })

  it('the bridge is installed by the editor-document hook and the per-frame forwarding, and nothing else', () => {
    const installers = SITE_SOURCES
      .filter(({ rel, source }) => rel !== 'canvas/canvasClipboardBridge.ts' && /installCanvasClipboardBridge\(/.test(source))
      .map(({ rel }) => rel)
      .sort()
    expect(installers).toEqual(['canvas/useCanvasClipboardBridge.ts', 'canvas/useIframeEventForwarding.ts'])
  })

  it('⌘C / ⌘X / ⌘V never preventDefault their keydown — that would cancel the clipboard event', () => {
    const src = readFileSync(join(CANVAS_DIR, 'useCanvasNodeShortcuts.ts'), 'utf8')
    for (const command of ['layers.copy', 'layers.cut', 'layers.paste']) {
      const start = src.indexOf(`getKeybindingForCommand('${command}')`)
      expect(start).toBeGreaterThan(-1)
      const branch = src.slice(start, src.indexOf('return true', start))
      expect(codeLines(branch).join(' ')).not.toContain('preventDefault')
    }
  })

  it('the spotlight capture listener leaves ⌘C / ⌘X / ⌘V to the node rung', () => {
    const src = readFileSync(join(SITE_DIR, '../../spotlight/shortcutDispatch.ts'), 'utf8')
    const owned = src.slice(src.indexOf('COMPONENT_OWNED_SHORTCUTS'), src.indexOf('])'))
    for (const command of ['layers.copy', 'layers.cut', 'layers.paste']) expect(owned).toContain(`'${command}'`)
  })
})

describe('Canvas keyboard — ladder order', () => {
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
