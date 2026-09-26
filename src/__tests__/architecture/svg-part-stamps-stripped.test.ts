/**
 * svg-part-stamps-stripped — every exit of an inline SVG's markup removes the
 * parser's part stamps (P5-D, SVG-3).
 *
 * `inlineSvg.ts` stamps each element inside a literal `<svg>` with
 * `data-studio-svg-part` / `data-studio-svg-code` so the canvas can address a
 * `<path>` for a write. Those are Studio's bookkeeping. A reader of a
 * `base.svg` node's `props.svg` that hands the markup to anything but the
 * canvas render — an export, a publish, a copy, an agent — would leak them
 * into the user's world.
 *
 * So: every production file that READS `props.svg` (or `props['svg']`) either
 * calls `stripSvgPartStamps`, or is listed below with why the stamps are what
 * it needs. A new reader fails this gate until it decides which it is.
 */
import { describe, expect, it } from 'bun:test'
import { join, relative } from 'node:path'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '../../..')
const SCAN_ROOTS = ['src/admin', 'src/core', 'src/modules', 'src/ui', 'server'].map((dir) => join(REPO_ROOT, dir))

/** Readers that keep the stamps, and why. Paths are repo-relative, POSIX. */
const KEEPS_STAMPS: Readonly<Record<string, string>> = {
  // The canvas render: the stamps ARE the hit test (`closest('[data-studio-svg-part]')`).
  'src/modules/base/svg/SvgEditor.tsx': 'canvas render',
  // Only asks whether a node carries markup at all.
  'server/handlers/studio/moduleMapping.ts': 'presence check',
  // Vector edit mode reads the stamps to address its writes (and re-measures when the markup changes).
  'src/admin/pages/site/canvas/BoardVectorLayer/BoardVectorLayer.tsx': 'vector edit mode',
  'src/admin/pages/site/canvas/BoardVectorLayer/vectorEditEntry.ts': 'vector edit mode entry',
}

/** Exits that take the markup some other way than `props.svg`, pinned by name. */
const KNOWN_EXITS = [
  'src/modules/base/svg/index.ts', // the publisher's render
  'src/admin/pages/site/panels/PropertiesPanel/nodeExportModel.ts', // SVG export
  'src/admin/pages/site/property-controls/SvgControl.tsx', // preview + "Edit code"
  'server/ai/mcp/tools/studio/projectTools.ts', // the agent's node search
]

const READS_SVG_PROP = /\bprops\??\.svg\b|\bprops\[['"]svg['"]\]/

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes('/__tests__/')
}

describe('SVG part stamps never leave Studio', () => {
  it('every reader of props.svg strips the stamps or says why it keeps them', () => {
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of walkSourceTree(root, ['.ts', '.tsx'])) {
        const rel = relative(REPO_ROOT, file).split('\\').join('/')
        if (isTestFile(rel) || rel in KEEPS_STAMPS) continue
        const source = stripComments(readSource(file))
        if (READS_SVG_PROP.test(source) && !source.includes('stripSvgPartStamps(')) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every known exit calls the strip', () => {
    const missing = KNOWN_EXITS.filter((rel) => !stripComments(readSource(join(REPO_ROOT, rel))).includes('stripSvgPartStamps('))
    expect(missing).toEqual([])
  })
})
