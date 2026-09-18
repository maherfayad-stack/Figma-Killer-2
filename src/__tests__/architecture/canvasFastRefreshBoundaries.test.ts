import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const SRC_ROOT = join(import.meta.dir, '..', '..')

/** `src/`-relative, because the three fixed targets below read best that way. */
const readSrcRelative = (path: string): string => readSource(join(SRC_ROOT, path))

const collectFiles = (dir: string): string[] =>
  walkSourceTree(dir, ['.tsx']).filter((f) => f.endsWith('Editor.tsx'))

describe('Canvas Fast Refresh boundaries', () => {
  it('keeps component modules free of Fast Refresh suppression comments', () => {
    const files = [
      'admin/pages/site/canvas/ModuleSandboxFrame.tsx',
      'admin/pages/site/canvas/NodeRenderer.tsx',
    ]

    for (const file of files) {
      expect(readSrcRelative(file)).not.toContain('react-refresh/only-export-components')
    }
  })

  it('keeps NodeRenderer exports limited to React components', () => {
    const source = readSrcRelative('admin/pages/site/canvas/NodeRenderer.tsx')

    expect(source).not.toContain('export const CanvasSelectionContext')
    expect(source).not.toContain('export const CanvasBreakpointContext')
    expect(source).not.toContain('export const CanvasTemplateContext')
    expect(source).not.toContain('export function getCanvasNodeClassName')
  })

  it('keeps ModuleSandboxFrame exports limited to React components', () => {
    const source = readSrcRelative('admin/pages/site/canvas/ModuleSandboxFrame.tsx')

    expect(source).not.toContain('export function createSandboxSrcDoc')
  })

  it('keeps base module editors independent of registration barrels', () => {
    const editorFiles = collectFiles(join(SRC_ROOT, 'modules/base'))
    expect(editorFiles.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of editorFiles) {
      const source = readSource(file)
      if (/from ['"]\.\/index['"]/.test(source)) {
        offenders.push(file.replace(`${SRC_ROOT}/`, ''))
      }
    }

    expect(offenders).toEqual([])
  })
})
