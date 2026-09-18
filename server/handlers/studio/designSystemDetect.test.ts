/**
 * designSystemDetect — decoupling design-system detection from `node_modules`
 * (the fix for `almosafer-ds-expert`/`design-system.md` having nothing to
 * consult for a project whose design system arrived as a plain CSS copy
 * under `styles/imported/<slug>/`, never a real npm install).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDesignSystems } from './designSystemDetect'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'design-system-detect-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(relPath: string, contents = ''): void {
  const full = join(dir, ...relPath.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
}

const identityPrefix = (rel: string): string => rel

describe('detectDesignSystems', () => {
  it('returns nothing when there is neither a node_modules component package nor a styles/imported/ copy', () => {
    expect(detectDesignSystems(dir, [], identityPrefix)).toEqual([])
  })

  /**
   * DS-3 — the built-in design system is declared by the FOLDER Studio writes,
   * not by any dependency. `root` names the project's own copy (what its
   * imports point at); the system's docs and compiled CSS are read from
   * Studio's vendored copy instead — see `designSystemCssRoot`.
   */
  it("reports the built-in design system for a project carrying Studio's folder", () => {
    write('design-system/index.js', 'export {}')
    expect(detectDesignSystems(dir, [], identityPrefix)).toEqual([
      { name: 'alm', source: 'builtin', root: 'design-system' },
    ])
  })

  it('does NOT report it for a folder with no entry file — a half-written copy is not a design system', () => {
    write('design-system/components/Button.jsx', 'export function Button() { return null }')
    expect(detectDesignSystems(dir, [], identityPrefix)).toEqual([])
  })

  it('puts the built-in system FIRST when a project also has an installed package', () => {
    // An unmigrated project mid-migration is exactly this shape. Whatever
    // picks "the" design system (the guide generator, the catalog note)
    // should land on the one the project's own pages import.
    write('design-system/index.js', 'export {}')
    const result = detectDesignSystems(dir, ['acme-ui'], identityPrefix)
    expect(result.map((d) => d.source)).toEqual(['builtin', 'node-modules'])
  })

  it('reports one entry per componentPackages name, app-root-prefixed through the caller-supplied closure', () => {
    const prefixAppRoot = (rel: string): string => `apps/web/${rel}`
    const result = detectDesignSystems(dir, ['@alm-design/design-system'], prefixAppRoot)
    expect(result).toEqual([
      { name: '@alm-design/design-system', source: 'node-modules', root: 'apps/web/node_modules/@alm-design/design-system' },
    ])
  })

  it('reports one entry per immediate styles/imported/<slug>/ subdirectory, root NOT app-root-prefixed', () => {
    write('styles/imported/alm-design-design-system-1-1-3/src/tokens/colors.css', ':root { --color-x: #fff; }')
    write('styles/imported/some-other-system/tokens.css', ':root { --y: 1px; }')

    const prefixAppRoot = (rel: string): string => `SHOULD-NOT-APPEAR/${rel}`
    const result = detectDesignSystems(dir, [], prefixAppRoot)
    expect(result).toEqual([
      { name: 'alm-design-design-system-1-1-3', source: 'imported', root: 'styles/imported/alm-design-design-system-1-1-3' },
      { name: 'some-other-system', source: 'imported', root: 'styles/imported/some-other-system' },
    ])
  })

  it('reports both sources together when a project has an installed dependency AND an imported copy', () => {
    write('styles/imported/legacy-tokens/tokens.css', ':root { --z: 1px; }')
    const result = detectDesignSystems(dir, ['acme-ui'], identityPrefix)
    expect(result).toEqual([
      { name: 'acme-ui', source: 'node-modules', root: 'node_modules/acme-ui' },
      { name: 'legacy-tokens', source: 'imported', root: 'styles/imported/legacy-tokens' },
    ])
  })

  it('never throws when styles/imported/ does not exist at all', () => {
    expect(() => detectDesignSystems(dir, [], identityPrefix)).not.toThrow()
  })

  it('ignores a stray FILE sitting directly in styles/imported/ (only directories are design systems)', () => {
    write('styles/imported/README.txt', 'not a design system')
    expect(detectDesignSystems(dir, [], identityPrefix)).toEqual([])
  })
})
