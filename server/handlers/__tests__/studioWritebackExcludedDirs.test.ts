/**
 * P1-G — no Studio writer may land in a directory Studio owns or that is not
 * the user's source: `.studio`, `.git`, `node_modules`, `dist`, `.next`,
 * `.turbo`, `.claude` (`UNWRITABLE_WORKSPACE_DIR_NAMES`).
 *
 * Before this, `isWritableSourceRel` checked path SHAPE only, so a nodeId of
 * `.studio/anything.tsx:1:1` decoded to a valid writeback target for every
 * edit kind (value, structural, a transplant's destination, MCP
 * `studio_apply_edits`/`studio_codemod`); and the CSS and asset writers
 * checked the exclusion list on the TEXTUAL path only, so a symlink spelled
 * like source (`styles -> .studio`) carried the write through.
 *
 * Every test drives one writer with adversarial input and asserts on the
 * bytes on disk — the honest oracle — not only on the returned counters.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { UNWRITABLE_WORKSPACE_DIR_NAMES, isWorkspaceWritablePath } from '@core/page-parser'
import { applyStudioEditBatch, studioEditLocation } from '../studioWriteback'
import { landAssetBytes, landDesignReferenceBytes } from '../studio/assetLanding'
import { tryServeStudioExtractComponent } from '../studio/extractComponent'
import { studioEditMcpTools } from '../../ai/mcp/tools/studio/editTools'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

const UNWRITABLE = [...UNWRITABLE_WORKSPACE_DIR_NAMES]
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

const SCREEN = `export default function Screen() {
  return (
    <main className="screen">
      <h1>Hi</h1>
    </main>
  )
}
`

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-excluded-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
const exists = (relPath: string): boolean => fs.existsSync(path.join(tmpDir, ...relPath.split('/')))

function id(rel: string, source: string, tag: string): string {
  const { line, col } = locateTag(source, tag)
  return `${rel}:${line}:${col}`
}

/** A directory link that works without privileges on Windows (junction) and is a plain symlink elsewhere. */
function linkDir(targetRel: string, linkRel: string): void {
  const target = path.join(tmpDir, ...targetRel.split('/'))
  const link = path.join(tmpDir, ...linkRel.split('/'))
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, 'junction')
}

function mcpTool(name: string) {
  const t = studioEditMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

describe('the node-id decode refuses every unwritable directory', () => {
  it.each(UNWRITABLE)('refuses %s at the root and nested', (name) => {
    expect(studioEditLocation(tmpDir, `${name}/Screen.tsx:1:1`)).toBeNull()
    expect(studioEditLocation(tmpDir, `src/${name}/Screen.tsx:1:1`)).toBeNull()
    expect(studioEditLocation(tmpDir, `src\\${name}\\Screen.tsx:1:1`)).toBeNull()
    // A composite (inlined) id writes to its LAST segment — that one decides.
    expect(studioEditLocation(tmpDir, `pages/Home.tsx:3:5~${name}/Card.tsx:1:1`)).toBeNull()
  })

  it.each([
    ['upper case (case-insensitive filesystems)', '.STUDIO/meta.tsx:1:1'],
    ['mixed case', 'Node_Modules/pkg/index.js:1:1'],
    ['trailing dot (Windows strips it)', '.studio./meta.tsx:1:1'],
    ['trailing space (Windows strips it)', '.git /hooks.js:1:1'],
    ['NTFS stream suffix', '.git::$INDEX_ALLOCATION/hooks.js:1:1'],
  ])('refuses a spelling the filesystem resolves to one: %s', (_label, nodeId) => {
    expect(studioEditLocation(tmpDir, nodeId)).toBeNull()
  })

  // FC-1's extension point is deliberately CLOSED. When FC-1 opens exactly
  // `.studio/canvas/<id>.tsx`, it flips this assertion in its own reviewed
  // change — and must keep every other `.studio` path refused.
  it('does not yet open the future free-canvas layer path', () => {
    expect(studioEditLocation(tmpDir, '.studio/canvas/cl0123456789.tsx:1:1')).toBeNull()
  })

  it('refuses a symlink spelled like source whose real path is inside .studio', () => {
    write('.studio/Screen.tsx', SCREEN)
    linkDir('.studio', 'src/linked')
    expect(studioEditLocation(tmpDir, id('src/linked/Screen.tsx', SCREEN, 'h1'))).toBeNull()
  })

  it('still accepts ordinary source, including a name that merely contains an excluded word', () => {
    expect(studioEditLocation(tmpDir, 'src/dist-utils/Screen.tsx:1:1')?.rel).toBe('src/dist-utils/Screen.tsx')
    expect(studioEditLocation(tmpDir, 'src/.studios/Screen.tsx:1:1')?.rel).toBe('src/.studios/Screen.tsx')
    expect(studioEditLocation(tmpDir, 'pages/Home.tsx:1:1')?.rel).toBe('pages/Home.tsx')
  })
})

describe('value and structural edits never write into an unwritable directory', () => {
  it.each(UNWRITABLE)('a text edit on %s/Screen.tsx leaves it byte-identical', (name) => {
    const rel = `${name}/Screen.tsx`
    write(rel, SCREEN)
    const result = applyStudioEditBatch(tmpDir, [{ kind: 'text', nodeId: id(rel, SCREEN, 'h1'), text: 'pwned' }])
    expect(result.written).toBe(0)
    expect(read(rel)).toBe(SCREEN)
  })

  it.each(UNWRITABLE)('an insert into a container in %s/Screen.tsx leaves it byte-identical', (name) => {
    const rel = `${name}/Screen.tsx`
    write(rel, SCREEN)
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'insert', nodeId: id(rel, SCREEN, 'main'), name: 'section', props: {} },
    ])
    expect(result.written).toBe(0)
    expect(read(rel)).toBe(SCREEN)
  })

  it.each(UNWRITABLE)('a transplant whose DESTINATION is in %s writes neither end', (name) => {
    const destRel = `${name}/Screen.tsx`
    write(destRel, SCREEN)
    write('pages/Home.tsx', SCREEN)
    applyStudioEditBatch(tmpDir, [
      { kind: 'transplant', nodeId: id('pages/Home.tsx', SCREEN, 'h1'), parentNodeId: id(destRel, SCREEN, 'main') },
    ])
    expect(read(destRel)).toBe(SCREEN)
    expect(read('pages/Home.tsx')).toBe(SCREEN)
  })

  it('a transplant whose destination is reached through a symlink into .studio writes neither end', () => {
    write('.studio/Screen.tsx', SCREEN)
    write('pages/Home.tsx', SCREEN)
    linkDir('.studio', 'pages/shared')
    applyStudioEditBatch(tmpDir, [
      {
        kind: 'transplant',
        nodeId: id('pages/Home.tsx', SCREEN, 'h1'),
        parentNodeId: id('pages/shared/Screen.tsx', SCREEN, 'main'),
      },
    ])
    expect(read('.studio/Screen.tsx')).toBe(SCREEN)
    expect(read('pages/Home.tsx')).toBe(SCREEN)
  })

  it('a value edit through a symlinked directory into .git is refused', () => {
    write('.git/Screen.tsx', SCREEN)
    linkDir('.git', 'src/vendor')
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'text', nodeId: id('src/vendor/Screen.tsx', SCREEN, 'h1'), text: 'pwned' },
    ])
    expect(result.written).toBe(0)
    expect(read('.git/Screen.tsx')).toBe(SCREEN)
  })

  it('a promote-component rooted in an ordinary page cannot create its file through a dangling link', () => {
    const page = `export default function Page() {\n  return (\n    <main>\n      <section><h2>Card</h2></section>\n    </main>\n  )\n}\n`
    write('src/Page.tsx', page)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
    try {
      fs.symlinkSync(path.join(outside, 'Card.tsx'), path.join(tmpDir, 'src', 'Card.tsx'))
      applyStudioEditBatch(tmpDir, [{ kind: 'promote-component', nodeId: id('src/Page.tsx', page, 'section'), componentName: 'Card' }])
      expect(fs.existsSync(path.join(outside, 'Card.tsx'))).toBe(false)
      expect(read('src/Page.tsx')).toBe(page)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('ordinary source is still written', () => {
    write('pages/Home.tsx', SCREEN)
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'text', nodeId: id('pages/Home.tsx', SCREEN, 'h1'), text: 'Hello' },
    ])
    expect(result.written).toBe(1)
    expect(read('pages/Home.tsx')).toContain('Hello')
  })
})

describe('css writeback never writes into an unwritable directory', () => {
  const CSS = '.a {\n  color: red;\n}\n'

  it.each(UNWRITABLE)('a set on %s/theme.css leaves it byte-identical', (name) => {
    const rel = `${name}/theme.css`
    write(rel, CSS)
    applyStudioEditBatch(tmpDir, [
      { kind: 'css', op: 'set', nodeId: `css:${rel}#.a#color`, file: rel, selector: '.a', property: 'color', value: 'blue' },
    ])
    expect(read(rel)).toBe(CSS)
  })

  it('a set on an upper-cased spelling of .studio is refused', () => {
    write('.studio/theme.css', CSS)
    applyStudioEditBatch(tmpDir, [
      { kind: 'css', op: 'set', nodeId: 'css:.STUDIO/theme.css#.a#color', file: '.STUDIO/theme.css', selector: '.a', property: 'color', value: 'blue' },
    ])
    expect(read('.studio/theme.css')).toBe(CSS)
  })

  it('a set through a directory symlink into .studio is refused', () => {
    write('.studio/theme.css', CSS)
    linkDir('.studio', 'styles')
    applyStudioEditBatch(tmpDir, [
      { kind: 'css', op: 'set', nodeId: 'css:styles/theme.css#.a#color', file: 'styles/theme.css', selector: '.a', property: 'color', value: 'blue' },
    ])
    expect(read('.studio/theme.css')).toBe(CSS)
  })

  it('a create for a page reached through a symlink into .studio writes nothing there', () => {
    write('.studio/screens/Home.tsx', SCREEN)
    linkDir('.studio/screens', 'src/screens')
    applyStudioEditBatch(tmpDir, [
      { kind: 'css', op: 'create', nodeId: 'css-create:src/screens/Home.tsx#.hero', pageFile: 'src/screens/Home.tsx', selector: '.hero', declarations: { color: 'red' } },
    ])
    expect(read('.studio/screens/Home.tsx')).toBe(SCREEN)
    expect(fs.readdirSync(path.join(tmpDir, '.studio', 'screens'))).toEqual(['Home.tsx'])
  })

  it('a create never follows a dangling stylesheet symlink out of the project', () => {
    write('src/screens/Home.tsx', SCREEN)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
    try {
      fs.symlinkSync(path.join(outside, 'evil.css'), path.join(tmpDir, 'src', 'screens', 'Home.css'))
      applyStudioEditBatch(tmpDir, [
        { kind: 'css', op: 'create', nodeId: 'css-create:src/screens/Home.tsx#.hero', pageFile: 'src/screens/Home.tsx', selector: '.hero', declarations: { color: 'red' } },
      ])
      expect(fs.existsSync(path.join(outside, 'evil.css'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('ordinary stylesheets are still written', () => {
    write('src/theme.css', CSS)
    const result = applyStudioEditBatch(tmpDir, [
      { kind: 'css', op: 'set', nodeId: 'css:src/theme.css#.a#color', file: 'src/theme.css', selector: '.a', property: 'color', value: 'blue' },
    ])
    expect(result.written).toBe(1)
    expect(read('src/theme.css')).toContain('color: blue')
  })
})

describe('asset landing never writes into an unwritable directory', () => {
  it.each(UNWRITABLE)('refuses a targetDir of %s and one nested under it', (name) => {
    expect(landAssetBytes(tmpDir, name, PNG_BYTES, 'x.png').ok).toBe(false)
    expect(landAssetBytes(tmpDir, `src/${name}/img`, PNG_BYTES, 'x.png').ok).toBe(false)
    expect(exists(name)).toBe(false)
    expect(exists(`src/${name}`)).toBe(false)
  })

  it.each(['.STUDIO', '.studio.', '.Git/hooks'])('refuses the resolving spelling %s', (targetDir) => {
    expect(landAssetBytes(tmpDir, targetDir, PNG_BYTES, 'x.png').ok).toBe(false)
  })

  // The design-reference exception used to be granted by the CALLER's string:
  // any client passing `targetDir: ".studio/references"` got it.
  it('does not let a client-supplied targetDir claim the design-reference directory', () => {
    expect(landAssetBytes(tmpDir, '.studio/references', PNG_BYTES, 'x.png').ok).toBe(false)
    expect(exists('.studio/references')).toBe(false)
  })

  it('refuses a target directory that is a symlink into .git', () => {
    linkDir('.git/hooks', 'src/assets')
    expect(landAssetBytes(tmpDir, undefined, PNG_BYTES, 'pre-commit.png').ok).toBe(false)
    expect(fs.readdirSync(path.join(tmpDir, '.git', 'hooks'))).toEqual([])
  })

  it('never writes through a dangling symlink at the chosen file name', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'assets'), { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
    try {
      fs.symlinkSync(path.join(outside, 'hero.png'), path.join(tmpDir, 'src', 'assets', 'hero.png'))
      landAssetBytes(tmpDir, undefined, PNG_BYTES, 'hero.png')
      expect(fs.existsSync(path.join(outside, 'hero.png'))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('the server-derived design-reference landing still works, and ordinary assets still land', () => {
    const reference = landDesignReferenceBytes(tmpDir, PNG_BYTES, 'ref')
    expect(reference).toEqual({ ok: true, relPath: '.studio/references/ref.png' })
    expect(landAssetBytes(tmpDir, undefined, PNG_BYTES, 'hero.png')).toEqual({ ok: true, relPath: 'src/assets/hero.png' })
  })

  it('the design-reference landing refuses a .studio/references that is a symlink elsewhere', () => {
    linkDir('.git/objects', '.studio/references')
    expect(landDesignReferenceBytes(tmpDir, PNG_BYTES, 'ref').ok).toBe(false)
    expect(fs.readdirSync(path.join(tmpDir, '.git', 'objects'))).toEqual([])
  })
})

describe('MCP writers never write into an unwritable directory', () => {
  it.each(UNWRITABLE)('studio_apply_edits refuses a prop edit on %s/Screen.tsx', async (name) => {
    const rel = `${name}/Screen.tsx`
    write(rel, SCREEN)
    const result = (await mcpTool('studio_apply_edits').handler!(
      { dir: tmpDir, edits: [{ kind: 'prop', nodeId: id(rel, SCREEN, 'main'), prop: 'className', value: 'pwned' }] },
      {} as never,
    )) as { written: number }
    expect(result.written).toBe(0)
    expect(read(rel)).toBe(SCREEN)
  })

  it.each(UNWRITABLE)('studio_codemod refuses rename-tag on %s/Screen.tsx', async (name) => {
    const rel = `${name}/Screen.tsx`
    write(rel, SCREEN)
    const result = (await mcpTool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'rename-tag', nodeId: id(rel, SCREEN, 'h1'), tag: 'h2' },
      {} as never,
    )) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(read(rel)).toBe(SCREEN)
  })
})

describe('extract-component never creates its copy in an unwritable directory', () => {
  const CARD = 'export function Card() {\n  return <div className="card">Card</div>\n}\n'
  const HOME = "import { Card } from '../.studio/Card'\n\nexport default function Home() {\n  return <Card />\n}\n"

  // Already refused before P1-G (the resolver classifies a file outside the
  // walked workspace as a package); pinned so the new-file guard stays a
  // second, independent refusal.
  it('refuses a component whose source file sits in .studio (HTTP route and MCP verb)', async () => {
    write('.studio/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    const nodeId = id('pages/Home.tsx', HOME, 'Card')

    const res = await tryServeStudioExtractComponent(
      new Request('http://x/admin/api/studio/extract-component', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: tmpDir, nodeId }),
      }),
      new URL('http://x/admin/api/studio/extract-component'),
      '/admin/api/studio/extract-component',
    )
    const body = (await res!.json()) as { ok: boolean }
    expect(body.ok).toBe(false)

    const mcp = (await mcpTool('studio_codemod').handler!(
      { dir: tmpDir, verb: 'extract-component', nodeId },
      {} as never,
    )) as { ok: boolean }
    expect(mcp.ok).toBe(false)

    expect(fs.readdirSync(path.join(tmpDir, '.studio'))).toEqual(['Card.tsx'])
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  // Confirmed on the unfixed base: the copy's name was probed with
  // `existsSync`, which reports a dangling link as absent, and the write
  // followed it — a file of the repository's own choosing, created wherever
  // the link pointed.
  it('never creates the copy through a dangling link planted at the copy name', async () => {
    const home = "import { Card } from '../components/Card'\n\nexport default function Home() {\n  return <Card />\n}\n"
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', home)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outside-'))
    try {
      fs.symlinkSync(path.join(outside, 'payload.tsx'), path.join(tmpDir, 'components', 'Card2.tsx'))
      const result = (await mcpTool('studio_codemod').handler!(
        { dir: tmpDir, verb: 'extract-component', nodeId: id('pages/Home.tsx', home, 'Card') },
        {} as never,
      )) as { ok: boolean }
      expect(result.ok).toBe(false)
      expect(fs.existsSync(path.join(outside, 'payload.tsx'))).toBe(false)
      expect(read('pages/Home.tsx')).toBe(home)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('isWorkspaceWritablePath — the shared predicate', () => {
  it('refuses the project root itself, anything outside it, and every unwritable directory', () => {
    expect(isWorkspaceWritablePath(tmpDir, tmpDir)).toBe(false)
    expect(isWorkspaceWritablePath(tmpDir, path.join(tmpDir, '..', 'x.tsx'))).toBe(false)
    for (const name of UNWRITABLE) {
      expect(isWorkspaceWritablePath(tmpDir, path.join(tmpDir, name, 'x.tsx'))).toBe(false)
    }
    expect(isWorkspaceWritablePath(tmpDir, path.join(tmpDir, 'src', 'new', 'x.tsx'))).toBe(true)
  })

  it('refuses a path through a directory link into an unwritable directory, and one through a dangling link', () => {
    linkDir('node_modules/pkg', 'src/pkg')
    expect(isWorkspaceWritablePath(tmpDir, path.join(tmpDir, 'src', 'pkg', 'index.tsx'))).toBe(false)
    fs.symlinkSync(path.join(tmpDir, 'nowhere', 'x.tsx'), path.join(tmpDir, 'dangling.tsx'))
    expect(isWorkspaceWritablePath(tmpDir, path.join(tmpDir, 'dangling.tsx'))).toBe(false)
  })
})
