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
