/**
 * Architecture gate — the `@alm-design/design-system` npm is retired.
 *
 * Studio's design system is BUILT IN: its source is vendored at
 * `vendor/alm-design-system/` (Studio renders the `alm.*` pack from that copy,
 * at every trust tier) and a DS-backed project carries its own
 * `<project>/design-system/` folder so the repository builds standalone. The
 * npm package that used to supply both is gone from `package.json`, from
 * `bun.lock`, and from every install on disk — so anything that still reaches
 * for it does not resolve, and the failure is a build error a long way from
 * its cause. (`meta-12` hit exactly that: `designSystemPreviewSheet.ts`
 * imported the retired specifier and only built because a stale
 * `node_modules/@alm-design` had survived `bun install`.)
 *
 * ## What this gate bans, and what it deliberately does not
 *
 * The string itself is NOT banned. It appears, honestly, in ~50 files: doc
 * comments recording a measurement against the real package ("27 of 226 colour
 * tokens"), prose explaining what a module replaced, and test fixtures that
 * build the SOURCE of an unmigrated project — which genuinely still imports
 * the npm, and is exactly the case the `kind: 'package'` path exists to
 * handle. An exact-path allowlist over that set would be fifty entries that
 * churn on every doc-comment edit while catching nothing.
 *
 * So the rule is about REACHABLE positions, not about the characters:
 *
 *   1. **Nothing imports it.** No `from '@alm-design/…'`, `import '@alm-design/…'`,
 *      `import('@alm-design/…')` or `require('@alm-design/…')` anywhere under
 *      `src/`, `server/` or `scripts/`. No allowed callers.
 *   2. **Nothing declares it.** No `@alm-design/*` key in any dependency block
 *      of the root `package.json` or the vendored package's own, and no
 *      `@alm-design/` entry in `bun.lock`.
 *   3. **Nothing spells it in CODE.** Outside a comment, in a non-test file
 *      under those three directories, the specifier may appear only in the
 *      allowlist below — which is one file: the migration that exists to find
 *      and rewrite it.
 *   4. **No doc shows it as live example code.** In the agent-facing and
 *      feature/reference docs, `PROJECT-BRIEF.md`, `CLAUDE.md` and the vendored
 *      package's own `README.md`/`package.json`, no line may present it as an
 *      import or a dependency entry. Prose about the package it used to be is
 *      fine and is most of what is left.
 *
 * Test files are exempt from rules 1 and 3 on purpose: a fixture embeds
 * `import { Button } from '@alm-design/design-system'` inside a string, which
 * is source text for a project under test, not an import of this repository's.
 * A test that genuinely imported the package would fail to resolve under
 * `bun test`, which is a louder gate than this one.
 *
 * `docs/state-archive/`, `docs/audits/`, `STATE.md` and the `STUDIO-*-PLAN.md`
 * files are excluded outright — they are a written record of what was true
 * when they were written, and rewriting history to please a grep is worse than
 * the grep failing.
 *
 * @see server/handlers/studio/designSystemMigrate.ts — the one allowed caller
 * @see vendor/alm-design-system/ — what replaced the npm
 */

import { describe, it, expect } from 'bun:test'
import { CACHED_EXTENSIONS, readSource, walkSourceTree } from './helpers/sourceTree'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../../')

/** The scope, and the package prefix. Every sub-path of the scope is banned too. */
const SCOPE = '@alm-design/'
const SPECIFIER = '@alm-design/design-system'

/** Directories whose source this gate reads. */
const CODE_DIRS = ['src', 'server', 'scripts']

/** Extensions that carry a module graph. */
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'])

/**
 * Files that may spell the specifier in CODE (rule 3), by exact repo-relative
 * path, each with the reason it is allowed.
 */
const CODE_ALLOWLIST: Record<string, string> = {
  // `RETIRED_DESIGN_SYSTEM_PACKAGE` — the specifier this module's whole job is
  // to find in a user's source and rewrite to `'../design-system'`. It cannot
  // do that without naming it.
  'server/handlers/studio/designSystemMigrate.ts': 'the migration that retires the specifier',
}

/** Docs scanned by rule 4. A directory is scanned recursively; a file is scanned alone. */
const DOC_TARGETS = [
  'docs/agent-refs',
  'docs/features',
  'docs/reference',
  'PROJECT-BRIEF.md',
  'CLAUDE.md',
  'vendor/alm-design-system/README.md',
  'vendor/alm-design-system/package.json',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/')
}

// Both callers below filter on extension, and both sets sit inside the shared
// cache's extension list, so narrowing the walk to it changes nothing.
const collectFiles = (dir: string, keep: (name: string) => boolean): string[] =>
  walkSourceTree(dir, CACHED_EXTENSIONS).filter((f) => keep(basename(f)))

/** A test file or a fixture — exempt from rules 1 and 3, see the module doc. */
function isTestFile(rel: string): boolean {
  return (
    /\.test\.(ts|tsx|js|jsx)$/.test(rel) ||
    rel.includes('/__tests__/') ||
    rel.startsWith('tests/')
  )
}

/**
 * The file with every `//` and block comment blanked out, so rule 3 reads only
 * what the compiler reads. Crude on purpose — a `//` inside a string literal
 * truncates that line — which is safe here: a false positive would only ever
 * HIDE a violation on a line that also contains a `//`, and rule 1 catches the
 * one shape that actually breaks a build regardless.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

/** Every `@alm-design/*` key in any dependency block of a parsed manifest. */
function dependencyKeys(manifest: Record<string, unknown>): string[] {
  const blocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  const found: string[] = []
  for (const block of blocks) {
    const value = manifest[block]
    if (value === null || typeof value !== 'object') continue
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.startsWith(SCOPE)) found.push(`${block}.${key}`)
    }
  }
  return found
}

const IMPORT_RE = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]@alm-design\/`,
)

/** A doc line presenting the specifier as live code: an import statement or a dependency entry. */
const DOC_LIVE_USE_RE = new RegExp(
  String.raw`(?:\bfrom\s+|\bimport\s+|\brequire\(\s*)['"]@alm-design\/|"@alm-design\/[^"]*"\s*:`,
)

const codeFiles = CODE_DIRS.flatMap((dir) =>
  collectFiles(join(REPO_ROOT, dir), (name) => CODE_EXTENSIONS.has(extname(name))),
)
  .map(repoRelative)
  // A gate test necessarily embeds the literal it bans.
  .filter((rel) => !rel.includes('__tests__/architecture/'))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('no-alm-npm-specifier — the design-system npm is retired', () => {
  it('scans a real file set (the walk is not silently empty)', () => {
    expect(codeFiles.length).toBeGreaterThan(500)
  })

  it('rule 1 — nothing under src/, server/ or scripts/ imports it', () => {
    const violations: string[] = []
    for (const rel of codeFiles) {
      if (isTestFile(rel)) continue
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8')
      if (IMPORT_RE.test(source)) violations.push(rel)
    }
    expect(violations).toEqual([])
  })

  it('rule 2 — no manifest and no lockfile declares it', () => {
    const declared: string[] = []
    for (const manifestPath of ['package.json', 'vendor/alm-design-system/package.json']) {
      const abs = join(REPO_ROOT, manifestPath)
      if (!existsSync(abs)) continue
      const parsed: unknown = JSON.parse(readSource(abs))
      if (parsed === null || typeof parsed !== 'object') continue
      for (const key of dependencyKeys(parsed as Record<string, unknown>)) {
        declared.push(`${manifestPath}: ${key}`)
      }
    }
    const lock = join(REPO_ROOT, 'bun.lock')
    // `bun.lock` has no extension the shared tree cache holds, so this one
    // read stays on node:fs.
    if (existsSync(lock) && readFileSync(lock, 'utf8').includes(SCOPE)) {
      declared.push('bun.lock: an @alm-design/ entry survives — run `bun install`')
    }
    expect(declared).toEqual([])
  })

  it('rule 3 — only the migration spells it in code; everywhere else it is prose', () => {
    const violations: string[] = []
    for (const rel of codeFiles) {
      if (isTestFile(rel) || CODE_ALLOWLIST[rel] !== undefined) continue
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'))
      if (code.includes(SCOPE)) violations.push(rel)
    }
    expect(violations).toEqual([])
  })

  it('rule 3 — every allowlisted file still needs its entry', () => {
    const stale: string[] = []
    for (const rel of Object.keys(CODE_ALLOWLIST)) {
      const abs = join(REPO_ROOT, rel)
      if (!existsSync(abs)) {
        stale.push(`${rel} (file is gone)`)
        continue
      }
      if (!stripComments(readSource(abs)).includes(SCOPE)) {
        stale.push(`${rel} (no longer spells it — drop the allowlist entry)`)
      }
    }
    expect(stale).toEqual([])
  })

  it('rule 4 — no live doc shows it as an import or a dependency', () => {
    const violations: string[] = []
    for (const target of DOC_TARGETS) {
      const abs = join(REPO_ROOT, target)
      if (!existsSync(abs)) continue
      const files = statSync(abs).isDirectory()
        ? collectFiles(abs, (name) => extname(name) === '.md')
        : [abs]
      for (const file of files) {
        const rel = repoRelative(file)
        readSource(file)
          .split('\n')
          .forEach((line, index) => {
            if (DOC_LIVE_USE_RE.test(line)) violations.push(`${rel}:${index + 1}`)
          })
      }
    }
    expect(violations).toEqual([])
  })

  it('names the replacement, so a failure says where to go instead', () => {
    // A guard on the premise: if the vendored package ever disappears, this
    // whole gate is asserting a rule with nothing behind it.
    expect(existsSync(join(REPO_ROOT, 'vendor/alm-design-system/package.json'))).toBe(true)
    expect(SPECIFIER.startsWith(SCOPE)).toBe(true)
  })
})
