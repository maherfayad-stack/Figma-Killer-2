/**
 * UI primitives ownership gate.
 *
 * Reusable editor chrome primitives live in src/ui/components so they can be
 * shared by editor panels, settings, toolbar, and future non-editor surfaces.
 * The old shadcn/Base UI scaffold under src/ui/components/ui is intentionally
 * not used by the app and should not be recreated.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const SRC_ROOT = join(import.meta.dir, '../..')
const UI_COMPONENTS_ROOT = join(SRC_ROOT, 'ui/components')
// 'src/editor' never existed in this repo's tracked history (`git log --all
// -- src/editor` is empty) — every test below that walked EDITOR_ROOT scanned
// zero files since this gate was written. `src/admin/pages/site` is the
// visual editor surface this file's doc comment ("editor panels, settings,
// toolbar") describes; see the identical derivation + evidence in
// canvas-aware-selectors.test.ts.
const EDITOR_ROOT = join(SRC_ROOT, 'admin/pages/site')
// `src/app` ALSO never existed in this repo's tracked history and has no
// current equivalent — there is no top-level "app" surface in this codebase
// (see docs/architecture.md's folder layout: src/admin, src/core, src/modules,
// src/ui). Left as-is rather than guessed at a replacement; the one test that
// reads it (`keeps native color and file inputs...` below) still exercises
// its EDITOR_ROOT half correctly. Flagged in the test-engineer handoff as an
// unresolved intent — needs a decision from whoever knows what this root was
// meant to cover (a since-removed public-site renderer surface, most likely).

const REQUIRED_PRIMITIVES = [
  'Button/Button.tsx',
  'Button/Button.module.css',
  'Input/Input.tsx',
  'Input/Input.module.css',
  'Select/Select.tsx',
  'Select/Select.module.css',
  'Switch/Switch.tsx',
  'Switch/Switch.module.css',
  'Checkbox/Checkbox.tsx',
  'Checkbox/Checkbox.module.css',
  'Separator/Separator.tsx',
  'Separator/Separator.module.css',
  'ColorInput/ColorInput.tsx',
  'ColorInput/ColorInput.module.css',
  'FileUpload/FileUpload.tsx',
  'FileUpload/FileUpload.module.css',
]

// Comment stripper — preserves line numbers by replacing non-newline chars
// inside comments with spaces (same approach as canvas-aware-selectors.test.ts /
// db-postgres-isms.test.ts). Needed for the "keeps native color and file
// inputs..." scan below: without it, a doc comment merely MENTIONING
// `<input type="color">` (e.g. TokenizedColorField.tsx's T8 note explaining
// why the swatch stopped being a native color input) reads as a false
// violation even though the file doesn't render one.
const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

function collectTSXFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTSXFiles(full))
    } else if (extname(entry) === '.tsx') {
      results.push(full)
    }
  }

  return results
}

describe('UI primitives location', () => {
  it('keeps reusable primitives in src/ui/components', () => {
    const missing = REQUIRED_PRIMITIVES.filter(
      (file) => !existsSync(join(UI_COMPONENTS_ROOT, file)),
    )

    expect(missing).toEqual([])
  })

  it('does not keep the old editor-local Button primitive', () => {
    expect(existsSync(join(EDITOR_ROOT, 'components/ui/Button/Button.tsx'))).toBe(false)
  })

  it('does not keep unused shadcn-style primitives under src/ui/components/ui', () => {
    expect(existsSync(join(UI_COMPONENTS_ROOT, 'ui'))).toBe(false)
  })

  it('imports shared Button from @ui/components instead of editor-relative paths', () => {
    const violations: string[] = []

    for (const file of collectTSXFiles(EDITOR_ROOT)) {
      const source = readFileSync(file, 'utf-8')
      if (/from ['"].*\/ui\/Button['"]/.test(source)) {
        violations.push(toPosixPath(relative(EDITOR_ROOT, file)))
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps native color and file inputs inside shared UI components', () => {
    const roots = [join(SRC_ROOT, 'app'), EDITOR_ROOT]
    const violations: string[] = []

    for (const root of roots) {
      for (const file of collectTSXFiles(root)) {
        const source = stripComments(readFileSync(file, 'utf-8'))
        if (/<input[\s\S]*type=["'](?:color|file)["']/.test(source)) {
          violations.push(toPosixPath(relative(SRC_ROOT, file)))
        }
      }
    }

    expect(violations).toEqual([])
  })
})
