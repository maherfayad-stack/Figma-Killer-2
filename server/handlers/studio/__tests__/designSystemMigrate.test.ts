/**
 * designSystemMigrate — moving a project that still imports the retired
 * `@alm-design/design-system` npm onto its own `design-system/` folder.
 *
 * This is the one place in the whole workstream that REWRITES a user's source
 * and DELETES a directory, so the tests are written as "what must not happen"
 * first:
 *
 *   - Nothing outside `design-system/`, `.studio/`, `package.json` and the
 *     rewritten source files changes. Asserted by hashing the whole project
 *     before and after, not by spot-checking.
 *   - The one deletion is `node_modules/@alm-design/design-system` and its now
 *     empty scope directory. A symlink there is refused, never followed.
 *   - `package.json` keeps its formatting and every other key.
 *
 * The vendored source (DS-1) does not exist on this branch, so the folder half
 * is exercised through `ensureDesignSystemFiles`' own contract — the migration
 * marks the meta and calls it, and this file asserts the marking and the
 * import rewriting, which are the parts it owns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  migrateProjectToBuiltinDesignSystem,
  readDesignSystemMigrateStatus,
} from '../designSystemMigrate'
import { readStudioMeta } from '../studioMeta'

const PKG = '@alm-design/design-system'

let root: string
let projectDir: string

const PACKAGE_JSON = `{
  "name": "studio-project",
  "private": true,
  "type": "module",
  "dependencies": {
    "${PKG}": "^1.1.2",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "scripts": {
    "dev": "vite"
  }
}
`

function write(rel: string, contents: string): void {
  const abs = path.join(projectDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectDir, ...rel.split('/')), 'utf8')
}

/** `relPath -> sha256`, for every file in the project. The whole-tree assertion. */
function treeHashes(): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        seen[rel] = `symlink:${fs.readlinkSync(abs)}`
        continue
      }
      if (entry.isDirectory()) walk(abs, rel)
      else seen[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    }
  }
  walk(projectDir, '')
  return seen
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migrate-'))
  projectDir = path.join(root, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  write('package.json', PACKAGE_JSON)
  write(
    'pages/Home.tsx',
    [
      "import { useState } from 'react'",
      `import { Button } from '${PKG}'`,
      `import '${PKG}/dist/index.css'`,
      "import styles from './Home.module.css'",
      '',
      'export default function Home() {',
      '  const [n] = useState(0)',
      '  return <Button className={styles.a}>{n}</Button>',
      '}',
      '',
    ].join('\n'),
  )
  write('pages/Home.module.css', '.a { color: red }\n')
  write(
    'components/Card.tsx',
    [
      `import { Chip } from '${PKG}'`,
      // A real icon of the vendored design system, so the folder Studio
      // writes can be asserted to actually contain it after the rewrite.
      `import sms from '${PKG}/src/icons/line-icons/sms.svg?raw'`,
      '',
      'export function Card() { return <Chip>{sms}</Chip> }',
      '',
    ].join('\n'),
  )
  write('README.md', '# My project\n')
  // The installed copy, and one sibling package that must survive untouched.
  write('node_modules/@alm-design/design-system/package.json', '{"name":"ds","version":"1.1.2"}')
  write('node_modules/@alm-design/design-system/dist/index.js', 'module.exports = {}')
  write('node_modules/react/package.json', '{"name":"react"}')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readDesignSystemMigrateStatus', () => {
  it('reports a project that still points at the retired package', () => {
    expect(readDesignSystemMigrateStatus(projectDir)).toEqual({
      declaresDependency: true,
      hasInstalledCopy: true,
      importsRetiredPackage: true,
      designSystemBacked: false,
    })
  })

  it('reports nothing to do once the project has been migrated', () => {
    migrateProjectToBuiltinDesignSystem(projectDir)
    const status = readDesignSystemMigrateStatus(projectDir)

    expect(status.declaresDependency).toBe(false)
    expect(status.hasInstalledCopy).toBe(false)
    expect(status.importsRetiredPackage).toBe(false)
  })

  it('reports nothing to do for a project that never used it', () => {
    const clean = path.join(root, 'clean')
    fs.mkdirSync(clean, { recursive: true })
    fs.writeFileSync(path.join(clean, 'package.json'), '{"dependencies":{"react":"^19.0.0"}}')

    expect(readDesignSystemMigrateStatus(clean).importsRetiredPackage).toBe(false)
  })
})

describe('migrateProjectToBuiltinDesignSystem', () => {
  it('rewrites every import to the relative path from the importing file', () => {
    const result = migrateProjectToBuiltinDesignSystem(projectDir)

    expect(read('pages/Home.tsx')).toContain("import { Button } from '../design-system'")
    expect(read('components/Card.tsx')).toContain("import { Chip } from '../design-system'")
    expect(read('components/Card.tsx')).toContain(
      "import sms from '../design-system/icons/line-icons/sms.svg?raw'",
    )
    expect(result.filesRewritten).toBe(2)
    // Two named imports, one sub-path import, one removed stylesheet import.
    expect(result.importsRewritten).toBe(4)
  })

  it('drops the stylesheet side-effect import, which has nowhere left to point', () => {
    migrateProjectToBuiltinDesignSystem(projectDir)
    expect(read('pages/Home.tsx')).not.toContain('index.css')
    // …and leaves the page's OWN stylesheet import exactly where it was.
    expect(read('pages/Home.tsx')).toContain("import styles from './Home.module.css'")
  })

  it('leaves everything the imports did not touch byte-identical', () => {
    migrateProjectToBuiltinDesignSystem(projectDir)

    expect(read('pages/Home.module.css')).toBe('.a { color: red }\n')
    expect(read('README.md')).toBe('# My project\n')
    expect(read('pages/Home.tsx')).toContain('  const [n] = useState(0)')
    expect(read('pages/Home.tsx')).toContain("import { useState } from 'react'")
  })

  it('removes the dependency, keeping the manifest\'s formatting and every other key', () => {
    const result = migrateProjectToBuiltinDesignSystem(projectDir)

    expect(result.removedDependency).toBe(true)
    expect(read('package.json')).toBe(
      PACKAGE_JSON.replace(`    "${PKG}": "^1.1.2",\n`, ''),
    )
  })

  it('removes the dependency when it is the LAST entry in its block', () => {
    write(
      'package.json',
      `{\n  "dependencies": {\n    "react": "^19.2.0",\n    "${PKG}": "^1.1.2"\n  }\n}\n`,
    )

    expect(migrateProjectToBuiltinDesignSystem(projectDir).removedDependency).toBe(true)
    expect(read('package.json')).toBe('{\n  "dependencies": {\n    "react": "^19.2.0"\n  }\n}\n')
    expect(JSON.parse(read('package.json'))).toEqual({ dependencies: { react: '^19.2.0' } })
  })

  it('removes the dependency from devDependencies too', () => {
    write('package.json', `{\n  "devDependencies": {\n    "${PKG}": "^1.1.2",\n    "vite": "^7.0.0"\n  }\n}\n`)

    expect(migrateProjectToBuiltinDesignSystem(projectDir).removedDependency).toBe(true)
    expect(JSON.parse(read('package.json'))).toEqual({ devDependencies: { vite: '^7.0.0' } })
  })

  it('reports no dependency removed for a project that never declared one', () => {
    write('package.json', '{"dependencies":{"react":"^19.2.0"}}')
    expect(migrateProjectToBuiltinDesignSystem(projectDir).removedDependency).toBe(false)
  })

  it('marks the project design-system-backed, so Studio maintains its folder from now on', () => {
    expect(readStudioMeta(projectDir).designSystem).toBeUndefined()
    migrateProjectToBuiltinDesignSystem(projectDir)
    expect(readStudioMeta(projectDir).designSystem).toBe('alm')
  })

  it('preserves everything else already in .studio/meta.json', () => {
    write('.studio/meta.json', JSON.stringify({ displayName: 'My App', pagesDir: 'pages', trust: 'static' }))

    migrateProjectToBuiltinDesignSystem(projectDir)
    const meta = readStudioMeta(projectDir)

    expect(meta.displayName).toBe('My App')
    expect(meta.pagesDir).toBe('pages')
    expect(meta.trust).toBe('static')
    expect(meta.designSystem).toBe('alm')
  })

  it("writes the icons the PROJECT'S OWN source imports, not just the ones a component does", () => {
    // `sms.svg` is demanded by `components/Card.tsx` and by nothing in the
    // design system itself. The migration writes the folder BEFORE the
    // rewrite, when the project still names the retired package and that
    // demand is invisible — so it writes the folder a second time afterwards.
    // Without that, `vite build` in the migrated project died on a missing
    // `../design-system/icons/line-icons/sms.svg`.
    migrateProjectToBuiltinDesignSystem(projectDir)

    expect(fs.existsSync(path.join(projectDir, 'design-system', 'icons', 'line-icons', 'sms.svg'))).toBe(true)
  })

  it('is safe to run twice', () => {
    migrateProjectToBuiltinDesignSystem(projectDir)
    const after = treeHashes()

    const second = migrateProjectToBuiltinDesignSystem(projectDir)

    expect(second).toEqual({ filesRewritten: 0, importsRewritten: 0, removedDependency: false })
    expect(treeHashes()).toEqual(after)
  })
})

describe('migrateProjectToBuiltinDesignSystem — the one deletion', () => {
  it('deletes the installed copy and its now-empty scope directory, and nothing else', () => {
    migrateProjectToBuiltinDesignSystem(projectDir)

    expect(fs.existsSync(path.join(projectDir, 'node_modules', '@alm-design'))).toBe(false)
    // The sibling package is somebody else's and stays.
    expect(fs.existsSync(path.join(projectDir, 'node_modules', 'react', 'package.json'))).toBe(true)
  })

  it('keeps the scope directory when another package shares it', () => {
    write('node_modules/@alm-design/other/package.json', '{"name":"other"}')

    migrateProjectToBuiltinDesignSystem(projectDir)

    expect(fs.existsSync(path.join(projectDir, 'node_modules', '@alm-design', 'design-system'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, 'node_modules', '@alm-design', 'other', 'package.json'))).toBe(true)
  })

  it('refuses a symlinked install rather than following it out of the project', () => {
    const store = path.join(root, 'pnpm-store', 'design-system')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'package.json'), '{"name":"ds"}')
    fs.rmSync(path.join(projectDir, 'node_modules', '@alm-design', 'design-system'), {
      recursive: true,
      force: true,
    })
    fs.symlinkSync(store, path.join(projectDir, 'node_modules', '@alm-design', 'design-system'))

    migrateProjectToBuiltinDesignSystem(projectDir)

    // The link is left exactly as it was, and above all the directory it
    // points at — which is outside the project — still exists.
    expect(fs.existsSync(path.join(store, 'package.json'))).toBe(true)
    expect(fs.lstatSync(path.join(projectDir, 'node_modules', '@alm-design', 'design-system')).isSymbolicLink()).toBe(
      true,
    )
  })

  it('changes nothing outside the folder, the manifest, the meta and the rewritten pages', () => {
    const before = treeHashes()

    migrateProjectToBuiltinDesignSystem(projectDir)
    const after = treeHashes()

    const OWNED = (rel: string): boolean =>
      rel.startsWith('design-system/') ||
      rel.startsWith('.studio/') ||
      rel.startsWith('node_modules/@alm-design/') ||
      rel === 'package.json' ||
      rel === 'pages/Home.tsx' ||
      rel === 'components/Card.tsx'

    for (const [rel, hash] of Object.entries(before)) {
      if (OWNED(rel)) continue
      expect(`${rel}:${after[rel] === hash}`).toBe(`${rel}:true`)
    }
    for (const rel of Object.keys(after)) {
      if (before[rel] !== undefined) continue
      expect(`added ${rel}:${OWNED(rel)}`).toBe(`added ${rel}:true`)
    }
  })
})
