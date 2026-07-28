/**
 * studioWriteback — the `literal` edit kind, and the path guard every edit kind
 * now goes through.
 *
 * The `literal` kind exists because most of an imported app's copy is not in the
 * JSX. `<span>{c.hotelsTag}</span>` renders a dictionary entry two files away,
 * and the JSX is not a writeback target — a string there would delete the i18n
 * binding — so the edit is aimed at the literal, using the location the parser
 * recorded as `PageNode.textOrigin`.
 *
 * The guard is the other half. A save batch arrives from the client with `rel`
 * inside each `nodeId`, and the route builds its target with `join(dir, rel)`, so
 * `../../.ssh/config:1:1` was an arbitrary file write. Nothing legitimate produces
 * one: the parser mints these from `path.relative(workspaceRoot, file)` for files
 * it already found inside the workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEdit, studioEditLocation } from '../studioWriteback'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-writeback-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string): string =>
  fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

describe('studioEditLocation — writable-path guard', () => {
  it('accepts an ordinary workspace-relative source path', () => {
    expect(studioEditLocation('src/screens/Home.jsx:10:5')).toEqual({
      rel: 'src/screens/Home.jsx',
      line: 10,
      col: 5,
    })
  })

  it('accepts a dictionary module, which is where resolved copy lives', () => {
    expect(studioEditLocation('src/i18n/translations.js:142:18')).toEqual({
      rel: 'src/i18n/translations.js',
      line: 142,
      col: 18,
    })
  })

  it('still resolves a composite (inlined) id to the component file', () => {
    expect(studioEditLocation('pages/Home.jsx:77:19~components/Icon.jsx:3:6')).toEqual({
      rel: 'components/Icon.jsx',
      line: 3,
      col: 6,
    })
  })

  it.each([
    ['parent traversal', '../outside.tsx:1:1'],
    ['deep traversal', '../../../etc/passwd:1:1'],
    ['traversal mid-path', 'src/../../escape.tsx:1:1'],
    ['backslash traversal', 'src\\..\\..\\escape.tsx:1:1'],
    ['posix absolute', '/etc/passwd:1:1'],
    ['windows absolute', 'C:/Windows/win.ini:1:1'],
    ['empty segment', 'src/a//b.tsx:1:1'],
  ])('refuses %s', (_label, nodeId) => {
    expect(studioEditLocation(nodeId)).toBeNull()
  })

  it.each([
    ['dotfile config', '.env:1:1'],
    ['manifest', 'package.json:1:1'],
    ['lockfile', 'bun.lock:1:1'],
    ['stylesheet', 'src/app.css:1:1'],
  ])('refuses %s — a writeback belongs on app source only', (_label, nodeId) => {
    expect(studioEditLocation(nodeId)).toBeNull()
  })
})

describe('applyStudioEdit — the literal kind', () => {
  const DICTIONARY = [
    'export const translations = {',
    '  en: {',
    "    hotelsTag: 'Exclusive rates on hotels',",
    '  },',
    '  ar: {',
    "    hotelsTag: 'عروض حصرية',",
    '  },',
    '}',
    '',
  ].join('\n')

  it('rewrites the dictionary entry a resolved text came from', () => {
    write('src/i18n/translations.js', DICTIONARY)

    const applied = applyStudioEdit(tmpDir, {
      kind: 'literal',
      nodeId: 'src/i18n/translations.js:3:16',
      text: 'Members-only hotel rates',
    })

    expect(applied).toBe(true)
    const written = read('src/i18n/translations.js')
    expect(written).toContain("hotelsTag: 'Members-only hotel rates'")
    // The other locale's identically-named key is a different literal.
    expect(written).toContain("hotelsTag: 'عروض حصرية'")
  })

  it('writes nothing for an escaping path, and reports it as a no-op', () => {
    write('src/i18n/translations.js', DICTIONARY)
    const outside = path.join(path.dirname(tmpDir), 'outside.tsx')
    fs.writeFileSync(outside, "export const A = 'keep me'\n", 'utf8')

    try {
      const applied = applyStudioEdit(tmpDir, {
        kind: 'literal',
        nodeId: `../${path.basename(outside)}:1:18`,
        text: 'overwritten',
      })

      expect(applied).toBe(false)
      expect(fs.readFileSync(outside, 'utf8')).toContain('keep me')
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('propagates the codemod refusal when the target is not a literal', () => {
    write('src/consts.ts', 'export const COUNT = 42\n')

    expect(() =>
      applyStudioEdit(tmpDir, { kind: 'literal', nodeId: 'src/consts.ts:1:22', text: 'nope' }),
    ).toThrow()
    expect(read('src/consts.ts')).toContain('42')
  })
})
