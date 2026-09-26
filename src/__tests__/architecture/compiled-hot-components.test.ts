/**
 * The canvas's hot components are compiled by the React Compiler — and stay
 * compiled.
 *
 * CLAUDE.md bans manual memoization because "the React Compiler memoizes every
 * component". It does not, silently: when the compiler meets a construct it
 * cannot lower it skips the whole function, emits it unchanged, and reports
 * nothing a build or `bun run lint` fails on (the lint plugin parses with its
 * own Babel and sees no problem). With this repo's toolchain —
 * `babel-plugin-react-compiler` 1.0 on Babel 8 — the commonest such construct
 * is a default inside a destructured parameter (`{ editable = true }`), which
 * the compiler rejects as "Expected object property value to be an LVal, got:
 * AssignmentPattern". P6-C measured ~315 functions in ~170 files skipped that
 * way; `CanvasRoot` was one of them, so its context values were rebuilt on
 * every render and every click and keystroke re-rendered the selection chrome
 * of every mounted frame.
 *
 * This compiles the listed files with the same Babel and the same compiler
 * plugin Vite runs (`vite.config.ts`: `@rolldown/plugin-babel` with
 * `reactCompilerPreset`) and asserts each named function reports
 * `CompileSuccess`. A new default parameter, a `try … finally`, a `++` on a
 * captured variable in any of them fails here, naming the reason.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from '@babel/core'

const ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * File (from the repo root) -> the functions in it that must compile. Each is
 * rendered once per mounted frame or on every store change.
 *
 * NOT listed, because they do not compile today (P6-C's "Found, not fixed"):
 * `NodeRenderer` (the compiler throws an internal invariant, "Expected a node
 * for all identifiers", on it — its manual `memo()` is the only bailout it
 * has), and `BreakpointFrame`, `IframeFrameSurface` and
 * `BreakpointSelectionOverlay` (defaults in destructured props). Add each here
 * once it compiles.
 */
const HOT: Record<string, readonly string[]> = {
  'src/admin/pages/site/canvas/CanvasRoot.tsx': ['CanvasRoot'],
  'src/admin/pages/site/canvas/CanvasSelectionChrome.tsx': ['CanvasSelectionChrome'],
  'src/admin/pages/site/canvas/MeasureLayer.tsx': ['MeasureLayer'],
  'src/admin/pages/site/canvas/CanvasDropIndicators.tsx': ['CanvasDropIndicators'],
  'src/admin/pages/site/canvas/ClassStyleInjector.tsx': ['ClassStyleInjector', 'ForcedStatePreviewStyle'],
  'src/admin/pages/site/canvas/BoardFramesLayer/BoardFrameView.tsx': ['BoardFrameViewImpl'],
  'src/admin/pages/site/canvas/BoardFramesLayer/BoardFramesLayer.tsx': ['BoardFramesLayer'],
  'src/admin/pages/site/hooks/useCanvas.ts': ['useCanvas'],
}

interface CompilerEvent {
  kind: string
  fnName?: string | null
  detail?: { options?: { reason?: string } }
}

function compileEvents(file: string): CompilerEvent[] {
  const events: CompilerEvent[] = []
  transformSync(readFileSync(join(ROOT, file), 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    // Exactly what `@rolldown/plugin-babel` hands Babel: the source parsed as
    // TypeScript (+ JSX for .tsx), and the compiler as the only plugin.
    parserOpts: { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
    plugins: [
      ['babel-plugin-react-compiler', { panicThreshold: 'none', logger: { logEvent: (_file: string, event: CompilerEvent) => events.push(event) } }],
    ],
  })
  return events
}

describe('the canvas hot path is compiled by the React Compiler', () => {
  for (const [file, names] of Object.entries(HOT)) {
    it(`${file}: ${names.join(', ')}`, () => {
      const events = compileEvents(file)
      const compiled = new Set(events.filter((e) => e.kind === 'CompileSuccess').map((e) => e.fnName))
      const reasons = events.filter((e) => e.kind === 'CompileError').map((e) => e.detail?.options?.reason ?? 'unknown')
      for (const name of names) {
        expect(compiled.has(name), `${name} was not compiled; the compiler said: ${reasons.join(' | ') || '(nothing)'}`).toBe(true)
      }
    })
  }
})
