/**
 * rewriteImportSpecifier — moving every import of one module onto another,
 * without touching anything else in the file.
 *
 * The property that matters most is the negative one: a codemod that runs over
 * a user's whole repository must come back byte-identical everywhere it had
 * nothing to do. Several tests here assert the full file text rather than a
 * substring, because "it contains the new import" is exactly the assertion
 * that would pass while the rest of the file was reformatted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProject, rewriteImportSpecifier } from '../index'

const FROM = '@alm-design/design-system'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-import-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Writes `source` to a file, rewrites it, and returns the text on disk plus the counts. */
function rewrite(source: string, to = '../design-system', fileName = 'Page.tsx') {
  const file = path.join(tmpDir, fileName)
  fs.writeFileSync(file, source)
  const project = createProject()
  const sourceFile = project.addSourceFileAtPath(file)
  const result = rewriteImportSpecifier(sourceFile, { from: FROM, to })
  sourceFile.saveSync()
  return { text: fs.readFileSync(file, 'utf8'), result }
}

describe('rewriteImportSpecifier', () => {
  it('rewrites a named import and leaves every other byte of the file alone', () => {
    const source = [
      "import { useState } from 'react'",
      `import { Button, Chip } from '${FROM}'`,
      "import styles from './Page.module.css'",
      '',
      'export default function Page() {',
      '  const [open, setOpen] = useState(false)',
      '  return <Button className={styles.a} onClick={() => setOpen(!open)}>Go</Button>',
      '}',
      '',
    ].join('\n')

    const { text, result } = rewrite(source)

    expect(result).toEqual({ rewritten: 1, removed: 0 })
    expect(text).toBe(source.replace(FROM, '../design-system'))
  })

  it('rewrites a default import and a namespace import', () => {
    const { text, result } = rewrite(
      [`import DS from '${FROM}'`, `import * as Everything from '${FROM}'`, 'export const x = [DS, Everything]', ''].join(
        '\n',
      ),
    )

    expect(result).toEqual({ rewritten: 2, removed: 0 })
    expect(text).toContain("import DS from '../design-system'")
    expect(text).toContain("import * as Everything from '../design-system'")
  })

  it('rewrites a sub-path import, dropping the package\'s published `src/` prefix', () => {
    // The folder IS the source, so `<pkg>/src/icons/x.svg` lives at
    // `<folder>/icons/x.svg`. The `?raw` query belongs to the bundler, not to
    // the path, and rides along untouched.
    const { text, result } = rewrite(
      [`import chevron from '${FROM}/src/icons/line-icons/chevron.svg?raw'`, 'export const icon = chevron', ''].join('\n'),
    )

    expect(result).toEqual({ rewritten: 1, removed: 0 })
    expect(text).toContain("import chevron from '../design-system/icons/line-icons/chevron.svg?raw'")
  })

  it('removes the stylesheet side-effect import rather than repointing it', () => {
    // The folder's own `index.js` imports the token CSS, and there is no file
    // at the old path to point at — so this import is deleted, not moved.
    const { text, result } = rewrite(
      [
        "import { useState } from 'react'",
        `import { Button } from '${FROM}'`,
        `import '${FROM}/dist/index.css'`,
        '',
        'export default function Page() { return <Button /> }',
        '',
      ].join('\n'),
    )

    expect(result).toEqual({ rewritten: 1, removed: 1 })
    expect(text).not.toContain('index.css')
    expect(text).toContain("import { Button } from '../design-system'")
    expect(text).toContain("import { useState } from 'react'")
    expect(text).toContain('export default function Page() { return <Button /> }')
  })

  it('never removes a declaration that binds something, whatever its sub-path', () => {
    // Deleting a declaration that introduces a binding is the one thing a
    // codemod over a user's repository may never do.
    const { text, result } = rewrite(
      [`import tokens from '${FROM}/dist/index.css'`, 'export const t = tokens', ''].join('\n'),
    )

    expect(result).toEqual({ rewritten: 1, removed: 0 })
    expect(text).toContain("import tokens from '../design-system'")
  })

  it('maps anything under the built `dist/` to the folder root, which is the only thing that still exists', () => {
    const { text } = rewrite([`import { Button } from '${FROM}/dist/index.js'`, 'export const b = Button', ''].join('\n'))
    expect(text).toContain("import { Button } from '../design-system'")
  })

  it('keeps each file\'s own quote style', () => {
    const { text } = rewrite([`import { Button } from "${FROM}"`, 'export const b = Button', ''].join('\n'))
    expect(text).toContain('import { Button } from "../design-system"')
    expect(text).not.toContain("'../design-system'")
  })

  it('takes whatever depth the caller computed — the file decides, not the codemod', () => {
    const deep = rewrite(
      [`import { Button } from '${FROM}'`, 'export const b = Button', ''].join('\n'),
      '../../design-system',
    )
    expect(deep.text).toContain("import { Button } from '../../design-system'")

    const root = rewrite(
      [`import { Button } from '${FROM}'`, 'export const b = Button', ''].join('\n'),
      './design-system',
    )
    expect(root.text).toContain("import { Button } from './design-system'")
  })

  it('leaves a file with no matching import completely untouched', () => {
    const source = [
      "import { useState } from 'react'",
      "import { Thing } from '@alm-design/other-package'",
      "import x from './alm-design/design-system'",
      'export const y = [useState, Thing, x]',
      '',
    ].join('\n')

    const { text, result } = rewrite(source)

    expect(result).toEqual({ rewritten: 0, removed: 0 })
    expect(text).toBe(source)
  })

  it('rewrites every occurrence, not just the first', () => {
    const { result } = rewrite(
      [
        `import { Button } from '${FROM}'`,
        `import { Chip } from '${FROM}'`,
        `import close from '${FROM}/src/icons/line-icons/close.svg?raw'`,
        `import '${FROM}/dist/index.css'`,
        'export const all = [Button, Chip, close]',
        '',
      ].join('\n'),
    )

    expect(result).toEqual({ rewritten: 3, removed: 1 })
  })

  it('preserves surrounding comments and blank lines', () => {
    const source = [
      '// The design system, imported at the top like every other package.',
      `import { Button } from '${FROM}'`,
      '',
      '/** The page. */',
      'export default function Page() { return <Button /> }',
      '',
    ].join('\n')

    const { text } = rewrite(source)

    expect(text).toBe(source.replace(FROM, '../design-system'))
  })
})
