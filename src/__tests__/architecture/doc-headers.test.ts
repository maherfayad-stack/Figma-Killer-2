/**
 * Architecture gate — every doc says what it is for and how far to trust it,
 * and no file points an agent at a doc that no longer exists.
 *
 * Agents read docs instead of code, so a doc that is stale, historical or
 * gone does more damage than a missing one: it is followed. Two rules, both
 * from `docs/CONVENTIONS.md` → "The header line":
 *
 *   1. **Every maintained doc carries the header on line 2** (line 1 is the
 *      `# Title`): `> **Purpose:** … · **Read when:** … · **Trust:** … ·
 *      **Owner:** … · **Verified:** …`. Maintained docs are the six root
 *      files, everything under `docs/` outside the three history folders, and
 *      `scripts/bench/README.md`.
 *   2. **Every historical doc says so in its first two lines**
 *      (`docs/archive/`, `docs/audits/`, `docs/state-archive/`): a line
 *      starting `> **Trust:**` or `> **Purpose:**`. The historical form is
 *      `> **Trust:** historical, dated <YYYY-MM-DD>. …`.
 *   3. **No file names a retired doc path** from `DEAD_DOC_PATHS`. A markdown
 *      link checker never sees these: nearly every one of them lived in a
 *      backtick path inside a code comment. History folders are exempt; they
 *      record what was true when they were written.
 *
 * Not covered, on purpose: `vendor/**` (the vendored design-system docs are
 * DATA, parsed by `vendorDocs.ts` — a header would change the manifest),
 * `.agents/**` (third-party skill packs), `examples/**`, `studio-workspace/**`
 * (user data), `.claude/agents/*.md` (frontmatter must stay on line 1) and
 * `.github/PULL_REQUEST_TEMPLATE.md` (pasted into every PR body).
 *
 * @see docs/CONVENTIONS.md — "The header line" and "Check for dead paths"
 */
import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const ROOT_DOCS = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'PROJECT-BRIEF.md', 'STATE.md', 'ROADMAP.md']
const EXTRA_DOCS = ['scripts/bench/README.md']

/** Folders whose docs are dated records: rule 2 instead of rule 1, and exempt from rule 3. */
const HISTORY_PREFIXES = ['docs/archive/', 'docs/audits/', 'docs/state-archive/']

/**
 * Doc paths that no longer exist and that agents kept citing. Add a path here
 * when you retire a doc that code comments are likely to keep naming.
 */
const DEAD_DOC_PATHS = [
  'docs/features/inspector-disclosure.md', // renamed to docs/features/inspector.md
  'docs/features/media.md', // never written
  'docs/features/loops.md', // never written
  'docs/features/site-transfer.md', // never written
  'docs/e2e/feature-matrix.md', // never checked in
]

/** Where rule 3 looks: the code, the maintained docs, the root docs. */
const SCAN_DIRS = ['src', 'server', 'scripts', 'tests', 'docs']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.md', '.json', '.html']

const HEADER = /^> \*\*Purpose:\*\* .+ · \*\*Read when:\*\* .+ · \*\*Trust:\*\* .+ · \*\*Owner:\*\* .+ · \*\*Verified:\*\* .+$/
const HISTORY_HEADER = /^> \*\*(Trust|Purpose):\*\* /

const isHistory = (rel: string): boolean => HISTORY_PREFIXES.some((p) => rel.startsWith(p))

function firstLines(rel: string, n: number): string[] {
  return readSource(join(REPO_ROOT, rel)).replace(/\r\n/g, '\n').split('\n').slice(0, n)
}

const docsTree = walkSourceTree(join(REPO_ROOT, 'docs'), ['.md']).map(toRepoRelativePosix)
const maintainedDocs = [...ROOT_DOCS, ...EXTRA_DOCS, ...docsTree.filter((rel) => !isHistory(rel))]
const historicalDocs = docsTree.filter(isHistory)

describe('doc headers', () => {
  it('finds the docs it is meant to check (the walk is not silently empty)', () => {
    for (const rel of [...ROOT_DOCS, ...EXTRA_DOCS]) expect(existsSync(join(REPO_ROOT, rel))).toBe(true)
    expect(maintainedDocs.length).toBeGreaterThan(60)
    expect(historicalDocs.length).toBeGreaterThan(60)
  })

  it('every maintained doc has the header on line 2, under a # title on line 1', () => {
    const bad: string[] = []
    for (const rel of maintainedDocs) {
      const [title, header] = firstLines(rel, 2)
      if (!title?.startsWith('# ') || !HEADER.test(header ?? '')) bad.push(rel)
    }
    if (bad.length > 0) {
      throw new Error(
        `[doc-headers] These docs lack the line-2 header ` +
          `("> **Purpose:** … · **Read when:** … · **Trust:** … · **Owner:** … · **Verified:** …"):\n` +
          bad.map((r) => `  ${r}`).join('\n') +
          `\n\nSee docs/CONVENTIONS.md → "The header line".`,
      )
    }
    expect(bad).toEqual([])
  })

  it('every historical doc declares itself in its first two lines', () => {
    const bad = historicalDocs.filter((rel) => !firstLines(rel, 2).some((l) => HISTORY_HEADER.test(l)))
    if (bad.length > 0) {
      throw new Error(
        `[doc-headers] These historical docs lack a "> **Trust:** historical, dated <date>. …" line:\n` +
          bad.map((r) => `  ${r}`).join('\n') +
          `\n\nSee docs/CONVENTIONS.md → "The header line".`,
      )
    }
    expect(bad).toEqual([])
  })
})

describe('dead doc paths', () => {
  it('every DEAD_DOC_PATHS entry is actually gone', () => {
    const alive = DEAD_DOC_PATHS.filter((rel) => existsSync(join(REPO_ROOT, rel)))
    expect(alive).toEqual([])
  })

  it('no code, maintained doc or root doc names a retired doc path', () => {
    const self = 'src/__tests__/architecture/doc-headers.test.ts'
    const files = [
      ...ROOT_DOCS,
      ...SCAN_DIRS.flatMap((dir) => walkSourceTree(join(REPO_ROOT, dir), SCAN_EXTENSIONS).map(toRepoRelativePosix)),
    ].filter((rel) => rel !== self && !isHistory(rel))

    const hits: string[] = []
    for (const rel of files) {
      const text = readSource(join(REPO_ROOT, rel))
      for (const dead of DEAD_DOC_PATHS) {
        if (text.includes(dead)) hits.push(`${rel} → ${dead}`)
      }
    }
    if (hits.length > 0) {
      throw new Error(
        `[doc-headers] These files name a doc that no longer exists:\n` +
          hits.map((h) => `  ${h}`).join('\n') +
          `\n\nPoint them at the doc that owns the fact now (docs/README.md is the map).`,
      )
    }
    expect(hits).toEqual([])
  })
})
