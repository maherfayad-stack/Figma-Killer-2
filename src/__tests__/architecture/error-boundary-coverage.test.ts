/**
 * Error-boundary coverage gate.
 *
 * The CMS uses a single `<ErrorBoundary>` primitive
 * (`src/ui/components/ErrorBoundary/`) at every architectural seam where a
 * render-time failure could blank a tree the user expects to be independent:
 *
 *   - admin-shell           — last-resort, full-page (src/admin/main.tsx)
 *   - admin-route           — per-section route wrapper (src/admin/router.tsx)
 *   - canvas                — editor canvas transform layer (CanvasRoot.tsx)
 *   - node-renderer         — per-module isolation in the canvas (NodeRenderer.tsx)
 *   - plugin-page           — third-party plugin admin page renderer
 *   - plugin-editor-panel   — third-party plugin editor sidebar panel
 *   - plugin-canvas-overlay — third-party plugin canvas overlay slot
 *
 * Plus the per-PANEL and per-SECTION seams `panel-40` added, all of them
 * mounted through one component (`src/admin/pages/site/ui/PanelBoundary/`)
 * whose `location` is built at runtime (`panel:<id>` / `inspector:<id>`), so
 * they are gated by their MOUNT SITES rather than by a literal location
 * string — see the `PanelBoundary` block at the bottom of this file. Before
 * them, the nearest boundary above every editor panel was
 * `LazyChunkBoundary location="site-editor-body"`, which wraps the canvas and
 * every panel together: one section throwing replaced the whole editor body
 * (`verify-3` case 5).
 *
 * Plus the React 19 root-level error callbacks on the single `createRoot`
 * call in `src/admin/main.tsx`:
 *
 *   - onCaughtError, onUncaughtError, onRecoverableError
 *
 * If the boundary placements above drift (someone deletes a wrapper, renames
 * a location string, or removes a root callback), this gate fails CI loudly
 * with a single fix instruction.
 *
 * It also gates the Track Z rule that boundaries **render in place instead of
 * toasting**: `silentToast` defaults to true, `admin-shell` is the one seam
 * that opts back in, and no seam carries a redundant explicit `silentToast`.
 *
 * @see CLAUDE.md "Error handling" — boundary + tagged logging conventions
 * @see STUDIO-FIGMA-FEEL-PLAN.md — Z2
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')

interface BoundaryPlacement {
  /** Path relative to src/ */
  file: string
  /** Required `location="..."` value */
  location: string
}

const REQUIRED_BOUNDARIES: BoundaryPlacement[] = [
  { file: 'admin/main.tsx', location: 'admin-shell' },
  { file: 'admin/router.tsx', location: 'admin-route' },
  { file: 'admin/pages/site/canvas/CanvasRoot.tsx', location: 'canvas' },
  { file: 'admin/pages/site/canvas/NodeRenderer.tsx', location: 'node-renderer' },
  {
    file: 'admin/pages/plugins/components/PluginPageRenderer/PluginPageRenderer.tsx',
    location: 'plugin-page',
  },
  {
    file: 'admin/pages/site/panels/PluginEditorPanel/PluginEditorPanel.tsx',
    location: 'plugin-editor-panel',
  },
  {
    file: 'admin/pages/site/canvas/PluginCanvasOverlayLayer/PluginCanvasOverlayLayer.tsx',
    location: 'plugin-canvas-overlay',
  },
]

const MAIN_FILE = join(SRC_ROOT, 'admin/main.tsx')

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

describe('Error boundary coverage gate', () => {
  it('every architectural seam imports and uses the shared ErrorBoundary primitive', () => {
    const failures: string[] = []
    for (const { file, location } of REQUIRED_BOUNDARIES) {
      let source: string
      try {
        source = read(file)
      } catch {
        failures.push(`MISSING FILE: ${file}`)
        continue
      }
      if (!/from\s+['"]@ui\/components\/ErrorBoundary['"]/.test(source)) {
        failures.push(`${file} — does not import ErrorBoundary from '@ui/components/ErrorBoundary'`)
      }
      if (!/<ErrorBoundary[\s>]/.test(source)) {
        failures.push(`${file} — does not render <ErrorBoundary />`)
      }
      // Match `location="<location>"` so the boundary tag stays unique and
      // the architecture stays explicit. Allow surrounding whitespace.
      const locationRe = new RegExp(`location\\s*=\\s*["']${location}["']`)
      if (!locationRe.test(source)) {
        failures.push(`${file} — missing required boundary location="${location}"`)
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `[Error boundary coverage] missing or misconfigured boundaries:\n` +
          failures.map((f) => `  - ${f}`).join('\n') +
          `\n\nFix: ensure each seam uses <ErrorBoundary location="..."> from ` +
          `@ui/components/ErrorBoundary. See src/ui/components/ErrorBoundary/.`,
      )
    }
    expect(failures).toEqual([])
  })

  it('each boundary location string is used at exactly one seam (no duplicates)', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const { file, location } of REQUIRED_BOUNDARIES) {
      const prior = seen.get(location)
      if (prior) {
        dupes.push(`location="${location}" used in both ${prior} and ${file}`)
      } else {
        seen.set(location, file)
      }
    }
    expect(dupes).toEqual([])
  })

  it('admin/main.tsx wires all three React 19 root error callbacks on createRoot', () => {
    const source = read('admin/main.tsx')
    const required = ['onCaughtError', 'onUncaughtError', 'onRecoverableError']
    const missing = required.filter((name) => !new RegExp(`${name}\\s*:`).test(source))
    if (missing.length > 0) {
      throw new Error(
        `[Error boundary coverage] admin/main.tsx is missing root createRoot ` +
          `callbacks: ${missing.join(', ')}. These are the single telemetry funnel ` +
          `for boundary-caught and uncaught render errors — keep all three wired.`,
      )
    }
    expect(missing).toEqual([])
  })

  it('admin/main.tsx mounts the single ToastProvider so the root callbacks can publish errors', () => {
    const source = read('admin/main.tsx')
    expect(source).toMatch(/from\s+['"]@ui\/components\/Toast['"]/)
    expect(source).toMatch(/<ToastProvider\s*\/>/)
  })

  // ── Z2: boundaries render in place, they do not toast ─────────────────────
  //
  // A boundary is mounted per seam AND per canvas node, so a toast-by-default
  // boundary turns one bad module into one identical red card per node. The
  // crash already has an honest place to render: the hole it left. Only
  // `admin-shell` opts back in, because its catch leaves nothing else on
  // screen to read.

  it('the boundary is silent by default — only an explicit silentToast={false} toasts', () => {
    const source = read('ui/components/ErrorBoundary/ErrorBoundary.tsx')
    // The push must be gated on the EXPLICIT opt-out. `if (!this.props.silentToast)`
    // is the opt-in default this assertion exists to prevent coming back.
    expect(source).toMatch(/if\s*\(this\.props\.silentToast\s*===\s*false\)/)
    expect(source).not.toMatch(/if\s*\(!this\.props\.silentToast\)/)
  })

  it('admin-shell is the only seam that opts into the toast', () => {
    const optIns: string[] = []
    for (const { file } of REQUIRED_BOUNDARIES) {
      const source = read(file)
      if (/silentToast\s*=\s*\{\s*false\s*\}/.test(source)) optIns.push(file)
    }
    expect(optIns).toEqual(['admin/main.tsx'])
  })

  it('no seam carries a redundant silentToast — it is the default', () => {
    const redundant: string[] = []
    for (const { file } of REQUIRED_BOUNDARIES) {
      const source = read(file)
      if (/silentToast(\s*=\s*\{\s*true\s*\})?(\s*\/?>|\s*\n\s*>)/.test(source)) {
        redundant.push(file)
      }
    }
    if (redundant.length > 0) {
      throw new Error(
        `[Error boundary coverage] silentToast is the default — drop it from:\n` +
          redundant.map((f) => `  - ${f}`).join('\n'),
      )
    }
    expect(redundant).toEqual([])
  })

  it('the default fallback renders in place with a reset action', () => {
    const source = read('ui/components/ErrorBoundary/ErrorBoundary.tsx')
    expect(source).toMatch(/Reload this panel/)
    expect(source).toMatch(/onClick=\{reset\}/)
    const css = read('ui/components/ErrorBoundary/ErrorBoundary.module.css')
    expect(css).toMatch(/background:\s*var\(--bg-surface-2\)/)
  })

  it('the ErrorBoundary primitive lives in src/ui/components/ErrorBoundary/', () => {
    // If someone tries to fork the boundary (e.g. drop a copy in src/admin/pages/site/)
    // the architecture reviewer should catch it — but enforce the canonical
    // location explicitly.
    const indexSource = read('ui/components/ErrorBoundary/index.ts')
    expect(indexSource).toMatch(/export\s*\{\s*ErrorBoundary\s*\}/)
    const tsxSource = read('ui/components/ErrorBoundary/ErrorBoundary.tsx')
    expect(tsxSource).toMatch(/export\s+class\s+ErrorBoundary\s+extends\s+Component/)
  })

  it('main.tsx createRoot callbacks log via the shared logErrorChain helper', () => {
    // Catches the regression where someone replaces logErrorChain with a raw
    // `console.error(error)` and we lose the [<module>] prefix + cause chain.
    // MAIN_FILE is already an absolute, OS-native path — read it directly
    // rather than re-deriving a "relative" path via string replace(). On
    // win32, `MAIN_FILE.replace(SRC_ROOT + '/', '')` never matches (MAIN_FILE
    // is backslash-separated, the search string forward-slash-separated), so
    // `read()` re-joined the untouched absolute path onto SRC_ROOT and threw
    // ENOENT — the same mixed-separator bug class as STATE.md's parity-01.
    const source = readFileSync(MAIN_FILE, 'utf8')
    expect(source).toMatch(/logErrorChain/)
    expect(source).toMatch(/flattenErrorChain/)
  })
})

// ── ERR-13 (P3-A): every piece of editor chrome is its own SILENT seam ─────
//
// Chrome outside a panel used to fall back to `LazyChunkBoundary
// location="site-editor-body"` (the whole editor body, captioned "Editor chunk
// failed to load") or, for the toolbar and `RefusalDialog`, to `admin-route`
// (the whole editor). `ChromeBoundary` renders nothing, logs once, and brings
// the chrome back on the next store change.

const CHROME_BOUNDARY_PATH = 'admin/pages/site/ui/ChromeBoundary/ChromeBoundary.tsx'

/** Every chrome seam, by mount site and `id`. */
const CHROME_BOUNDARY_MOUNTS: Array<{ file: string; ids: string[] }> = [
  { file: 'admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', ids: ['toolbar'] },
  { file: 'admin/pages/site/SitePage.tsx', ids: ['refusal-dialog', 'detach-confirm-dialog'] },
  {
    file: 'admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx',
    ids: ['left-sidebar', 'right-sidebar', 'code-editor', 'layout-name-dialog', 'import-html'],
  },
  {
    file: 'admin/pages/site/canvas/CanvasRoot.tsx',
    ids: ['canvas-context-selector', 'canvas-rulers', 'studio-canvas-chrome', 'canvas-context-menu'],
  },
]

describe('ERR-13 — chrome seams', () => {
  it('every chrome seam mounts a ChromeBoundary with its own id', () => {
    const failures: string[] = []
    for (const { file, ids } of CHROME_BOUNDARY_MOUNTS) {
      const source = read(file)
      if (!/from\s+['"][^'"]*ui\/ChromeBoundary['"]/.test(source)) failures.push(`${file} — does not import ChromeBoundary`)
      for (const id of ids) {
        if (!new RegExp(`<ChromeBoundary\\s+id="${id}"`).test(source)) failures.push(`${file} — no <ChromeBoundary id="${id}">`)
      }
    }
    expect(failures).toEqual([])
  })

  it('ChromeBoundary builds on the shared primitive, never toasts, and recovers by itself', () => {
    const source = read(CHROME_BOUNDARY_PATH)
    expect(source).toMatch(/from\s+['"]@ui\/components\/ErrorBoundary['"]/)
    expect(source).not.toMatch(/silentToast/)
    expect(source).toMatch(/useEditorStore\.subscribe/)
  })

  it('the canvas boundary retries once before its fallback', () => {
    expect(read('admin/pages/site/canvas/CanvasRoot.tsx')).toMatch(/location="canvas"[\s\S]{0,200}autoRetry=\{1\}/)
  })

  it('"Editor chunk failed to load" is only said for a real chunk failure', () => {
    const source = read('admin/lib/LazyChunkBoundary.tsx')
    expect(source).toMatch(/isChunkLoadError\(chain\)\s*\?/)
  })
})

// ── panel-40: every editor panel and every inspector section is its own seam ─
//
// `PanelBoundary` is the single mount point. Its `location` is composed at
// runtime, so these assertions gate the MOUNT SITES and the component's own
// contract instead of a literal `location="..."` string.

const PANEL_BOUNDARY_PATH = 'admin/pages/site/ui/PanelBoundary/PanelBoundary.tsx'

/** Every file that must mount at least one `<PanelBoundary>`, and why. */
const PANEL_BOUNDARY_MOUNTS: Array<{ file: string; why: string }> = [
  {
    file: 'admin/pages/site/inspector/InspectorShell.tsx',
    why: 'one boundary per inspector tab — Design, Prototype, Inspect',
  },
  {
    file: 'admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx',
    why: 'one boundary per mounted INSPECTOR_SECTIONS entry',
  },
  {
    file: 'admin/pages/site/sidebars/LeftSidebar/LeftSidebar.tsx',
    why: 'one boundary per left-sidebar panel mount (layers, assets, git, …)',
  },
  {
    file: 'admin/pages/site/sidebars/RightSidebar/RightSidebar.tsx',
    why: 'the docked Properties panel and the Comments panel',
  },
  {
    file: 'admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx',
    why: 'the undocked (floating) Properties panel',
  },
]

describe('panel-40 — per-panel and per-section boundaries', () => {
  it('every panel seam mounts a PanelBoundary', () => {
    const failures: string[] = []
    for (const { file, why } of PANEL_BOUNDARY_MOUNTS) {
      const source = read(file)
      if (!/<PanelBoundary[\s>]/.test(source)) {
        failures.push(`${file} — no <PanelBoundary> (${why})`)
      }
      if (!/from\s+['"][^'"]*ui\/PanelBoundary['"]/.test(source)) {
        failures.push(`${file} — does not import PanelBoundary from its barrel`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        '[Error boundary coverage] a panel seam lost its boundary:\n' +
          failures.map((f) => `  - ${f}`).join('\n') +
          '\n\nA panel without one falls back to LazyChunkBoundary ' +
          '("site-editor-body"), which takes the canvas down with it.',
      )
    }
    expect(failures).toEqual([])
  })

  it('InspectorShell wraps all three tabs, not just Design', () => {
    const source = read('admin/pages/site/inspector/InspectorShell.tsx')
    for (const id of ['design', 'prototype', 'inspect']) {
      expect(source).toMatch(new RegExp(`<PanelBoundary\\s+id="${id}"`))
    }
  })

  it('PanelBoundary builds on the shared primitive and never toasts', () => {
    const source = read(PANEL_BOUNDARY_PATH)
    expect(source).toMatch(/from\s+['"]@ui\/components\/ErrorBoundary['"]/)
    expect(source).toMatch(/<ErrorBoundary/)
    // Silence is the default (Z2). An explicit opt-out here would turn one
    // crashed section into a red card in the corner as well as the fallback.
    expect(source).not.toMatch(/silentToast/)
  })

  it('PanelBoundary renders in place, names the seam, and offers a reset', () => {
    const source = read(PANEL_BOUNDARY_PATH)
    expect(source).toMatch(/role="alert"/)
    expect(source).toMatch(/data-error-location=\{location\}/)
    expect(source).toMatch(/Reload this panel/)
    expect(source).toMatch(/onClick=\{onReset\}/)
  })

  it('the crash probe is mounted only behind import.meta.env.DEV', () => {
    const source = read(PANEL_BOUNDARY_PATH)
    expect(source).toMatch(/import\.meta\.env\.DEV\s*&&\s*<PanelCrashProbe/)
  })

  it('every INSPECTOR_SECTIONS entry carries the label a fallback needs', () => {
    const source = read('admin/pages/site/inspector/sections/index.ts')
    const ids = [...source.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1])
    const labelled = [...source.matchAll(/\blabel:\s*'([^']+)'/g)].length
    expect(ids.length).toBeGreaterThan(0)
    // A section's own component is exactly what is NOT running when the
    // boundary has to name it, so the label lives in the manifest.
    expect(labelled).toBe(ids.length)
  })
})
