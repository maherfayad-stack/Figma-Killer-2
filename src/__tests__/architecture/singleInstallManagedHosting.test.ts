import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../../..')
const RUNTIME_SOURCE_ROOTS = ['server', 'src/admin', 'src/core']

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('Single-install CMS architecture', () => {
  it('keeps the CMS database single-site instead of tenant-scoped', () => {
    const pg = read('server/db/migrations-pg.ts')
    const sqlite = read('server/db/migrations-sqlite.ts')

    for (const src of [pg, sqlite]) {
      expect(src).toContain('create table if not exists site')
      expect(src).not.toMatch(/\bcreate table\s+if not exists\s+sites\b/i)
      expect(src).not.toMatch(/\buser_site_/)
      expect(src).not.toMatch(/\bsite_id\b/)
    }
  })

  it('does not keep runtime tenant or CMS-internal multi-site identifiers', () => {
    const forbidden = [
      /\btenant_id\b/i,
      /\bworkspace_id\b/i,
      /\buser_site_/i,
      /\bmulti-site-ready\b/i,
      /\btenant-aware\b/i,
      /\bcross-site\b/i,
      /\bsite picker\b/i,
    ]

    /**
     * `cross-site` is also a `Sec-Fetch-Site` HEADER VALUE, and that meaning
     * has nothing to do with CMS tenancy — it is the browser saying "another
     * site caused this request". `sec-16` made `originAllowed` read it, so
     * that one word now appears in the CSRF check and in the test that drives
     * it. Named here, per file and per pattern, rather than softening the
     * pattern for the whole tree: a new file that says `cross-site` still
     * fails until someone justifies it in this list.
     */
    const allowed = new Map<string, RegExp>([
      [join('server', 'auth', 'security.ts'), /\bcross-site\b/i],
      [join('server', 'handlers', '__tests__', 'designImport.test.ts'), /\bcross-site\b/i],
    ])

    const offenders: string[] = []
    for (const root of RUNTIME_SOURCE_ROOTS) {
      for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync(join(ROOT, root))) {
        const path = join(root, file)
        const src = read(path)
        for (const pattern of forbidden) {
          if (allowed.get(path)?.source === pattern.source) continue
          if (pattern.test(src)) offenders.push(`${path}: ${pattern}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
