/**
 * CanvasLayerSurface — the ONE document a board's loose layers render in (P5-G,
 * FC-4; design §1.2, §4.1).
 *
 * ## One document per board, not one per layer
 *
 * A moodboard is dozens of images and components. An iframe each would parse
 * the vendor/authored/class CSS dozens of times and mount dozens of documents
 * on a zoom-out; one surface parses it once. Every layer is a
 * `CanvasLayerHost` inside it, absolutely positioned at its placement.
 *
 * ## A window, not the whole board
 *
 * The surface covers the viewport plus a margin (`canvasLayerWindow`), re-fit
 * when the view settles — never per pan tick. A host's position is its
 * placement minus the window's origin, and the origin is ONE pair of custom
 * properties on the surface's `<body>`, so a re-fit is two style writes and no
 * host re-renders (design §4.2).
 *
 * ## Always static
 *
 * An `IframeFrameSurface` in its ordinary design mode, with `sizing: 'fixed'`
 * (the caller sizes it; nothing fits it to content) and NO runtime scripts:
 * the free canvas never runs code, at any trust tier (design §4.1, §6.2).
 * Components with hooks render their static parse, as a Tier-0 frame would.
 *
 * ## The surface's own chrome
 *
 * Three things only the surface needs, written into its document from here:
 *  - `html`/`body` are transparent and marginless (inline, so a project's
 *    `body { background: #fff }` cannot paint a slab over the board, and its
 *    `body { margin: 8px }` cannot shift every host), and `html` clips — a
 *    host straddling the window's edge never grows a scrollbar;
 *  - the window origin custom properties;
 *  - a small UNLAYERED stylesheet laying out `[data-studio-canvas-host]`. It
 *    needs no `!important`: only a Studio-rendered host carries that
 *    attribute, and unlayered already beats every `@layer`ed project rule.
 */
import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { canvasLayerPageId, type CanvasLayerPlacement } from '@core/studio-board'
import type { Page } from '@core/page-tree'
import { CanvasBreakpointContext } from '../CanvasContexts'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from '../IframeFrameSurface'
import type { CanvasLayerWindow } from './canvasLayerGeometry'
import { CanvasLayerHost } from './CanvasLayerHost'
import styles from './BoardCanvasLayer.module.css'

/** The synthetic breakpoint every studio frame shares — so class CSS keyed on it matches here too. */
const STUDIO_BREAKPOINT_ID = 'studio'

const SURFACE_CHROME_CSS = [
  '[data-studio-canvas-host] {',
  '  position: absolute;',
  '  left: calc(var(--studio-layer-x) - var(--studio-canvas-origin-x));',
  '  top: calc(var(--studio-layer-y) - var(--studio-canvas-origin-y));',
  '  width: max-content;',
  '  display: flow-root;',
  '}',
  '[data-studio-canvas-host][data-studio-layer-fill] { width: var(--studio-layer-w); }',
].join('\n')

/**
 * Write the surface's own chrome into its document and return the cleanup.
 * At module scope, like `iframeBodyReset.ts`'s writers, so the React Compiler
 * does not read cross-document DOM writes as a mutation of React state.
 */
function applySurfaceChrome(doc: Document): () => void {
  const style = doc.createElement('style')
  style.setAttribute('data-studio-canvas-surface', '')
  style.textContent = SURFACE_CHROME_CSS
  doc.head.appendChild(style)
  for (const element of [doc.documentElement, doc.body]) {
    element.style.background = 'transparent'
    element.style.margin = '0'
  }
  // A host straddling the window's edge must be clipped by it, never grow a
  // scrollbar inside a document nobody can scroll.
  doc.documentElement.style.overflow = 'hidden'
  return () => style.remove()
}

/** The window's board origin, which every host's position is measured from. */
function writeSurfaceOrigin(doc: Document, x: number, y: number): void {
  doc.body.style.setProperty('--studio-canvas-origin-x', `${x}px`)
  doc.body.style.setProperty('--studio-canvas-origin-y', `${y}px`)
}

interface CanvasLayerSurfaceProps {
  boardId: string
  area: CanvasLayerWindow
  layers: readonly CanvasLayerPlacement[]
  pages: Readonly<Record<string, Page>>
  /** Published for the pointer hook: the wrapper it lifts, and the document its hosts live in. */
  surfaceElementRef: RefObject<HTMLDivElement | null>
  surfaceDocumentRef: RefObject<Document | null>
}

export function CanvasLayerSurface({ boardId, area, layers, pages, surfaceElementRef, surfaceDocumentRef }: CanvasLayerSurfaceProps) {
  const [doc, setDoc] = useState<Document | null>(null)

  const handleSurface = (handle: IframeFrameSurfaceHandle | null) => {
    const next = handle?.contentDocument ?? null
    surfaceDocumentRef.current = next
    setDoc(next)
  }

  // The surface's own chrome — see the module doc. Once per document.
  useEffect(() => (doc ? applySurfaceChrome(doc) : undefined), [doc])

  // The window origin — two style writes per re-fit, no host re-renders.
  useEffect(() => {
    if (doc) writeSurfaceOrigin(doc, area.x, area.y)
  }, [doc, area.x, area.y])

  const surfaceStyle = {
    '--surface-x': `${area.x}px`,
    '--surface-y': `${area.y}px`,
    '--surface-w': `${area.width}px`,
    '--surface-h': `${area.height}px`,
  } as CSSProperties

  return (
    <div ref={surfaceElementRef} className={styles.surface} style={surfaceStyle} data-studio-canvas-surface={boardId}>
      <IframeFrameSurface
        ref={handleSurface}
        breakpointId={STUDIO_BREAKPOINT_ID}
        width={area.width}
        sizing="fixed"
        className={styles.surfaceFrame}
        dataAttrs={{ 'data-studio-canvas-surface-frame': boardId }}
      >
        <CanvasBreakpointContext.Provider value={STUDIO_BREAKPOINT_ID}>
          {layers.map((layer) => {
            const pageId = canvasLayerPageId(layer.id)
            const page = pages[pageId]
            if (!page) return null
            return <CanvasLayerHost key={layer.id} placement={layer} page={page} pageId={pageId} frameId={pageId} />
          })}
        </CanvasBreakpointContext.Provider>
      </IframeFrameSurface>
    </div>
  )
}
