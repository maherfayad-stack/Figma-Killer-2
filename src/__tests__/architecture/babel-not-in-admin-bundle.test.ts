/**
 * Architecture gate — `@babel/core`/`@babel/types` never reach the admin
 * (browser) bundle.
 *
 * `idStamp.ts` needs a real JS/JSX/TS parser to stamp `data-node-id` on a
 * user's source text, and `@babel/core` is the one already vendored for it
 * (see that file's header — zero new npm packages). But `idStamp.ts` and the
 * `vitePlugin.ts` that calls it only ever run in TWO places: the server-side
 * `scripts/sync-studio-runtime.ts` bundling step, and — once bundled — inside
 * a user's own workspace Vite/Node process, which is a different machine
 * process entirely from the admin SPA. If either file, or `@babel/core`
 * itself, were ever imported from `src/admin/` (directly or transitively
 * through `@core/studio-runtime`'s own barrel), Studio's browser bundle would
 * silently gain several hundred KB of a parser it can never use — the exact
 * mistake `INLINE_ID_SEPARATOR`'s mirroring convention and the page-parser
 * barrel's ts-morph isolation already exist to prevent one module over.
 *
 * Two rules, checked independently:
 *   1. `@core/studio-runtime`'s own barrel (`index.ts`) must not re-export
 *      anything from `idStamp.ts` or `vitePlugin.ts`.
 *   2. No file under `src/admin/` may import `@babel/core`, `@babel/types`,
 *      or reach into `@core/studio-runtime/{idStamp,vitePlugin}` by a deep
 *      import (which would bypass rule 1's barrel entirely).
 */
import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const BARREL_PATH = join(REPO_ROOT, 'src/core/studio-runtime/index.ts')

const BANNED_IMPORT_RE =
  /from\s+['"](@babel\/core|@babel\/types|@core\/studio-runtime\/idStamp|@core\/studio-runtime\/vitePlugin|\.\.?\/.*\/(idStamp|vitePlugin))['"]/

function collectFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tmp' || entry === 'dist') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...collectFiles(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full)
  }
  return out
}

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/')
}

describe('babel-not-in-admin-bundle gate', () => {
  it('the studio-runtime barrel does not re-export idStamp.ts or vitePlugin.ts', () => {
    const content = readFileSync(BARREL_PATH, 'utf8')
    expect(content).not.toMatch(/from\s+['"]\.\/idStamp['"]/)
    expect(content).not.toMatch(/from\s+['"]\.\/vitePlugin['"]/)
  })

  it('no file under src/admin/ imports @babel/* or reaches idStamp.ts/vitePlugin.ts directly', () => {
    const files = collectFiles(join(REPO_ROOT, 'src/admin'))
    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      if (BANNED_IMPORT_RE.test(content)) violations.push(repoRelative(file))
    }
    if (violations.length > 0) {
      throw new Error(
        `[babel-not-in-admin-bundle] disallowed import found in:\n${violations.map((v) => `  ${v}`).join('\n')}\n\n` +
          `idStamp.ts/vitePlugin.ts (and @babel/core/@babel/types) only ever run server-side ` +
          `(scripts/sync-studio-runtime.ts) or inside a user workspace's own Vite/Node process — ` +
          `never in the admin browser bundle. Use @core/studio-runtime's barrel for anything else.`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
