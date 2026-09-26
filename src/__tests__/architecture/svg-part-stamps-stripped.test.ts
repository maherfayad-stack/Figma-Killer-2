/**
 * svg-part-stamps-stripped — the parser's SVG part stamps never leave Studio,
 * and nothing removes them by editing finished markup (P5-D, SVG-3).
 *
 * `inlineSvg.ts` stamps each element inside a literal `<svg>` with
 * `data-studio-svg-part` / `data-studio-svg-code` so the canvas can address a
 * `<path>` for a write. The default `sanitizeSvg` profile FORBIDS both
 * attributes, so every exit that sanitizes drops them on the DOM; only the
 * canvas render opts out (`keepPartStamps`).
 *
 * Security review #269 B1 is why there is no string strip at all: a regex run
 * over markup AFTER sanitizing matched a look-alike stamp inside `<text>`,
 * deleted across a tag boundary, and turned sanitized markup into a live
 * `<img onerror>` on the published page.
 *
 * So:
 *   1. every production file that READS `props.svg` (or `props['svg']`)
 *      sanitizes it (`sanitizeSvg(`), or is listed below with why;
 *   2. only the canvas render may ask the sanitizer to keep the stamps;
 *   3. no production code edits markup with a stamp regex.
 */
import { describe, expect, it } from 'bun:test'
import { join, relative } from 'node:path'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '../../..')
const SCAN_ROOTS = ['src/admin', 'src/core', 'src/modules', 'src/ui', 'server'].map((dir) => join(REPO_ROOT, dir))

/** Readers that do not sanitize themselves, and why. Paths are repo-relative, POSIX. */
const EXEMPT_READERS: Readonly<Record<string, string>> = {
  // Reads what `escapeProps` already sanitized with the default (stamp-forbidding) profile.
  'src/modules/base/svg/index.ts': 'publish render of already-sanitized markup',
  // Only asks whether a node carries markup at all.
  'server/handlers/studio/moduleMapping.ts': 'presence check',
  // Vector edit mode reads the stamps to address its writes; nothing it reads is emitted.
  'src/admin/pages/site/canvas/BoardVectorLayer/BoardVectorLayer.tsx': 'vector edit mode',
  'src/admin/pages/site/canvas/BoardVectorLayer/vectorEditEntry.ts': 'vector edit mode entry',
}

/** The one file allowed to keep the stamps through the sanitizer. */
const KEEPS_STAMPS = 'src/modules/base/svg/SvgEditor.tsx'

const READS_SVG_PROP = /\bprops\??\.svg\b|\bprops\[['"]svg['"]\]/
const STAMP_REGEX_EDIT = /data-studio-svg-\(\?:|data-studio-svg-(?:part|code)[^\n]*\.replace\(|\.replace\([^\n]*data-studio-svg/

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function productionFiles(): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of walkSourceTree(root, ['.ts', '.tsx'])) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/')
      if (!isTestFile(rel)) out.push({ rel, source: stripComments(readSource(file)) })
    }
  }
  return out
}

describe('SVG part stamps never leave Studio', () => {
  const files = productionFiles()

  it('every reader of props.svg sanitizes it or says why it does not', () => {
    const offenders = files
      .filter(({ rel, source }) => !(rel in EXEMPT_READERS) && READS_SVG_PROP.test(source) && !source.includes('sanitizeSvg('))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('only the canvas render keeps the stamps through the sanitizer', () => {
    const offenders = files.filter(({ rel, source }) => rel !== KEEPS_STAMPS && source.includes('keepPartStamps: true')).map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('no production code removes stamps by editing markup (review #269 B1)', () => {
    const offenders = files.filter(({ source }) => STAMP_REGEX_EDIT.test(source)).map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })
})
