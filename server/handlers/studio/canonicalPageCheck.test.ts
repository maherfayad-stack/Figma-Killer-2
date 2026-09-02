/**
 * canonicalSummaryForFile — the shared wrapper `studio_read_file`
 * (`projectTools.ts`) and `studio_screenshot` (A6, STUDIO-FIGMA-PARITY-PLAN.md)
 * both call. Exercised against the committed WS-13 reference fixture
 * (`studio-workspace/__canonical-fixture/`), the same one
 * `canonicalCheck.test.ts` uses — that fixture IS the verification target.
 */
import { describe, expect, it } from 'bun:test'
import * as path from 'node:path'
import { canonicalSummaryForFile } from './canonicalPageCheck'

const FIXTURE_DIR = path.join(import.meta.dir, '..', '..', '..', 'studio-workspace', '__canonical-fixture')

describe('canonicalSummaryForFile', () => {
  it('reports zero violations for the canonical fixture screen', () => {
    const rel = 'src/screens/CanonicalScreen.tsx'
    const summary = canonicalSummaryForFile(path.join(FIXTURE_DIR, rel), FIXTURE_DIR, rel)
    expect(summary).toBeDefined()
    expect(summary!.isCanonical).toBe(true)
    expect(summary!.violations).toBe(0)
  })

  it('reports violations for the non-canonical fixture screen', () => {
    const rel = 'src/screens/NonCanonicalScreen.tsx'
    const summary = canonicalSummaryForFile(path.join(FIXTURE_DIR, rel), FIXTURE_DIR, rel)
    expect(summary).toBeDefined()
    expect(summary!.isCanonical).toBe(false)
    expect(summary!.violations).toBeGreaterThan(0)
  })

  it('skips a file that is not page-shaped (.css) rather than force-parsing it', () => {
    const rel = 'src/components/PlanCard.module.css'
    const summary = canonicalSummaryForFile(path.join(FIXTURE_DIR, rel), FIXTURE_DIR, rel)
    expect(summary).toBeUndefined()
  })
})
