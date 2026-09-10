/**
 * Architecture gate — FrameDocumentAdapter isolation.
 *
 * "The canvas DOM must be the DOM React renders" (`canvas-engineer`'s own
 * rule book) is enforced structurally, not just by review: after `live-05`,
 * `PortalFrameAdapter.ts` is the ONLY file under
 * `src/admin/pages/site/canvas/` allowed to hold a `Document` reference for
 * canvas rendering purposes. Every other injector/hook reads a
 * `FrameDocumentAdapter` from context instead of a raw `targetDocument`/
 * `contentDocument`/`contentWindow`, so a cross-origin Tier 2 frame
 * (`BridgeFrameAdapter`) can drive the exact same call sites a same-origin
 * frame does.
 *
 * Modeled on `live-origin-isolation.test.ts`'s grep-based scan pattern —
 * this is a structural gate proven by source text, not a running-canvas
 * test.
 *
 * `frameAdapter/BridgeFrameAdapter.ts` legitimately uses the word `Document`
 * in prose comments (documenting why it does NOT hold one) but must not
 * declare a `Document`-typed field or parameter — the scan below strips
 * comments first so prose never trips it, matching `live-origin-isolation`'s
 * own "blank out comments, check code" technique.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const CANVAS_DIR = join(REPO_ROOT, 'src/admin/pages/site/canvas')

/** Files allowed to hold a real `Document` — the portal adapter itself, and its own direct test file. */
const ALLOWLIST = new Set([
  'src/admin/pages/site/canvas/frameAdapter/PortalFrameAdapter.ts',
  'src/__tests__/canvas/frameAdapter/PortalFrameAdapter.test.ts',
])

const BANNED_PATTERNS: RegExp[] = [
  /\bcontentDocument\b/,
  /:\s*Document\b/,
  /<\s*Document\s*>/,
  /\bcontentWindow\b/,
]

function collectFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.tmp' || entry === 'dist') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

/** Blanks out `/* *\/` block comments and `//` line comments while preserving line/column positions, so prose mentioning "Document" never trips the scan below — same technique `live-origin-isolation.test.ts` uses for "cookie". */
function stripComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  return blanked.replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
}

describe('frame-document-adapter isolation gate', () => {
  const files = collectFiles(CANVAS_DIR)
    // Also scan this gate's own two test files, co-located under
    // `src/__tests__/canvas/frameAdapter/` rather than `canvas/` itself.
    .concat(collectFiles(join(REPO_ROOT, 'src/__tests__/canvas/frameAdapter')))

  it('found at least one file to scan (the scan itself is not silently vacuous)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // SKIPPED until Batches 2-7 of `live-05` (STATE.md) actually migrate every
  // injector/hook off a direct `Document` reference — as of Batch 1 (this
  // commit), the new adapter files exist but nothing calls them yet, so
  // every one of the ~47 files listed in that entry's file-by-file plan
  // still legitimately holds a `Document`. This gate is written and correct
  // NOW so batches 2-7 have an exact, ready-to-run pass/fail bar — but it
  // must stay skipped (not deleted, not weakened) until the migration is
  // actually done, or `bun test` breaks for everyone on a half-finished
  // work order. Un-skip this in the SAME commit that finishes Batch 7.
  it.skip('no stray Document/contentDocument/contentWindow usage outside PortalFrameAdapter.ts and its own test file', () => {
    const violations: string[] = []
    for (const file of files) {
      const relPath = relative(REPO_ROOT, file).replaceAll('\\', '/')
      if (ALLOWLIST.has(relPath)) continue
      const codeOnly = stripComments(readFileSync(file, 'utf8'))
      const lines = codeOnly.split('\n')
      lines.forEach((line, index) => {
        for (const pattern of BANNED_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`  ${relPath}:${index + 1}: ${line.trim()}`)
            break
          }
        }
      })
    }
    if (violations.length > 0) {
      throw new Error(
        `[frame-document-adapter-isolation] Document/contentDocument/contentWindow usage found outside PortalFrameAdapter.ts:\n${violations.join('\n')}`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
