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
 * `LayoutSection` migrated to `inspector/sections/LayoutSection.tsx` +
 * `inspector/sections/LayoutSection/` (`STATE.md` `panel-25`, P3 item 4);
 * `TypographySection` migrated to `inspector/sections/TextSection.tsx`
 * (`STATE.md` `panel-25`, P3 item 9) — both updated to their new locations,
 * same scope, same rule. `TextSection.tsx`'s own settings popover
 * (`TextSettingsPopover.tsx`) DOES use `<Select>` (the `whiteSpace` field,
 * ported unchanged from the pre-migration `TypographySettings.tsx`) — this
 * gate was already, and stays, scoped to the RESIDENT section file only, not
 * its popover, matching the pre-migration file's own scope.
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
const LAYOUT_SECTION_DIR = join(SRC_ROOT, 'admin/pages/site/inspector/sections/LayoutSection')
const LAYOUT_SECTION_FILE = join(SRC_ROOT, 'admin/pages/site/inspector/sections/LayoutSection.tsx')
const TYPOGRAPHY_SECTION_FILE = join(
  SRC_ROOT,
  'admin/pages/site/inspector/sections/TextSection.tsx',
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
  const files = [...collectTsxFiles(LAYOUT_SECTION_DIR), LAYOUT_SECTION_FILE, TYPOGRAPHY_SECTION_FILE]

  it.each(files)('%s does not import @ui/components/Select', (file) => {
    const content = readFileSync(file, 'utf8')
    expect(content).not.toMatch(/from ['"]@ui\/components\/Select['"]/)
  })
})
