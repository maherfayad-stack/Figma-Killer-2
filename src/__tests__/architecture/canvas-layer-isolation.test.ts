/**
 * Architecture Gate — the free canvas stays apart (P5-G, design §8 gate 3).
 *
 * A loose layer is scratch: never part of a page, the live preview, a publish
 * or a share. That holds BY CONSTRUCTION — its module lives in `.studio/`, its
 * content in a field no page reader looks at — and each rule below keeps one
 * piece of that construction from quietly eroding:
 *
 *  (a) The path `.studio/canvas` is spelled in exactly one module
 *      (`@core/studio-board`'s `canvasLayers.ts`). A second spelling is a
 *      second, unreviewed way to reach Studio's control plane.
 *  (b) `canvasLayerPages` — the parsed layers — is read only by the free
 *      canvas itself and the few store paths that serve it. A page list, a
 *      publish or an agent tool reading it would put scratch in the app.
 *  (c) `data-studio-canvas-host` — the one Studio box allowed around authored
 *      markup — is rendered only by `CanvasLayerHost.tsx`. Anywhere else it
 *      would be a wrapper between authored elements (the §6.1 trap).
 *  (d) The free-canvas surface never runs the project's code: it never
 *      imports `RuntimeScriptInjector` and passes no `runtimeScripts`.
 *
 * Comments are stripped before (a) and (b) are checked: explaining the rule
 * in prose is not a second implementation of it.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function sourceFiles(): string[] {
  return [...walkSourceTree(join(REPO_ROOT, 'src')), ...walkSourceTree(join(REPO_ROOT, 'server'))].filter((file) => {
    const rel = toRepoRelativePosix(file)
    return !rel.includes('/__tests__/') && !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx')
  })
}

/** Source text with block and line comments removed (a `//` inside a string ends the check early — fail-open only for URLs, which never spell this path). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('canvas-layer isolation (P5-G)', () => {
  it('(a) spells the .studio/canvas path in exactly one module', () => {
    const offenders = sourceFiles()
      .filter((file) => withoutComments(readSource(file)).includes('.studio/canvas'))
      .map(toRepoRelativePosix)
    expect(offenders).toEqual(['src/core/studio-board/canvasLayers.ts'])
  })

  it('(b) reads canvasLayerPages only from the free canvas and the store paths that serve it', () => {
    const allowed = new Set([
      'src/admin/pages/site/store/slices/canvasLayerSlice.ts',
      'src/admin/pages/site/store/slices/canvasLayerGestures.ts',
      'src/admin/pages/site/store/slices/site/structuralSourceHistory.ts',
      'src/admin/pages/site/store/store.ts',
      'src/admin/pages/site/canvas/BoardCanvasLayer/BoardCanvasLayer.tsx',
      'src/admin/pages/site/canvas/BoardCanvasLayer/useCanvasLayerPointer.ts',
    ])
    const readers = sourceFiles()
      .filter((file) => withoutComments(readSource(file)).includes('canvasLayerPages'))
      .map(toRepoRelativePosix)
    expect(readers.filter((file) => !allowed.has(file))).toEqual([])
  })

  it('(c) renders the canvas host box only in CanvasLayerHost.tsx', () => {
    const renderers = sourceFiles()
      .filter((file) => file.endsWith('.tsx') && readSource(file).includes('data-studio-canvas-host='))
      .map(toRepoRelativePosix)
    expect(renderers).toEqual(['src/admin/pages/site/canvas/BoardCanvasLayer/CanvasLayerHost.tsx'])
  })

  it('(d) never mounts runtime scripts in the free-canvas surface', () => {
    const surface = sourceFiles().find((file) => toRepoRelativePosix(file).endsWith('BoardCanvasLayer/CanvasLayerSurface.tsx'))
    expect(surface).toBeDefined()
    const text = readSource(surface!)
    expect(text).not.toContain('RuntimeScriptInjector')
    expect(text).not.toContain('runtimeScripts')
  })
})
