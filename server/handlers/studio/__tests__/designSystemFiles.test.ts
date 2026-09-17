/**
 * designSystemFiles — the Studio-written `<project>/design-system/` folder.
 *
 * Four properties, in order of how much damage getting them wrong would do:
 *
 *   1. **Nothing outside the folder is ever touched**, and nothing at all is
 *      written for a project that did not ask (no `designSystem: 'alm'` in
 *      `.studio/meta.json`). An imported GitHub repository must not grow
 *      600 KB of someone else's `.jsx` because it was opened.
 *   2. **Only the assets something actually imports** are copied. The real
 *      package ships 568 icon files and ~20 are referenced; copying all of
 *      them would put 3.8 MB into every project and every download.
 *      "Something" is TWO demand sources, and each one shipped a project that
 *      would not build when it was missed: the design system's own components
 *      (which import `.png` logotypes as well as `.svg` icons — an SVG-only
 *      rule died on `Could not resolve "…/card-sample.png"`), and the
 *      PROJECT'S OWN pages (`import smsSvg from '../design-system/icons/…'`,
 *      which the migration writes and no component demands).
 *   3. **Idempotent.** A second run with the same source writes nothing, so a
 *      board open does not move mtimes and invalidate every cache keyed on
 *      them. A changed source file rewrites that file; a source file that goes
 *      away is removed from the folder.
 *   4. **Containment.** A source path that escapes the vendored `src/` on its
 *      real path is refused, not followed.
 *
 * The vendored source does not exist on this branch (DS-1 creates it), and a
 * test that depended on it would be testing DS-1. So every test here builds a
 * small fake vendor directory with the REAL package's shape: `src/index.js`
 * re-exporting components + context + icons, two component pairs whose `.jsx`
 * imports `../context/DesignSystemContext` and a couple of
 * `../icons/line-icons/*.svg?raw`, and a `tokens/index.css`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDesignSystemFiles } from '../designSystemFiles'
import { isDesignSystemBacked } from '../builtinDesignSystem'

let root: string
let sourceDir: string
let projectDir: string

/** A real PNG header — bytes that are not valid UTF-8, so a text round-trip is visible as corruption. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff, 0x80])

/** Every file in the fake vendor package, keyed by its path relative to the package root. */
const VENDOR_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'alm-design-system', version: '1.1.2' }, null, 2),
  'src/index.js': [
    "export { Button } from './components/Button'",
    "export { Chip } from './components/Chip'",
    "export { DesignSystemProvider, useDir } from './context/DesignSystemContext'",
    "export { ChevronIcon } from './icons/LineIcons'",
    "import './tokens/index.css'",
    '',
  ].join('\n'),
  'src/components/Button.jsx': [
    "import { useDir } from '../context/DesignSystemContext'",
    "import './Button.css'",
    "import chevron from '../icons/line-icons/chevron.svg?raw'",
    // The real `Button.jsx` imports `../icons/logotypes/payment/card-sample.png`.
    "import card from '../icons/logotypes/card-sample.png'",
    'export function Button() { return null }',
    '',
  ].join('\n'),
  'src/components/Button.css': '.btn { color: red }\n',
  'src/components/Chip.jsx': [
    "import { Button } from './Button'",
    "import './Chip.css'",
    "import close from '../icons/line-icons/close.svg?raw'",
    'export function Chip() { return null }',
    '',
  ].join('\n'),
  'src/components/Chip.css': '.chip { color: blue }\n',
  'src/context/DesignSystemContext.jsx': 'export function DesignSystemProvider() { return null }\n',
  'src/tokens/index.css': ':root { --color-1: #fff }\nbody { margin: 0 }\n',
  'src/tokens/tokens.js': 'export const tokens = {}\n',
  'src/icons/LineIcons.jsx': [
    "import search from './line-icons/search.svg?raw'",
    'export const ChevronIcon = null',
    '',
  ].join('\n'),
  'src/icons/line-icons/chevron.svg': '<svg id="chevron" />',
  // Binary on purpose: PNG_BYTES is written raw, and a copy that round-trips
  // through UTF-8 mangles it. Written by `writeVendor` as latin1, compared
  // back as bytes.
  'src/icons/logotypes/card-sample.png': PNG_BYTES.toString('latin1'),
  'src/icons/line-icons/close.svg': '<svg id="close" />',
  'src/icons/line-icons/search.svg': '<svg id="search" />',
  // The 545 nobody imports. Exactly one stands in for them.
  'src/icons/line-icons/never-imported.svg': '<svg id="never" />',
}

function writeVendor(files: Record<string, string> = VENDOR_FILES): void {
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = path.join(sourceDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.from(contents, 'latin1'))
  }
}

/** Marks the project design-system-backed, the way "New project" and the migration do. */
function markBacked(): void {
  fs.mkdirSync(path.join(projectDir, '.studio'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.studio', 'meta.json'), JSON.stringify({ designSystem: 'alm' }))
}

function ensure() {
  return ensureDesignSystemFiles(projectDir, { sourceDir })
}

/** Every path under `<project>/design-system/`, POSIX-relative to it, sorted. */
function folderContents(): string[] {
  const dsRoot = path.join(projectDir, 'design-system')
  if (!fs.existsSync(dsRoot)) return []
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else found.push(rel)
    }
  }
  walk(dsRoot, '')
  return found.sort()
}

/** `(relPath -> mtimeMs)` for everything in the project, so "nothing was touched" can be asserted as a fact. */
function projectMtimes(): Record<string, number> {
  const seen: Record<string, number> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else seen[rel] = fs.statSync(path.join(dir, entry.name)).mtimeMs
    }
  }
  walk(projectDir, '')
  return seen
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-files-'))
  sourceDir = path.join(root, 'vendor', 'alm-design-system')
  projectDir = path.join(root, 'project')
  fs.mkdirSync(path.join(projectDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'export default function Home() { return null }\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ensureDesignSystemFiles — the first run', () => {
  beforeEach(() => {
    writeVendor()
    markBacked()
  })

  it('writes the source, the README and the VERSION, and only the icons something imports', () => {
    const result = ensure()

    expect(result.skipped).toBeNull()
    expect(folderContents()).toEqual([
      'README.md',
      'VERSION',
      'components/Button.css',
      'components/Button.jsx',
      'components/Chip.css',
      'components/Chip.jsx',
      'context/DesignSystemContext.jsx',
      // `LineIcons.jsx` imports it, so it comes along even though no component does.
      'icons/LineIcons.jsx',
      'icons/line-icons/chevron.svg',
      'icons/line-icons/close.svg',
      'icons/line-icons/search.svg',
      // Not an SVG, and imported by a component — see the module doc's (2).
      'icons/logotypes/card-sample.png',
      'index.js',
      'tokens/index.css',
      'tokens/tokens.js',
    ])
    expect(result.written).toEqual(folderContents())
  })

  it('leaves the 545 icons nobody imports behind', () => {
    ensure()
    expect(fs.existsSync(path.join(projectDir, 'design-system', 'icons', 'line-icons', 'never-imported.svg'))).toBe(false)
  })

  it('records the vendored package\'s own version, never a guessed one', () => {
    ensure()
    expect(fs.readFileSync(path.join(projectDir, 'design-system', 'VERSION'), 'utf8')).toBe('1.1.2\n')
  })

  it('says in the folder that the folder is Studio\'s', () => {
    ensure()
    const readme = fs.readFileSync(path.join(projectDir, 'design-system', 'README.md'), 'utf8')
    expect(readme).toContain('Studio-managed')
    expect(readme).toContain('vendor/alm-design-system')
  })

  it('makes the project design-system-backed, which is what every read-side check asks', () => {
    expect(isDesignSystemBacked(projectDir)).toBe(false)
    ensure()
    expect(isDesignSystemBacked(projectDir)).toBe(true)
  })

  it('records the hash and the file list in .studio/, never in the folder itself', () => {
    ensure()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.studio', 'design-system.json'), 'utf8'),
    ) as { version: number; hash: string; files: string[] }

    expect(manifest.version).toBe(1)
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.files).toEqual(folderContents())
  })

  it('touches nothing outside the folder and the manifest', () => {
    const before = projectMtimes()
    ensure()
    const after = projectMtimes()

    for (const [rel, mtime] of Object.entries(before)) {
      expect(`${rel}:${after[rel] === mtime}`).toBe(`${rel}:true`)
    }
    const added = Object.keys(after).filter((rel) => before[rel] === undefined)
    for (const rel of added) {
      const owned = rel.startsWith('design-system/') || rel === '.studio/design-system.json'
      expect(`${rel}:${owned}`).toBe(`${rel}:true`)
    }
  })
})

describe('ensureDesignSystemFiles — staying in step', () => {
  beforeEach(() => {
    writeVendor()
    markBacked()
    ensure()
  })

  it('writes nothing at all on a second run', () => {
    const before = projectMtimes()

    const result = ensure()

    expect(result).toEqual({ written: [], removed: [], skipped: 'up-to-date' })
    expect(projectMtimes()).toEqual(before)
  })

  it('rewrites only the file whose source changed', () => {
    fs.writeFileSync(path.join(sourceDir, 'src', 'components', 'Button.css'), '.btn { color: green }\n')

    const result = ensure()

    expect(result.written).toEqual(['components/Button.css'])
    expect(result.removed).toEqual([])
    expect(fs.readFileSync(path.join(projectDir, 'design-system', 'components', 'Button.css'), 'utf8')).toBe(
      '.btn { color: green }\n',
    )
  })

  it('removes a file that has left the source set', () => {
    fs.rmSync(path.join(sourceDir, 'src', 'components', 'Chip.jsx'))
    fs.rmSync(path.join(sourceDir, 'src', 'components', 'Chip.css'))

    const result = ensure()

    // …and the icon only Chip imported goes with it: the copied icon set is
    // derived from what the copied components import, so dropping a component
    // drops its icons in the same pass.
    expect(result.removed.sort()).toEqual([
      'components/Chip.css',
      'components/Chip.jsx',
      'icons/line-icons/close.svg',
    ])
    expect(folderContents()).not.toContain('icons/line-icons/close.svg')
  })

  it('rewrites the whole folder when a user has deleted it', () => {
    fs.rmSync(path.join(projectDir, 'design-system'), { recursive: true, force: true })

    const result = ensure()

    expect(result.skipped).toBeNull()
    expect(folderContents()).toContain('index.js')
  })

  it('never deletes a file the manifest does not claim', () => {
    // Somebody's own note, sitting in the folder. Studio did not write it, so
    // Studio does not remove it — the manifest is the whole delete list.
    fs.writeFileSync(path.join(projectDir, 'design-system', 'NOTES.md'), 'mine\n')
    fs.rmSync(path.join(sourceDir, 'src', 'tokens', 'tokens.js'))

    const result = ensure()

    expect(result.removed).toEqual(['tokens/tokens.js'])
    expect(fs.existsSync(path.join(projectDir, 'design-system', 'NOTES.md'))).toBe(true)
  })
})

describe('ensureDesignSystemFiles — what the PROJECT itself demands', () => {
  beforeEach(() => {
    writeVendor()
    markBacked()
  })

  /** A page in the project that imports an icon straight out of the folder — what the migration writes. */
  function writePageImporting(specifier: string): void {
    const file = path.join(projectDir, 'pages', 'SMS.tsx')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `import svg from '${specifier}'\nexport default function SMS() { return null }\n`)
  }

  it("copies an icon only the project's own source imports", () => {
    // `never-imported.svg` is the stand-in for the 545 no component wants.
    // The project wanting it is the whole demand.
    writePageImporting('../design-system/icons/line-icons/never-imported.svg?raw')

    ensure()

    expect(folderContents()).toContain('icons/line-icons/never-imported.svg')
  })

  it('takes the icon back out when the last import of it goes away', () => {
    writePageImporting('../design-system/icons/line-icons/never-imported.svg?raw')
    ensure()

    fs.rmSync(path.join(projectDir, 'pages', 'SMS.tsx'))
    const result = ensure()

    expect(result.removed).toEqual(['icons/line-icons/never-imported.svg'])
    expect(folderContents()).not.toContain('icons/line-icons/never-imported.svg')
  })

  it('ignores an import that does not land in the folder, and one naming a file the vendored source has not got', () => {
    writePageImporting('../assets/local-only.svg?raw')
    const first = folderContentsAfter()

    writePageImporting('../design-system/icons/line-icons/does-not-exist.svg?raw')

    // Neither adds anything: one is the project's own asset, the other names
    // an icon Studio cannot supply. A broken import in a user's source is
    // theirs — this never invents a file for it.
    expect(folderContentsAfter()).toEqual(first)
  })

  it('copies a binary asset byte-for-byte', () => {
    ensure()

    const copied = fs.readFileSync(path.join(projectDir, 'design-system', 'icons', 'logotypes', 'card-sample.png'))
    expect(copied.equals(PNG_BYTES)).toBe(true)
  })

  /** `ensure()` then the folder listing — the two-step this describe repeats. */
  function folderContentsAfter(): string[] {
    ensure()
    return folderContents()
  }
})

describe('ensureDesignSystemFiles — refusals', () => {
  it('writes nothing for a project that never asked for a design system', () => {
    writeVendor()

    const result = ensure()

    expect(result).toEqual({ written: [], removed: [], skipped: 'not-design-system-backed' })
    expect(fs.existsSync(path.join(projectDir, 'design-system'))).toBe(false)
  })

  it('writes nothing when a meta names a different design system than this one', () => {
    writeVendor()
    fs.mkdirSync(path.join(projectDir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.studio', 'meta.json'), JSON.stringify({ displayName: 'Mine' }))

    expect(ensure().skipped).toBe('not-design-system-backed')
  })

  it('does nothing, and does not throw, when Studio has no vendored source', () => {
    markBacked()

    expect(ensure()).toEqual({ written: [], removed: [], skipped: 'no-source' })
    expect(fs.existsSync(path.join(projectDir, 'design-system'))).toBe(false)
  })

  it('does nothing for a project directory that does not exist', () => {
    writeVendor()
    expect(ensureDesignSystemFiles(path.join(root, 'nope'), { sourceDir }).skipped).toBe('not-design-system-backed')
  })

  it('refuses a source file that is a symlink pointing out of the vendored package', () => {
    writeVendor()
    markBacked()
    const secret = path.join(root, 'outside-secret.css')
    fs.writeFileSync(secret, 'THE SECRET\n')
    fs.rmSync(path.join(sourceDir, 'src', 'tokens', 'index.css'))
    fs.symlinkSync(secret, path.join(sourceDir, 'src', 'tokens', 'index.css'))

    ensure()

    // Not copied under a different name, not copied at all, and above all not
    // read: containment is checked on the REAL path, after the link resolves.
    expect(folderContents()).not.toContain('tokens/index.css')
    for (const rel of folderContents()) {
      expect(fs.readFileSync(path.join(projectDir, 'design-system', ...rel.split('/')), 'utf8')).not.toContain(
        'THE SECRET',
      )
    }
  })

  it('refuses to write through a design-system folder that is a symlink out of the project', () => {
    writeVendor()
    markBacked()
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(projectDir, 'design-system'))

    const result = ensure()

    expect(result).toEqual({ written: [], removed: [], skipped: 'unsafe-target' })
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('never follows a symlinked directory inside the vendored source', () => {
    writeVendor()
    markBacked()
    const outside = path.join(root, 'outside-dir')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'leak.css'), 'LEAKED\n')
    fs.symlinkSync(outside, path.join(sourceDir, 'src', 'components', 'linked'))

    ensure()

    expect(folderContents()).not.toContain('components/linked/leak.css')
  })
})
