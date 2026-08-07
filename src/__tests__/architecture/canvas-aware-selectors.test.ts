/**
 * Architecture Gate — Canvas-Aware Selectors (Task #438 regression guard)
 *
 * When the editor enters VC edit mode `activeDocument` becomes
 * `{ kind: 'visualComponent', vcId }`.  Components that read the active
 * canvas document MUST use `selectActiveCanvasPage` (the VC-aware selector)
 * rather than `selectActivePage` (page-only) or the raw
 * `s.site?.pages.find(...)` pattern, which silently returns null for any
 * node that lives inside a VC tree.
 *
 * GATE 1 — No `selectActivePage` import in VC-aware panel files.
 *   Panels that render content for the active canvas (DOM panel, Properties
 *   panel, Canvas, Selectors panel) must never subscribe to the page-only
 *   selector.  Use `selectActiveCanvasPage` or `selectSelectedNode` instead.
 *
 *   ALLOWLIST: files that are legitimately page-mode-only by design.
 *   Each entry requires a §-style justification (below).
 *
 * GATE 2 — No `s.site?.pages.find(` in VC-aware panel directories.
 *   The raw `pages.find` pattern searches the page tree only and always
 *   returns null for nodes owned by a VC.  Any node lookup that must work in
 *   both page mode and VC mode must go through `selectActiveCanvasPage`.
 *
 * @see Task #438 — VC canvas mode selector correctness
 * @see store.ts — `selectActiveCanvasPage`, `selectSelectedNode`
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const SRC_ROOT = join(import.meta.dir, '../../')
// This gate's own SELECT_ACTIVE_PAGE_ALLOWLIST entries below (all
// 'admin/pages/site/...') are the ground truth for where the "editor" this
// gate means actually lives today — 'src/editor' never existed in this
// repo's tracked history (checked via `git log --all -- src/editor`); the
// gate silently scanned nothing since it was written. `src/admin/pages/site`
// is the visual editor surface the doc comment above describes.
const EDITOR_ROOT = join(SRC_ROOT, 'admin/pages/site')

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function collectTs(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectTs(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

function relPath(full: string): string {
  return toPosixPath(relative(SRC_ROOT, full))
}

// ---------------------------------------------------------------------------
// Comment stripper — preserves line numbers by replacing non-newline chars
// inside comments with spaces (same approach as db-postgres-isms.test.ts /
// boundary-validation.test.ts). Needed once this gate actually scans real
// files: without it, `selectActivePage` mentioned in a `/** ... */` doc
// comment (e.g. NodeRenderer.tsx's file-header perf notes) reads as a false
// "imports/uses" violation — the old `/^\s*\/\//` line check only strips
// `//` line comments, not block-comment bodies or `*`-continuation lines.
// ---------------------------------------------------------------------------

const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// GATE 1 — `selectActivePage` must not be imported in src/admin/pages/site/
//
// §-style ALLOWLIST — files that are page-mode-only by design and are
// legitimately allowed to import `selectActivePage`.
//
// §A.1 — site panel page list:
//   The site explorer lists all pages in the site document (not a canvas
//   view).  It never renders nodes from a VC; it only needs the page list
//   and the per-page active indicator.  Using the page-only selector is
//   intentional and correct here.
//
// Add new entries below with a §A.N justification comment.
// ---------------------------------------------------------------------------

const SELECT_ACTIVE_PAGE_ALLOWLIST = new Set<string>([
  // §A.2 — module insertion hook: uses selectActiveCanvasPage so insertions
  //   resolve against either page mode or Visual Component canvas mode.
  'admin/pages/site/hooks/useInsertModule.ts',

  // §A.3 — module inserter toolbar trigger: uses selectActiveCanvasPage for
  //   Component-ref insertion target resolution.
  'admin/pages/site/toolbar/ModulePickerDropdown.tsx',

  // §A.4 — page preview overlay: publishes the active page via publishPage() to
  //   render it in a sandboxed iframe. VCs are not publishable pages and have no
  //   slug; the preview concept is inherently page-mode-only.
  'admin/pages/site/preview/PreviewOverlay.tsx',

  // §A.5 — publish button: publishes the active page. Purely page-mode — publishing
  //   a standalone VC is not a supported workflow (VCs are embedded in pages).
  'admin/pages/site/toolbar/PublishButton.tsx',

  // §A.6 — store.ts is the module that DEFINES both selectActivePage and
  //   selectActiveCanvasPage; it is not a consumer. selectActiveCanvasPage's
  //   own implementation legitimately calls selectActivePage(s) as its
  //   page-mode branch (`if (!activeDocument || activeDocument.kind ===
  //   'page') return selectActivePage(s)`) — that delegation IS the
  //   VC-aware selector, not a bypass of it. Excluding the definition site
  //   is the same pattern as excluding `mutateActiveTree` from the
  //   no-vc-mode-branches-in-mutations gate.
  'admin/pages/site/store/store.ts',

  // §A.7 — useActiveLivePath: resolves the toolbar's "Open live page" deep
  //   link. A Visual Component is never independently routable/publishable
  //   (no slug, no permalink — see PublishButton's §A.5 and PreviewOverlay's
  //   §A.4, the same "VCs are embedded in pages, not standalone routes"
  //   reasoning). `activePageId` is deliberately NOT cleared when entering VC
  //   edit mode (see uiSlice.ts's `setActiveDocument`/`previousActivePageId`),
  //   so `selectActivePage` here keeps resolving the underlying page the
  //   author was on before opening the VC — exactly the fallback this hook's
  //   own module doc already describes for templates ("a template's own slug
  //   has no public route ... open the page it's being previewed against").
  //   Switching to `selectActiveCanvasPage` would be actively wrong: it
  //   would resolve a virtual Page for the VC (slug `components/<Name>`) and
  //   compute a live path that 404s, instead of falling back to a real page.
  'admin/pages/site/hooks/useActiveLivePath.ts',
])

describe('Canvas-aware selector gate — selectActivePage not imported in editor panels', () => {
  it('no src/admin/pages/site/ file imports selectActivePage unless allowlisted', () => {
    if (!existsSync(EDITOR_ROOT)) {
      expect(true).toBe(true)
      return
    }

    const IMPORT_RE = /\bselectActivePage\b/

    const violations: string[] = []

    for (const file of collectTs(EDITOR_ROOT)) {
      const rel = relPath(file)
      if (SELECT_ACTIVE_PAGE_ALLOWLIST.has(rel)) continue

      let src: string
      try { src = stripComments(readFileSync(file, 'utf8')) } catch { continue }

      if (!IMPORT_RE.test(src)) continue

      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (IMPORT_RE.test(line)) {
          violations.push(`${rel}:${i + 1} — imports/uses selectActivePage (page-only selector)`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[canvas-aware-selectors] selectActivePage used in VC-aware editor panel.\n' +
        'In VC edit mode (activeDocument.kind === "visualComponent") selectActivePage returns\n' +
        'null — the VC tree is never in site.pages.  Use selectActiveCanvasPage instead.\n' +
        'If the file is page-mode-only by design, add it to SELECT_ACTIVE_PAGE_ALLOWLIST\n' +
        'in this test file with a §A.N justification comment.\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GATE 2 — `s.site?.pages.find(` must not appear in VC-aware panel directories
//
// These directories render or inspect the active canvas — they must work in
// both page mode and VC mode.  The raw pages.find pattern only searches the
// page tree and silently returns null for any node inside a VC.
// ---------------------------------------------------------------------------

// 'components/<Panel>' never existed under EDITOR_ROOT in this repo — the
// real layout is 'panels/<Panel>' for the three panels, and the canvas
// surface is 'canvas/' directly (not nested under 'panels/'). Re-derived
// from the doc comment ("DOM panel, Properties panel, Canvas, Selectors
// panel") cross-referenced against the actual directory tree.
const VC_AWARE_PANEL_DIRS = [
  join(EDITOR_ROOT, 'panels/PropertiesPanel'),
  join(EDITOR_ROOT, 'panels/DomPanel'),
  join(EDITOR_ROOT, 'canvas'),
  join(EDITOR_ROOT, 'panels/SelectorsPanel'),
]

describe('Canvas-aware selector gate — no raw pages.find in VC-aware panel directories', () => {
  it('VC-aware panel files must not use s.site?.pages.find(', () => {
    const PAGES_FIND_RE = /s\.site\?\.pages\.find\s*\(/

    const violations: string[] = []

    for (const dir of VC_AWARE_PANEL_DIRS) {
      for (const file of collectTs(dir)) {
        let src: string
        try { src = stripComments(readFileSync(file, 'utf8')) } catch { continue }

        if (!PAGES_FIND_RE.test(src)) continue

        const lines = src.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (PAGES_FIND_RE.test(line)) {
            violations.push(
              `${relPath(file)}:${i + 1} — uses s.site?.pages.find( (page-tree only; ` +
              'returns null for VC nodes — use selectActiveCanvasPage instead)',
            )
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[canvas-aware-selectors] Raw pages.find pattern in a VC-aware panel directory.\n' +
        'site.pages only contains page-tree nodes.  VC nodes live in vc.tree.nodes and\n' +
        'are not present in site.pages at all.  This pattern silently returns null\n' +
        'for any node selected inside a VC, breaking the Properties/DOM/Selectors panels.\n' +
        'Required: use selectActiveCanvasPage(s)?.nodes[nodeId] for node lookups.\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
