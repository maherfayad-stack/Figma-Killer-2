/**
 * Architecture Source-Scan — Direct Icon Imports
 *
 * Production UI must import concrete icon components from
 * `pixel-art-icons/icons/<name>` instead of rendering through any lazy `Icon`
 * wrapper. Direct file imports keep the large icon catalog available without
 * adding first-render async loading or importing every icon.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { toPosixPath } from './pathHelpers'

const SRC_ROOT = join(import.meta.dir, '../../')

/**
 * Best-effort stripper of `//` line comments and `/* ... *\/` block comments.
 * Used by architecture tests that need to scan ACTUAL code for forbidden
 * patterns — mentions inside doc comments shouldn't count. Mirrors the
 * helper in db-postgres-isms.test.ts / boundary-validation.test.ts.
 *
 * Not a full parser; nested edge cases (a `//` inside a regex literal) are
 * handled imperfectly. Good enough for grep-style structural checks.
 */
function stripComments(source: string): string {
  let s = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  s = s.replace(/\/\/[^\n]*/g, ' ')
  return s
}

/**
 * Further strips string and template literals on top of stripComments.
 * Used only for the JSX-render check (`<Icon`) — a `<Icon` appearing
 * inside a string literal is not a render either. NOT used for the
 * import-path check, since that check's whole match target (the module
 * specifier) lives inside a string literal.
 *
 * Not a full parser; nested string/comment edge cases (regex literals
 * containing `//`, template literals with `${}` interpolating code) are
 * handled imperfectly. Good enough for grep-style structural checks.
 */
function stripCommentsAndStrings(source: string): string {
  let s = stripComments(source)
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''")
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""')
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``')
  return s
}

function collectFiles(dir: string, exts = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry)) && !/\.test\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry)) {
      results.push(full)
    }
  }
  return results
}

// 'editor', 'app', and 'lib' never existed in this repo's tracked history
// (`git log --all -- src/editor src/app src/lib` is empty) — this list
// silently never scanned `src/admin/`, the largest icon consumer in the
// codebase (toolbar, panels, dialogs). 'admin' is the real directory;
// 'core', 'modules', 'ui' already existed and were being scanned.
const PROD_DIRS = ['admin', 'core', 'modules', 'ui'].map((d) =>
  join(SRC_ROOT, d),
)

function collectProdFiles(): string[] {
  return PROD_DIRS.flatMap((dir) => collectFiles(dir))
}

describe('Direct icon imports — no lazy Icon wrapper in production UI', () => {
  it('production source does not import a lazy pixel-art-icons/Icon wrapper or render <Icon>', () => {
    const violations: string[] = []

    for (const filePath of collectProdFiles()) {
      const rel = toPosixPath(filePath.replace(SRC_ROOT, 'src/'))

      const raw = readFileSync(filePath, 'utf8')
      const sourceNoComments = stripComments(raw)
      const sourceNoCommentsOrStrings = stripCommentsAndStrings(raw)
      if (
        /from\s+['"]pixel-art-icons\/Icon['"]/.test(sourceNoComments) ||
        /<Icon\b/.test(sourceNoCommentsOrStrings)
      ) {
        violations.push(rel)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Lazy Icon wrapper usage found in production UI.\n` +
          `Import concrete icons from 'pixel-art-icons/icons/<name>' instead.\n\n` +
          violations.map((f) => `  ${f}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
