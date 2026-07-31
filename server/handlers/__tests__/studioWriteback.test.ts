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
import { applyStudioEdit, applyStudioEditBatch, isSharedSourceNodeId, studioEditLocation } from '../studioWriteback'

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

    expect(applied.applied).toBe(true)
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

      expect(applied.applied).toBe(false)
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

describe('applyStudioEdit — the tag kind', () => {
  it('renames the element instead of adding a tag attribute', () => {
    // The editor's `tag` property is synthesized from the element NAME, so the
    // old attribute route wrote `tag="section"` and left it a `<div>`.
    write('src/screens/Home.jsx', 'export default () => (\n  <div className="c">Hi</div>\n)\n')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'tag',
      nodeId: 'src/screens/Home.jsx:2:4',
      tag: 'section',
    })

    expect(applied.applied).toBe(true)
    const written = read('src/screens/Home.jsx')
    expect(written).toContain('<section className="c">Hi</section>')
    expect(written).not.toContain('tag=')
  })

  it('refuses a name that is not a plain HTML tag', () => {
    const source = 'export default () => <div>Hi</div>\n'
    write('src/screens/Home.jsx', source)

    expect(() =>
      applyStudioEdit(tmpDir, {
        kind: 'tag',
        nodeId: 'src/screens/Home.jsx:1:23',
        tag: 'div onClick={steal}',
      }),
    ).toThrow()
    expect(read('src/screens/Home.jsx')).toBe(source)
  })

  it('writes nothing for an escaping path', () => {
    expect(
      applyStudioEdit(tmpDir, { kind: 'tag', nodeId: '../outside.tsx:1:1', tag: 'section' }).applied,
    ).toBe(false)
  })
})

describe('applyStudioEdit — the asset kind (WS-8.3)', () => {
  it('rewrites the import specifier to a relative path reaching the new asset', () => {
    write('src/pages/Home.tsx', "import heroImg from './hero.png'\nexport const x = heroImg\n")
    write('src/pages/hero-2.png', 'binary-ish-content')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'asset',
      nodeId: 'src/pages/Home.tsx:1:21',
      assetPath: 'src/pages/hero-2.png',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/pages/Home.tsx')).toContain("import heroImg from './hero-2.png'")
  })

  it('computes an ascending relative specifier when the new asset lives in a sibling tree', () => {
    write('src/pages/Home.tsx', "import heroImg from './old.png'\n")
    write('assets/uploads/new-hero.png', 'x')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'asset',
      nodeId: 'src/pages/Home.tsx:1:21',
      assetPath: 'assets/uploads/new-hero.png',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/pages/Home.tsx')).toContain("import heroImg from '../../assets/uploads/new-hero.png'")
  })

  it('refuses an assetPath that escapes the workspace', () => {
    write('src/pages/Home.tsx', "import heroImg from './old.png'\n")
    const outside = path.join(path.dirname(tmpDir), 'outside.png')
    fs.writeFileSync(outside, 'x', 'utf8')

    try {
      const applied = applyStudioEdit(tmpDir, {
        kind: 'asset',
        nodeId: 'src/pages/Home.tsx:1:21',
        assetPath: '../outside.png',
      })
      expect(applied.applied).toBe(false)
      expect(read('src/pages/Home.tsx')).toContain("'./old.png'")
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('refuses an assetPath that does not exist on disk', () => {
    write('src/pages/Home.tsx', "import heroImg from './old.png'\n")

    const applied = applyStudioEdit(tmpDir, {
      kind: 'asset',
      nodeId: 'src/pages/Home.tsx:1:21',
      assetPath: 'src/assets/gone.png',
    })

    expect(applied.applied).toBe(false)
    expect(read('src/pages/Home.tsx')).toContain("'./old.png'")
  })

  it('refuses an assetPath through a symlink escaping the workspace', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-writeback-outside-'))
    try {
      fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'x', 'utf8')
      write('src/pages/Home.tsx', "import heroImg from './old.png'\n")
      fs.mkdirSync(path.join(tmpDir, 'src', 'assets'), { recursive: true })
      const link = path.join(tmpDir, 'src', 'assets', 'linked.png')
      try {
        fs.symlinkSync(path.join(outsideDir, 'secret.png'), link, 'file')
      } catch {
        return // symlink creation unsupported/unprivileged in this environment — skip
      }

      const applied = applyStudioEdit(tmpDir, {
        kind: 'asset',
        nodeId: 'src/pages/Home.tsx:1:21',
        assetPath: 'src/assets/linked.png',
      })

      expect(applied.applied).toBe(false)
      expect(read('src/pages/Home.tsx')).toContain("'./old.png'")
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses an assetPath with backslash traversal segments', () => {
    write('src/pages/Home.tsx', "import heroImg from './old.png'\n")

    const applied = applyStudioEdit(tmpDir, {
      kind: 'asset',
      nodeId: 'src/pages/Home.tsx:1:21',
      assetPath: 'src\\..\\..\\outside.png',
    })

    expect(applied.applied).toBe(false)
  })

  it('writes nothing for an escaping nodeId, same guard every other kind gets', () => {
    expect(
      applyStudioEdit(tmpDir, { kind: 'asset', nodeId: '../outside.tsx:1:1', assetPath: 'src/x.png' }).applied,
    ).toBe(false)
  })
})

/**
 * `sharedComponents` in the save response is what tells the client its OTHER
 * frames went stale. Miss a case and the user edits a shared nav, sees it
 * change on the frame they're looking at, and every other frame quietly keeps
 * rendering markup that no longer matches disk — the exact silent divergence
 * between canvas and source this codebase refuses to ship.
 */
/**
 * The `insert` edit kind — adding a design-system component from the canvas
 * picker. `nodeId` names the CONTAINER, not the new element: the element has
 * no location until this write gives it one, which is what lets the editor
 * skip minting a canvas node at all.
 */
describe('applyStudioEdit — the insert kind', () => {
  const HOME = `import { Chip } from '@alm-design/design-system'

export default function Home() {
  return (
    <section className="wrap">
      <Chip label="a" />
    </section>
  )
}
`

  it('writes the element and its import, leaving every other byte alone', () => {
    write('src/Home.tsx', HOME)

    const applied = applyStudioEdit(tmpDir, {
      kind: 'insert',
      nodeId: 'src/Home.tsx:5:6',
      name: 'Button',
      importSpecifier: '@alm-design/design-system',
      props: { label: 'Buy now', variant: 'primary' },
    })

    expect(applied.applied).toBe(true)
    expect(read('src/Home.tsx')).toBe(
      `import { Chip, Button } from '@alm-design/design-system'

export default function Home() {
  return (
    <section className="wrap">
      <Chip label="a" />
      <Button label="Buy now" variant="primary" />
    </section>
  )
}
`,
    )
  })

  it('writes against an anchor sibling when one is given', () => {
    write('src/Home.tsx', HOME)

    applyStudioEdit(tmpDir, {
      kind: 'insert',
      nodeId: 'src/Home.tsx:5:6',
      anchorNodeId: 'src/Home.tsx:6:8',
      position: 'before',
      name: 'Button',
      importSpecifier: '@alm-design/design-system',
    })

    expect(read('src/Home.tsx')).toContain('      <Button />\n      <Chip label="a" />\n')
  })

  it('drops a cross-file anchor and appends, rather than refusing the whole insert', () => {
    // The anchor is a refinement; the container named by `nodeId` is still an
    // honest place to write. Refusing here would lose the user's action over a
    // detail they never expressed.
    write('src/Home.tsx', HOME)

    const applied = applyStudioEdit(tmpDir, {
      kind: 'insert',
      nodeId: 'src/Home.tsx:5:6',
      anchorNodeId: 'src/Other.tsx:3:4',
      position: 'before',
      name: 'Button',
      importSpecifier: '@alm-design/design-system',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/Home.tsx')).toContain('      <Chip label="a" />\n      <Button />\n')
  })

  it('reports a refusal through the batch rather than throwing', () => {
    write('src/Home.tsx', `import { Button } from './ui/Button'\n\nexport default function Home() {\n  return (\n    <section>\n      <Button />\n    </section>\n  )\n}\n`)
    const before = read('src/Home.tsx')

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'insert',
      nodeId: 'src/Home.tsx:5:6',
      name: 'Button',
      importSpecifier: '@alm-design/design-system',
    }])

    expect(result.written).toBe(0)
    expect(result.refusals?.[0]?.reason).toBe('binding-conflict')
    expect(read('src/Home.tsx')).toBe(before)
  })

  it('is always treated as shared — the write shifts every line below it', () => {
    expect(isSharedSourceNodeId('src/Home.tsx:5:6', 'insert')).toBe(true)
  })
})

describe('isSharedSourceNodeId', () => {
  it('flags an inlined component instance', () => {
    expect(isSharedSourceNodeId('pages/Home.tsx:12:5~components/Card.tsx:3:1')).toBe(true)
  })

  it('flags ANY asset edit unconditionally — an import can back more than one JSX usage', () => {
    // A plain, non-inlined, non-chrome id would otherwise read as "not shared".
    expect(isSharedSourceNodeId('src/pages/Home.tsx:1:21', 'asset')).toBe(true)
    // The same id, for a different edit kind, is not inherently shared.
    expect(isSharedSourceNodeId('src/pages/Home.tsx:1:21', 'prop')).toBe(false)
    expect(isSharedSourceNodeId('src/pages/Home.tsx:1:21')).toBe(false)
  })

  it('flags App Router chrome, which one file composes into every route below it', () => {
    expect(isSharedSourceNodeId('app/layout.tsx:4:3')).toBe(true)
    expect(isSharedSourceNodeId('app/blog/layout.tsx:4:3')).toBe(true)
    expect(isSharedSourceNodeId('app/blog/template.jsx:9:1')).toBe(true)
  })

  it('does not flag an ordinary page node, which backs exactly one frame', () => {
    expect(isSharedSourceNodeId('app/blog/first/page.tsx:2:10')).toBe(false)
    expect(isSharedSourceNodeId('pages/Home.tsx:12:5')).toBe(false)
  })

  it('does not flag a file that merely CONTAINS the word layout', () => {
    expect(isSharedSourceNodeId('components/LayoutGrid.tsx:1:1')).toBe(false)
    expect(isSharedSourceNodeId('app/layouts.tsx:1:1')).toBe(false)
  })

  it('does not flag an id with no decodable location', () => {
    expect(isSharedSourceNodeId('index:body')).toBe(false)
    expect(isSharedSourceNodeId('../../.ssh/config:1:1')).toBe(false)
  })
})

/**
 * `panel-02` (WS-6.3) — the `css` edit kind. Unlike every other kind, its
 * target is a FILE + SELECTOR (from `studioCss.ts`'s `StyleRuleSource`), not
 * a `nodeId`-encoded `line:col` — these tests exercise that the dispatch
 * special-case, the containment/extension guard, and the tiered refusal
 * (`classifyStylesheetEditability`) all actually reach the postcss codemod
 * (`setDeclaration`) rather than merely existing in isolation.
 */
describe('applyStudioEdit — the css kind (WS-6.3)', () => {
  it('writes a real declaration change to a plain .css file, preserving the rest byte-for-byte', () => {
    write('src/screens/Home.css', '.hero {\n  color: red;\n  padding: 8px;\n}\n')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/screens/Home.css')).toBe('.hero {\n  color: blue;\n  padding: 8px;\n}\n')
  })

  it('appends a new declaration when the property is absent from the rule', () => {
    write('src/screens/Home.css', '.hero {\n  color: red;\n}\n')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#padding',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'padding',
      value: '4px',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/screens/Home.css')).toBe('.hero {\n  color: red;\n  padding: 4px;\n}\n')
  })

  it('refuses a .module.css target with the classifier’s specific reason, via applyStudioEditBatch', () => {
    write('src/screens/Home.module.css', '.hero {\n  color: red;\n}\n')

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.module.css#.hero#color',
      file: 'src/screens/Home.module.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    }])

    expect(result.written).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'compiled-stylesheet' })
    expect(result.refusals[0]!.message).toContain('CSS Modules')
    // Refused BEFORE any read/write — the file is untouched.
    expect(read('src/screens/Home.module.css')).toBe('.hero {\n  color: red;\n}\n')
  })

  it('refuses a minified build artefact the same way', () => {
    write('dist/style.min.css', '.a{color:red}')

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:dist/style.min.css#.a#color',
      file: 'dist/style.min.css',
      selector: '.a',
      property: 'color',
      value: 'blue',
    }])

    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'compiled-stylesheet' })
    expect(read('dist/style.min.css')).toBe('.a{color:red}')
  })

  it('writes nothing for a path escaping the workspace, same guard every other kind gets', () => {
    const outside = path.join(path.dirname(tmpDir), 'outside.css')
    fs.writeFileSync(outside, '.a { color: red }\n', 'utf8')
    try {
      const applied = applyStudioEdit(tmpDir, {
        kind: 'css',
        nodeId: 'css:../outside.css#.a#color',
        file: '../outside.css',
        selector: '.a',
        property: 'color',
        value: 'blue',
      })
      expect(applied.applied).toBe(false)
      expect(fs.readFileSync(outside, 'utf8')).toContain('red')
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('writes nothing for a non-.css extension — the codemod only understands CSS syntax', () => {
    write('src/screens/Home.scss', '.hero { color: red; }\n')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      nodeId: 'css:src/screens/Home.scss#.hero#color',
      file: 'src/screens/Home.scss',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    })

    expect(applied.applied).toBe(false)
    expect(read('src/screens/Home.scss')).toContain('red')
  })

  it('writes nothing for a target that does not exist on disk', () => {
    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      nodeId: 'css:src/screens/Gone.css#.hero#color',
      file: 'src/screens/Gone.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    })

    expect(applied.applied).toBe(false)
  })

  it('is a no-op — applied true, file unchanged — when the value already matches', () => {
    write('src/screens/Home.css', '.hero {\n  color: blue;\n}\n')

    const applied = applyStudioEdit(tmpDir, {
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    })

    expect(applied.applied).toBe(true)
    expect(read('src/screens/Home.css')).toBe('.hero {\n  color: blue;\n}\n')
  })

  it('a css edit does not mark the batch as touching a shared component', () => {
    write('src/screens/Home.css', '.hero {\n  color: red;\n}\n')

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    }])

    expect(result.written).toBe(1)
    expect(result.sharedComponents).toBe(false)
  })
})

/**
 * `panel-02` — the honest-target gate (`analyzeDeclarationTarget`) reaching
 * the real dispatch, not just its own unit tests. Each case below is a write
 * that WOULD have succeeded at the filesystem level and changed nothing the
 * user could see, because `setDeclaration` targets the FIRST matching rule
 * while the CSS cascade lets the LAST declaration win. A silent no-op is the
 * worst available outcome here, so each one refuses with a reason instead —
 * and, critically, leaves the file byte-identical.
 */
describe('applyStudioEditBatch — css edits refuse rather than write invisibly', () => {
  it('refuses when the selector is declared twice and the later block sets the same property', () => {
    const before = '.hero {\n  color: red;\n}\n\n.hero {\n  color: green;\n}\n'
    write('src/screens/Home.css', before)

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    }])

    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'duplicate-selector' })
    expect(read('src/screens/Home.css')).toBe(before)
  })

  it('refuses when a shorthand later in the same rule would reset the edited longhand', () => {
    const before = '.hero {\n  padding-top: 2px;\n  padding: 0;\n}\n'
    write('src/screens/Home.css', before)

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#padding-top',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'padding-top',
      value: '12px',
    }])

    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'shorthand-override' })
    expect(result.refusals[0]!.message).toContain('padding')
    expect(read('src/screens/Home.css')).toBe(before)
  })

  it('refuses when an !important shorthand outranks the edited longhand from any position', () => {
    const before = '.hero {\n  margin: 0 !important;\n  margin-left: 4px;\n}\n'
    write('src/screens/Home.css', before)

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#margin-left',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'margin-left',
      value: '9px',
    }])

    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'important-override' })
    expect(read('src/screens/Home.css')).toBe(before)
  })

  it('refuses a property declared twice inside one rule', () => {
    const before = '.hero {\n  color: red;\n  color: green;\n}\n'
    write('src/screens/Home.css', before)

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    }])

    expect(result.refusals[0]).toMatchObject({ kind: 'css', reason: 'duplicate-declaration' })
    expect(read('src/screens/Home.css')).toBe(before)
  })

  it('still writes when a duplicate selector exists but does not touch this property', () => {
    write('src/screens/Home.css', '.hero {\n  color: red;\n}\n\n.hero {\n  margin: 0;\n}\n')

    const result = applyStudioEditBatch(tmpDir, [{
      kind: 'css',
      nodeId: 'css:src/screens/Home.css#.hero#color',
      file: 'src/screens/Home.css',
      selector: '.hero',
      property: 'color',
      value: 'blue',
    }])

    expect(result.written).toBe(1)
    expect(result.refusals).toHaveLength(0)
    expect(read('src/screens/Home.css')).toBe('.hero {\n  color: blue;\n}\n\n.hero {\n  margin: 0;\n}\n')
  })

  it('one refusal does not abort the rest of the batch', () => {
    write('src/screens/Bad.css', '.a {\n  color: red;\n  color: green;\n}\n')
    write('src/screens/Good.css', '.b {\n  color: red;\n}\n')

    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'css', nodeId: 'css:a', file: 'src/screens/Bad.css', selector: '.a', property: 'color', value: 'blue' },
      { kind: 'css', nodeId: 'css:b', file: 'src/screens/Good.css', selector: '.b', property: 'color', value: 'blue' },
    ])

    expect(result.written).toBe(1)
    expect(result.refusals).toHaveLength(1)
    expect(read('src/screens/Good.css')).toBe('.b {\n  color: blue;\n}\n')
  })
})
