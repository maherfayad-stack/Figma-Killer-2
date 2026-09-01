/**
 * Architecture gate — D2 (`STUDIO-FIGMA-PARITY-PLAN.md`). Studio's drag-and-
 * drop is NOT unified yet: three incompatible mechanisms coexist (raw
 * pointer events, `@dnd-kit/core`, native HTML5 `dataTransfer`). This gate
 * does not — and cannot honestly — assert "one mechanism" today. What it
 * asserts instead: the two NON-primary mechanisms (`@dnd-kit/core`, native
 * HTML5 DnD) are CONTAINED to the exact files that already use them, so
 * future changes don't make an eventual migration to the target
 * `dragSession` architecture (raw pointer events, singular) any harder than
 * it already is. A new file reaching for `@dnd-kit/core` or native
 * `dataTransfer` outside the allowlists below is a NEW
 * instance of the exact fragmentation D2 exists to undo — fails here instead
 * of shipping.
 *
 * **What is NOT gated (honest scope, not an oversight):**
 * - Raw pointer-event drag hooks (canvas reorder, board furniture, module
 *   palette, media→canvas, floating panels, marquee) have no common
 *   `dragSession` singleton yet (D2's target architecture) — there is no
 *   banned PATTERN to scan for here, only a banned pattern for the mechanisms
 *   being phased OUT. Grepping for `pointermove`/`onPointerDown` and
 *   asserting they all route through one module would be asserting something
 *   that isn't true yet.
 * - Test files (`__tests__` anywhere in the path) are excluded: a test that
 *   renders `<DomPanel>` legitimately wraps it in the SAME `<DndContext>`
 *   the component needs to mount at all — that is correct test setup, not
 *   mechanism spread.
 *
 * When D2's `dragSession` unification lands and `@dnd-kit/core` is fully
 * removed, DELETE the allowlists below (not just empty them) and tighten
 * this gate to a flat ban across all of `src/admin`.
 *
 * @see STUDIO-FIGMA-PARITY-PLAN.md — D2, "the target architecture"
 * @see docs/reference/canvas-dnd.md — current-state DnD reference
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const SCAN_ROOT = join(SRC_ROOT, 'admin')

// ─── Allowlists ──────────────────────────────────────────────────────────────

/**
 * Files permitted to import from `@dnd-kit/core`. Two surfaces, both
 * pre-existing: the layer tree (DOM panel) and the site explorer tree.
 * D2's proposed fix removes `@dnd-kit/core` entirely (it cannot cross the
 * iframe boundary, which is exactly why the canvas's OWN pointer-based
 * reorder drag was hand-rolled in the first place) — deferred out of this
 * pass; see this task's own handoff (`scratchpad/phase0/handoff-d2-d3-dnd.md`)
 * for the precise remaining work.
 */
const DND_KIT_ALLOWLIST: ReadonlySet<string> = new Set([
  // Outer `<DndContext>` mount point for the whole editor body.
  'admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx',
  // Layer tree (DOM panel) reorder drag.
  'admin/pages/site/panels/DomPanel/DomPanel.tsx',
  'admin/pages/site/panels/DomPanel/TreeNode.tsx',
  'admin/pages/site/panels/DomPanel/useDomPanelDnd.ts',
  // Site Explorer (pages/folders) reorder drag.
  'admin/pages/site/panels/SiteExplorerPanel/useSiteExplorerDnd.ts',
  'admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeRows.tsx',
  'admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeSection.tsx',
  'admin/pages/site/panels/SiteExplorerPanel/SiteExplorerDndScope.tsx',
  // Pointer-math helper shared by the dnd-kit hooks above (type-only import
  // of `DragMoveEvent`/`DragEndEvent` — reconstructs a live pointer position
  // from dnd-kit's activator-event + delta shape).
  'admin/lib/dndPointer.ts',
])

/**
 * Files permitted to use native HTML5 drag-and-drop — detected by the bare
 * word `dataTransfer` OR React's native `DragEvent<…>` type (a component
 * that only forwards `onDragStart`/`onDragOver`/`onDrop` callbacks it
 * receives as props, like `MediaCanvasItems.tsx`, never touches
 * `.dataTransfer` itself but still wires the native attributes onto real DOM
 * elements). Neither signal collides with dnd-kit: its synthetic drag events
 * have no `dataTransfer` property and use their own event types, never
 * React's `DragEvent`. All pre-existing media-workspace surfaces plus the
 * file-drop targets shared with it. G15 (file drop onto the canvas / Studio
 * importer) is a real, disclosed gap — not covered by this allowlist
 * because it does not exist yet; see the handoff.
 */
const NATIVE_HTML5_DND_ALLOWLIST: ReadonlySet<string> = new Set([
  'admin/shared/media/utils/mediaDragDrop.ts',
  'admin/shared/media/hooks/useMediaDnd.ts',
  'admin/shared/media/components/MediaCanvas/MediaCanvas.tsx',
  'admin/shared/media/components/MediaCanvas/MediaCanvasItems.tsx',
  'admin/shared/media/components/MediaFolderPanel/MediaFolderPanel.tsx',
  'admin/pages/site/panels/PropertiesPanel/ImageSourceSection.tsx',
  // Dormant CMS import wizard's file-drop analyze step.
  'admin/modals/SiteImport/steps/AnalyzeStep.tsx',
  // Dormant CMS import wizard's own drop step (separate from the live Studio
  // importer, which has no drop target at all yet — G15).
  'admin/modals/SiteImport/steps/DropStep.tsx',
])

// ─── File collection ─────────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectSourceFiles(full))
    } else if (extname(entry) === '.ts' || extname(entry) === '.tsx') {
      results.push(full)
    }
  }
  return results
}

function relPath(file: string): string {
  return relative(SRC_ROOT, file).split('\\').join('/')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Architecture — DnD mechanism containment (D2)', () => {
  it('no file outside the allowlist imports @dnd-kit/core', () => {
    const files = collectSourceFiles(SCAN_ROOT)
    const violations: string[] = []

    for (const file of files) {
      const rel = relPath(file)
      if (DND_KIT_ALLOWLIST.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (/from ['"]@dnd-kit\/core['"]/.test(source)) {
        violations.push(rel)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[single-drag-mechanism] New @dnd-kit/core usage outside the allowlist:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nEither add this file to DND_KIT_ALLOWLIST in this test with a reason, ` +
          `or (preferred) route the new surface through the raw-pointer-event drag ` +
          `pattern instead — see STUDIO-FIGMA-PARITY-PLAN.md's D2 target architecture.`,
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('every @dnd-kit/core allowlist entry still exists and still imports it (no stale entries)', () => {
    const stale: string[] = []
    for (const rel of DND_KIT_ALLOWLIST) {
      const full = join(SRC_ROOT, rel)
      if (!existsSync(full)) {
        stale.push(`${rel} (file no longer exists)`)
        continue
      }
      const source = readFileSync(full, 'utf8')
      if (!/from ['"]@dnd-kit\/core['"]/.test(source)) {
        stale.push(`${rel} (no longer imports @dnd-kit/core — remove from the allowlist)`)
      }
    }
    expect(stale).toEqual([])
  })

  it('no file outside the allowlist uses native HTML5 dataTransfer drag-and-drop', () => {
    const files = collectSourceFiles(SCAN_ROOT)
    const violations: string[] = []

    for (const file of files) {
      const rel = relPath(file)
      if (NATIVE_HTML5_DND_ALLOWLIST.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (/\bdataTransfer\b|\bDragEvent</.test(source)) {
        violations.push(rel)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[single-drag-mechanism] New native HTML5 dataTransfer usage outside the allowlist:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nEither add this file to NATIVE_HTML5_DND_ALLOWLIST in this test with a reason, ` +
          `or (preferred) route the new surface through the raw-pointer-event drag ` +
          `pattern instead — see STUDIO-FIGMA-PARITY-PLAN.md's D2 target architecture.`,
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('every native HTML5 DnD allowlist entry still exists and still uses dataTransfer (no stale entries)', () => {
    const stale: string[] = []
    for (const rel of NATIVE_HTML5_DND_ALLOWLIST) {
      const full = join(SRC_ROOT, rel)
      if (!existsSync(full)) {
        stale.push(`${rel} (file no longer exists)`)
        continue
      }
      const source = readFileSync(full, 'utf8')
      if (!/\bdataTransfer\b|\bDragEvent</.test(source)) {
        stale.push(`${rel} (no longer uses dataTransfer — remove from the allowlist)`)
      }
    }
    expect(stale).toEqual([])
  })
})
