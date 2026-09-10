/**
 * P2 rule 4 — "enum-like values are icon toggle groups, not selects."
 *
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P2 rule 4: flex direction, wrap,
 * justify/align, text align, decoration, case — one click, no menu. The
 * conversion pass over `LayoutSection`'s and `TypographySection`'s
 * remaining `<Select>`s landed before `panel-21` (both already build on
 * `SegmentedControl`); this gate is what keeps it that way — a regression
 * that reintroduces a `<Select>` for an enum-like property in either file
 * fails here instead of being noticed on the next Penpot-fidelity pass.
 *
 * Scoped to exactly the two files/folders the plan names — this is not a
 * blanket "no Select in the inspector" rule. Plenty of inspector fields
 * (font family, target page, alignment inside a popover with many options)
 * are legitimately a `<Select>`; only these two own the enum-like controls
 * P2 rule 4 is about.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const LAYOUT_SECTION_DIR = join(SRC_ROOT, 'admin/pages/site/panels/PropertiesPanel/LayoutSection')
const TYPOGRAPHY_SECTION_FILE = join(
  SRC_ROOT,
  'admin/pages/site/panels/PropertiesPanel/TypographySection.tsx',
)

function collectTsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsxFiles(full))
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('P2 rule 4 — no <Select> reintroduced in LayoutSection / TypographySection', () => {
  const files = [...collectTsxFiles(LAYOUT_SECTION_DIR), TYPOGRAPHY_SECTION_FILE]

  it.each(files)('%s does not import @ui/components/Select', (file) => {
    const content = readFileSync(file, 'utf8')
    expect(content).not.toMatch(/from ['"]@ui\/components\/Select['"]/)
  })
})
