/**
 * prototypeShell — what Studio writes into a workspace so its design can
 * actually run, and (more importantly) what it refuses to write over.
 *
 * The four properties worth protecting, in order of how much damage getting
 * them wrong would do:
 *
 *   1. A file the user has edited is never overwritten.
 *   2. A file the user has NOT edited still can be, so a fix to the scaffold
 *      reaches workspaces that already exist. `.studio/shell.json` records the
 *      hash Studio wrote and is what separates these two cases.
 *   3. `package.json` merges. A project that pins its own React keeps it.
 *   4. The generated registry matches `.studio/` — including the awkward
 *      cases: a board with no frames, a frame whose page has been deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensurePrototypeShell } from '../prototypeShell'
import { autoPlaceBoardFrame } from '../boardFrames'
import { isPrototypeShellPath } from '@core/page-parser'
import { findEntryFile } from '@core/studio-sync/collectPageStylesheets'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-shell-'))
  fs.mkdirSync(path.join(tmpDir, 'pages'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'pages', 'Home.tsx'),
    'export default function Home() { return <div /> }\n',
  )
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function read(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')
}

/**
 * Write a complete `ProjectProfile` into `.studio/meta.json` with `extra`
 * merged in. Every required field has to be present: `readStudioMeta`
 * validates the profile as one value, so a partial object is dropped entirely
 * and the caller silently gets defaults.
 */
function writeProfile(extra: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, '.studio', 'meta.json'),
    JSON.stringify({
      profile: {
        probeVersion: 2,
        appRoot: '',
        framework: 'unknown',
        pagesDir: 'pages',
        routeStyle: 'flat',
        entryFiles: [],
        packageManager: 'npm',
        styleToolchain: { tailwind: null, cssModules: true, sass: false, postcssConfigPath: null, cssInJs: null },
        componentPackages: [],
        aliases: {},
        warnings: [],
        ...extra,
      },
    }),
  )
}

describe('ensurePrototypeShell — scaffolding', () => {
  it('writes an app that can start: an entry point, a config and a shell', () => {
    const result = ensurePrototypeShell(tmpDir)

    // The three files whose absence is exactly why the download could not run.
    expect(result.created).toContain('index.html')
    expect(result.created).toContain('vite.config.js')
    expect(result.created).toContain('prototype/main.jsx')
    expect(read('index.html')).toContain('/prototype/main.jsx')
  })

  it('is idempotent — a second run creates nothing and rewrites nothing', () => {
    ensurePrototypeShell(tmpDir)
    const second = ensurePrototypeShell(tmpDir)

    expect(second.created).toEqual([])
    expect(second.regenerated).toEqual([])
  })

  it('never overwrites a static file the user has edited', () => {
    ensurePrototypeShell(tmpDir)
    const mine = 'export default function App() { return <p>mine</p> }\n'
    fs.writeFileSync(path.join(tmpDir, 'prototype', 'App.jsx'), mine)

    ensurePrototypeShell(tmpDir)

    expect(read('prototype/App.jsx')).toBe(mine)
  })

  it('keeps refusing on every later open, not just the next one', () => {
    ensurePrototypeShell(tmpDir)
    const mine = 'export default function App() { return <p>mine</p> }\n'
    fs.writeFileSync(path.join(tmpDir, 'prototype', 'App.jsx'), mine)

    ensurePrototypeShell(tmpDir)
    ensurePrototypeShell(tmpDir)
    ensurePrototypeShell(tmpDir)

    expect(read('prototype/App.jsx')).toBe(mine)
  })

  it('DOES replace a static file nobody has touched — a shipped fix has to land', () => {
    ensurePrototypeShell(tmpDir)
    const shipped = read('prototype/App.jsx')

    // Stand in for "an older Studio wrote a version with a bug in it": the file
    // is stale, but its hash is the one Studio recorded, so it is not the
    // user's and may be replaced.
    const stale = 'stale\n'
    fs.writeFileSync(path.join(tmpDir, 'prototype', 'App.jsx'), stale)
    const manifestPath = path.join(tmpDir, '.studio', 'shell.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      version: number
      files: Record<string, string>
    }
    manifest.files['prototype/App.jsx'] = createHash('sha256').update(stale, 'utf8').digest('hex')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const result = ensurePrototypeShell(tmpDir)

    expect(result.regenerated).toContain('prototype/App.jsx')
    expect(read('prototype/App.jsx')).toBe(shipped)
  })

  it('adopts a workspace scaffolded before the manifest existed', () => {
    ensurePrototypeShell(tmpDir)
    // The state every already-opened workspace was in: Studio's own files on
    // disk, no record of having written them. Stale ones have to be adoptable,
    // or the bug they contain is permanent there.
    fs.rmSync(path.join(tmpDir, '.studio', 'shell.json'))
    fs.writeFileSync(path.join(tmpDir, 'prototype', 'App.jsx'), 'stale\n')

    const result = ensurePrototypeShell(tmpDir)

    expect(result.regenerated).toContain('prototype/App.jsx')
    expect(read('prototype/App.jsx')).toContain('export default function App')
  })

  it('ships a real viewport per screen, not a div', () => {
    ensurePrototypeShell(tmpDir)

    // The whole reason ScreenFrame exists: a page written against `100vh` or a
    // `max-width` query has to be measured against the DEVICE, not against the
    // browser window the shell happens to be open in.
    expect(read('prototype/ScreenFrame.jsx')).toContain('<iframe')
    expect(read('prototype/App.jsx')).toContain("import ScreenFrame from './ScreenFrame'")
  })

  it('DOES bring a generated file back, because that one is Studio\'s', () => {
    ensurePrototypeShell(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'prototype', 'registry.generated.jsx'), 'wiped\n')

    const result = ensurePrototypeShell(tmpDir)

    expect(result.regenerated).toContain('prototype/registry.generated.jsx')
    expect(read('prototype/registry.generated.jsx')).toContain('export const SCREENS')
  })
})

describe('ensurePrototypeShell — package.json', () => {
  it('adds what the shell needs to run', () => {
    ensurePrototypeShell(tmpDir)
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(pkg.scripts.dev).toBe('vite')
    expect(pkg.dependencies.react).toBeDefined()
    expect(pkg.devDependencies.vite).toBeDefined()
  })

  it('never overwrites a version or a script the project already set', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'mine',
        dependencies: { react: '18.0.0', '@alm-design/design-system': '^1.1.2' },
        scripts: { dev: 'my-own-server' },
      }),
    )

    ensurePrototypeShell(tmpDir)
    const pkg = JSON.parse(read('package.json')) as {
      name: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }

    expect(pkg.name).toBe('mine')
    expect(pkg.dependencies.react).toBe('18.0.0')
    expect(pkg.scripts.dev).toBe('my-own-server')
    // …and still gains what it was missing.
    expect(pkg.scripts.build).toBe('vite build')
    expect(pkg.dependencies['@alm-design/design-system']).toBe('^1.1.2')
  })
})

describe('ensurePrototypeShell — the generated registry', () => {
  it('imports every page and gives it Studio\'s own page id', () => {
    fs.writeFileSync(path.join(tmpDir, 'pages', 'SignUp.tsx'), 'export default function SignUp() { return <div /> }\n')

    ensurePrototypeShell(tmpDir)
    const registry = read('prototype/registry.generated.jsx')

    expect(registry).toContain("import Home from '../pages/Home'")
    expect(registry).toContain("import SignUp from '../pages/SignUp'")
    expect(registry).toContain('{ key: "sign-up", label: "SignUp", Component: SignUp },')
  })

  it('carries a board through as a tab, with each frame at its own x/y', () => {
    autoPlaceBoardFrame(tmpDir, 'home')

    ensurePrototypeShell(tmpDir)
    const registry = read('prototype/registry.generated.jsx')

    expect(registry).toContain('export const BOARDS')
    expect(registry).toContain('"pageId":"home"')
    expect(registry).toContain('"x":0')
  })

  it('drops a frame whose page has been deleted, rather than emitting a broken import', () => {
    autoPlaceBoardFrame(tmpDir, 'home')
    autoPlaceBoardFrame(tmpDir, 'a-page-that-never-existed')

    ensurePrototypeShell(tmpDir)
    const registry = read('prototype/registry.generated.jsx')

    expect(registry).toContain('"pageId":"home"')
    expect(registry).not.toContain('a-page-that-never-existed')
  })

  it('regenerates when the board changes, and only then', () => {
    ensurePrototypeShell(tmpDir)
    expect(ensurePrototypeShell(tmpDir).regenerated).toEqual([])

    autoPlaceBoardFrame(tmpDir, 'home')

    expect(ensurePrototypeShell(tmpDir).regenerated).toContain('prototype/registry.generated.jsx')
  })

  it('emits the project\'s own dark-mode gate when the probe found one', () => {
    // A FULL profile: `readStudioMeta` validates it as a whole, so a partial
    // one is discarded wholesale rather than merged — the gate would silently
    // never appear.
    writeProfile({ colorScheme: { mechanism: 'class', selector: "[data-theme='dark']" } })

    ensurePrototypeShell(tmpDir)

    expect(read('prototype/registry.generated.jsx')).toContain('html.setAttribute("data-theme"')
  })

  it('emits a no-op gate — never a broken one — when the project declares none', () => {
    ensurePrototypeShell(tmpDir)
    const registry = read('prototype/registry.generated.jsx')

    expect(registry).toContain('export function applyColorSchemeGate()')
    expect(registry).toContain('Detected mechanism: none')
  })
})

describe('ensurePrototypeShell — the generated providers', () => {
  it('mounts the project\'s LanguageProvider and feeds the design system its direction', () => {
    fs.mkdirSync(path.join(tmpDir, 'i18n'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'i18n', 'LanguageContext.tsx'), 'export const x = 1\n')
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { '@alm-design/design-system': '^1.1.2' } }),
    )

    ensurePrototypeShell(tmpDir)
    const providers = read('prototype/providers.generated.jsx')

    expect(providers).toContain("import { LanguageProvider, useLanguage } from '../i18n/LanguageContext'")
    // The half that a `dir` attribute alone cannot fix — the DS resolves
    // direction in JavaScript, so it has to be told.
    expect(providers).toContain('<DesignSystemProvider platform="ios" dir={dir}>')
  })

  it('falls back to a passthrough for a project with neither', () => {
    ensurePrototypeShell(tmpDir)
    const providers = read('prototype/providers.generated.jsx')

    expect(providers).toContain('return children')
    expect(providers).toContain("lang: 'en', dir: 'ltr'")
  })
})

describe('ensurePrototypeShell — refusals', () => {
  it('does nothing for a directory that does not exist, and does not throw', () => {
    expect(ensurePrototypeShell(path.join(tmpDir, 'nope'))).toEqual({ created: [], regenerated: [] })
  })

  it('still scaffolds a project with no pages at all', () => {
    fs.rmSync(path.join(tmpDir, 'pages', 'Home.tsx'))

    const result = ensurePrototypeShell(tmpDir)

    expect(result.created).toContain('index.html')
    expect(read('prototype/registry.generated.jsx')).toContain('export const SCREENS')
  })
})

/**
 * The shell must be INVISIBLE to the parse pipeline while remaining visible to
 * the download.
 *
 * This is the failure mode that actually happened. `ensurePrototypeShell`
 * writes an `index.html` whose module script points at `prototype/main.jsx`,
 * and `findEntryFile` promptly adopted it as the project's entry point — so
 * Studio walked its own `shell.css` and `CanvasPanel.css` in as the user's
 * design system, and every page in a scaffolded workspace gained style rules
 * nobody wrote. Studio reading its own scaffold back as the thing being
 * designed is the one thing the shell must never do.
 */
describe('ensurePrototypeShell — invisible to the parser, visible to the download', () => {
  it('does not let its own index.html become the project entry point', () => {
    ensurePrototypeShell(tmpDir)

    // The shell's entry is not the user's entry. A workspace with no entry of
    // its own must still report none.
    expect(findEntryFile(tmpDir)).toBeUndefined()
  })

  it('still yields to a real entry file the project ships', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.tsx'), "import './app.css'\n")
    ensurePrototypeShell(tmpDir)

    expect(findEntryFile(tmpDir)).toBe(path.join(tmpDir, 'src', 'main.tsx'))
  })

  it('classifies every file it writes as shell, and the user\'s as not', () => {
    ensurePrototypeShell(tmpDir)

    expect(isPrototypeShellPath('prototype/shell.css')).toBe(true)
    expect(isPrototypeShellPath('prototype')).toBe(true)
    // Not a prefix match on the string: a user directory that merely starts
    // with the same letters is theirs.
    expect(isPrototypeShellPath('prototypes/Board.tsx')).toBe(false)
    expect(isPrototypeShellPath('pages/Home.tsx')).toBe(false)
  })
})

/**
 * Interactions authored on the board have to survive the export.
 *
 * The link is anchored by `indexPath` rather than by node id, because the
 * exported app has none of Studio's `data-node-id` attributes to match on. See
 * `playerTemplate.ts` for why an index path resolves where an id cannot.
 */
describe('ensurePrototypeShell — prototype links', () => {
  it('ships a player and carries the authored links into the registry', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.studio', 'prototype.json'),
      JSON.stringify({
        version: 1,
        links: [
          {
            id: 'link-1',
            origin: 'design',
            source: { pageId: 'home', node: { nodeId: 'pages/Home.tsx:2:10', indexPath: [0, 1], moduleId: 'alm.Button', textSnippet: '' } },
            trigger: 'click',
            action: 'navigate',
            targetPageId: 'home',
            transition: 'instant',
          },
        ],
      }),
    )

    const result = ensurePrototypeShell(tmpDir)

    expect(result.created).toContain('prototype/Player.jsx')
    const registry = read('prototype/registry.generated.jsx')
    expect(registry).toContain('export const LINKS')
    expect(registry).toContain('"indexPath"')
    expect(registry).toContain('"link-1"')
  })

  it('emits an empty link list for a project with no interactions', () => {
    ensurePrototypeShell(tmpDir)

    // Not omitted: `Player.jsx` imports LINKS unconditionally, so the export of
    // a project nobody has wired up still has to be a valid module.
    expect(read('prototype/registry.generated.jsx')).toContain('export const LINKS = []')
  })
})
