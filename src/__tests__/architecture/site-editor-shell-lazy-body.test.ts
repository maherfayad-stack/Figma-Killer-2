import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ADMIN_DIR = join(process.cwd(), 'src/admin')

function readAdminFile(path: string): string {
  return readFileSync(join(ADMIN_DIR, path), 'utf8')
}

describe('Site editor shell lazy body', () => {
  it('renders the real site shell from SitePage instead of a bespoke startup skeleton', () => {
    const source = readAdminFile('pages/site/SitePage.tsx')

    expect(source).toContain('@admin/layouts/AdminCanvasLayout')
    expect(source).toContain('<AdminCanvasLayout />')
    expect(source).not.toContain('SitePageStartupShell')
    expect(source).not.toContain('SitePage.module.css')
    expect(source).not.toContain("import('./SiteEditorBootstrap')")
  })

  it('keeps visual editor body imports behind the existing layout shell', () => {
    const layout = readAdminFile('layouts/AdminCanvasLayout/AdminCanvasLayout.tsx')
    const body = readAdminFile('layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx')
    // The canvas module packs are no longer listed by the body directly: the
    // headless capture page renders the same nodes from a SEPARATE Vite entry
    // and inherits none of these imports, so both surfaces go through one
    // shared entry (`canvasModuleSet.ts`) instead of keeping two lists — see
    // that file's doc, and `captureCanvasModuleSet.test.tsx` for the gate on
    // its CONTENTS. What this rule still owns is the ALTITUDE: the packs load
    // from the lazy body, never from the route shell.
    const moduleSet = readAdminFile('pages/site/studio/canvasModuleSet.ts')

    expect(layout).toContain("import('./AdminCanvasEditorBody')")
    expect(layout).toContain('prewarmedLazy<AdminCanvasEditorBodyProps>')
    expect(layout).toContain('<LazyChunkBoundary')
    expect(layout).toContain('onReset={AdminCanvasEditorBody.reset}')
    expect(layout).toContain('scheduleAfterFirstPaint')
    expect(layout).not.toContain("@dnd-kit/core")
    expect(layout).not.toContain("@admin/pages/site/canvas")
    expect(layout).not.toContain("@admin/pages/site/panels/PropertiesPanel")
    expect(layout).not.toContain("@admin/pages/site/sidebars/LeftSidebar")
    expect(layout).not.toContain("@admin/pages/site/sidebars/RightSidebar")
    expect(layout).not.toContain("@modules/base")
    expect(layout).not.toContain("@core/loops/sources")
    expect(layout).not.toContain('studio/canvasModuleSet')

    expect(body).toContain("@dnd-kit/core")
    expect(body).toContain("@admin/pages/site/canvas")
    expect(body).toContain("@admin/pages/site/panels/PropertiesPanel")
    expect(body).toContain("@admin/pages/site/sidebars/LeftSidebar")
    expect(body).toContain("@admin/pages/site/sidebars/RightSidebar")
    expect(body).toContain('studio/canvasModuleSet')
    expect(moduleSet).toContain("@modules/base")
    expect(moduleSet).toContain("@core/loops/sources")
  })

  it('keeps rarely opened Import HTML UI behind an open-state lazy boundary', () => {
    const body = readAdminFile('layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx')

    expect(body).toContain("import('@admin/modals/ImportHtml')")
    expect(body).toContain('<ImportHtmlModalLoading />')
    expect(body).not.toContain("import { ImportHtmlModal }")
  })

  it('keeps a lightweight shell skeleton while the visual editor body lazy-loads', () => {
    const layout = readAdminFile('layouts/AdminCanvasLayout/AdminCanvasLayout.tsx')
    const transformLayer = readAdminFile('pages/site/canvas/CanvasTransformLayer.tsx')
    const skeleton = readAdminFile('shared/CanvasFrameSkeleton/CanvasFrameSkeleton.tsx')

    // The body chunk contains the real canvas, sidebars, DnD context, modules,
    // and panel graph. While that lazy import is still in flight the eager
    // shell must still paint canvas-shaped skeleton frames; otherwise cold Site
    // loads show only the toolbar over an empty black workspace.
    expect(layout).toContain('<AdminCanvasEditorBodyLoading />')
    expect(layout).toContain('fallback={<AdminCanvasEditorBodyLoading />}')
    expect(layout).toContain('@admin/shared/CanvasFrameSkeleton')
    expect(layout).toContain('<CanvasFrameSkeletonFrame')
    expect(layout).not.toContain('<span>Loading editor</span>')
    expect(layout).not.toContain('@core/page-tree')
    expect(layout).not.toContain('@admin/pages/site/canvas')

    expect(transformLayer).toContain('@admin/shared/CanvasFrameSkeleton')
    expect(transformLayer).toContain('<CanvasFrameSkeletonFrame')
    expect(transformLayer).not.toContain('Loading site')

    expect(skeleton).toContain('canvas-loading-frame')
    expect(skeleton).toContain('canvas-frame-skeleton')
  })
})
