/**
 * Architecture Gate — placement-kind-single-source
 *
 * "Does this parent place its children (flex / grid)?" has ONE definition:
 * `src/core/studio-runtime/placementKind.ts` (`isAutoLayoutDisplay`,
 * `autoLayoutFamily`, `parentPlacementKind`, `resolvePlacement`). The
 * placement consumers — drag, nudge, align, spacing handles, draw, drop —
 * must ask it, not re-test `display.includes('flex' | 'grid')` themselves, or
 * the answers drift.
 *
 * Not covered, deliberately: `dropAxisRules.ts` (resolves a flow AXIS, not
 * who places children, and ships inside the runtime bundle).
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const ROOT = join(import.meta.dir, '../../../')
const SCANNED = ['src/admin/pages/site/canvas', 'src/admin/pages/site/store/slices/site']
const DISPLAY_TEST = /display\w*\s*\.\s*(includes|startsWith|endsWith)\(\s*['"](flex|grid)['"]/

function files(dir: string): string[] {
  return walkSourceTree(join(ROOT, dir), ['.ts', '.tsx'])
}

describe('placement-kind-single-source', () => {
  it('no canvas / site-store file tests display for flex or grid itself', () => {
    const offenders = SCANNED.flatMap(files).filter((abs) => DISPLAY_TEST.test(readSource(abs))).map(toRepoRelativePosix)
    expect(offenders).toEqual([])
  })

  it('the arrow-move file no longer defines its own isAutoLayout', () => {
    expect(readSource(join(ROOT, 'src/admin/pages/site/canvas/canvasNodeArrowMove.ts'))).not.toContain('function isAutoLayout')
  })
})
