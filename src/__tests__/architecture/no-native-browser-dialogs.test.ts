import { describe, expect, it } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'

import { join, relative } from 'node:path'

const SRC_ROOT = join(import.meta.dir, '../..')
const SCAN_ROOTS = [
  join(SRC_ROOT, 'admin'),
  join(SRC_ROOT, 'core'),
  join(SRC_ROOT, 'ui'),
]

const NATIVE_DIALOG_RE = /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g

const collectFiles = (dir: string): string[] => walkSourceTree(dir, ['.ts', '.tsx'])

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('native browser dialogs are not used in production app code', () => {
  it('uses app-owned dialogs instead of alert/confirm/prompt', () => {
    const offenders: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectFiles(root)) {
        const stripped = stripComments(readSource(filePath))
        const lines = stripped.split('\n')
        lines.forEach((line, index) => {
          NATIVE_DIALOG_RE.lastIndex = 0
          if (NATIVE_DIALOG_RE.test(line)) {
            offenders.push(
              `  ${relative(SRC_ROOT, filePath)}:${index + 1} -> ${line.trim().slice(0, 120)}`,
            )
          }
        })
      }
    }

    expect(offenders).toEqual([])
  })
})
