/**
 * AssetPreview — the picture on an asset card is a LIVE RENDER of the real
 * component, with the same props an insert would seed.
 *
 * What it replaced: a CSS wireframe. 25 `base.*` ids had hand-drawn shapes and
 * everything else — every design-system component — fell back to a grey sketch
 * derived from the component's NAME and PROP TYPES. Its own doc admitted it
 * was "a sketch derived from an API, not a rendering", and it made the palette
 * harder to search than a plain list of names would have been.
 *
 * Four decisions worth knowing:
 *
 * **The props come from the module's own `defaults`.** That is literally what
 * `insertNode` writes, so the card is what will land on the canvas — not a
 * curated marketing shot of it.
 *
 * **Design-system components render inside a shadow root** whose
 * `adoptedStyleSheets` carry `designSystemPreviewSheet()`. The design system's
 * CSS is written for a document (`:root` tokens, `body` resets, unprefixed
 * `.btn`-style class names); adopting it into the admin document would restyle
 * the editor. `base.*` modules render in the LIGHT DOM instead, because they
 * are styled by the admin's own CSS modules — which a shadow root would cut
 * them off from — and they carry no vendor CSS to leak.
 *
 * **Content is portaled, not re-rooted.** `createPortal(children, shadowRoot)`
 * keeps one React tree, so the editor store, the error boundary and
 * `FramePreviewAxesContext` all reach the component the ordinary way. A second
 * `createRoot` would need its own providers and its own unmount lifecycle for
 * no gain — the isolation here is CSS isolation, which the shadow root gives
 * either way.
 *
 * **Nothing renders until the card is near the viewport,** and it unmounts
 * when it leaves. ~70 cards exist; a handful are ever live.
 */
import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useResolvedFrameAxes, FramePreviewAxesContext } from '@site/canvas/previewAxesFrameEffect'
import {
  getPackageBundleStatus,
  subscribePackageBundleStatus,
} from '@site/studio/studioProjectTrust'
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import type { AssetItem } from './assetsModel'
import { ASSET_PREVIEW_OVERRIDES } from './assetPreviewOverrides'
import { designSystemPreviewSheet } from './designSystemPreviewSheet'
import styles from './AssetPreview.module.css'

/** How far outside the scroller a card starts rendering. */
const NEAR_VIEWPORT_MARGIN = '200px'

export function AssetPreview({ item }: { item: AssetItem }) {
  // A saved layout and a Visual Component are TREES of nodes, not components:
  // they render through `NodeRenderer` inside a frame, against the active
  // document's store. There is nothing standalone to mount, so they keep a
  // mark — which is a label, not a fabricated sketch of their contents.
  if (item.kind === 'savedLayout') {
    return <LayoutSolidIcon size={20} aria-hidden="true" className={styles.glyph} />
  }
  if (item.kind === 'component') {
    return <BracesIcon size={20} aria-hidden="true" className={styles.glyph} />
  }
  return <ModulePreview item={item} />
}

function ModulePreview({ item }: { item: Extract<AssetItem, { kind: 'module' }> }) {
  // `base.*` modules are styled by the admin's own CSS modules, which do not
  // cross a shadow boundary; everything else needs the design system's sheet,
  // which must not cross into the document. Fixed for the life of the card —
  // each one is keyed by its module id.
  const isolate = !item.id.startsWith('base.')
  const axes = useResolvedFrameAxes()
  const bundleStatus = useSyncExternalStore(
    subscribePackageBundleStatus,
    getPackageBundleStatus,
    getPackageBundleStatus,
  )
  const frameRef = useRef<HTMLSpanElement>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const [shadow, setShadow] = useState<ShadowRoot | null>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  const [scale, setScale] = useState(1)

  // ONE stable ref callback for the lifetime of the card, pinned by a lazy
  // `useState` initializer (not memoization — see CLAUDE.md). A fresh closure
  // each render would make React detach and re-attach the ref every time, and
  // the setState inside it would then loop. Everything it closes over is fixed
  // for this card: `isolate` follows the module id, and a setter is stable.
  const [attachHost] = useState(() => (node: HTMLElement | null) => {
    hostRef.current = node
    setShadow(node && isolate ? openShadowRoot(node) : null)
  })

  // A package component Studio could not bundle has no component to render —
  // its registered `component` IS the refusal placeholder. Say so in the card's
  // own words instead of shrinking that placeholder to 100px.
  const unbundledPackage = item.id.startsWith('pkg.') && bundleStatus?.ok === false

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting)
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN },
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // Fit: measure the host's LAYOUT size (`offsetWidth`, which a CSS transform
  // does not affect) against the card's preview box and scale down only —
  // scaling a Chip up to fill a card would lie about its size.
  useEffect(() => {
    const frame = frameRef.current
    const host = hostRef.current
    if (!frame || !host) return

    function fit() {
      if (!frame || !host) return
      const width = host.offsetWidth
      const height = host.offsetHeight
      if (width === 0 || height === 0) return
      const next = Math.min(1, frame.clientWidth / width, frame.clientHeight / height)
      setScale(Number.isFinite(next) && next > 0 ? next : 1)
    }

    const raf = requestAnimationFrame(fit)
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf)
    // Components settle late — a web font lands, an image decodes — so the fit
    // follows the content rather than being computed once.
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    observer.observe(frame)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [near, item.id])

  if (unbundledPackage) {
    return (
      <span className={styles.neutral}>
        <ModuleIcon module={item.module} size={16} aria-hidden="true" className={styles.glyph} />
        <span className={styles.neutralLabel}>Promote to preview</span>
      </span>
    )
  }

  const Comp = item.module.component
  const override = ASSET_PREVIEW_OVERRIDES[item.id]
  const content = override ? (
    override()
  ) : (
    <Comp props={item.module.defaults ?? {}} nodeId={`asset-preview:${item.id}`} isSelected={false} />
  )
  return (
    <span
      ref={frameRef}
      className={styles.frame}
      aria-hidden="true"
      style={{ '--asset-scale': scale } as CSSProperties}
    >
      <span
        ref={attachHost}
        className={styles.host}
        dir={axes.direction}
        data-theme={axes.colorScheme}
      >
        {near && (!isolate || shadow) && (
          <FramePreviewAxesContext.Provider value={axes}>
            <AssetPreviewBoundary name={item.name}>
              {isolate && shadow ? createPortal(content, shadow) : content}
            </AssetPreviewBoundary>
          </FramePreviewAxesContext.Provider>
        )}
      </span>
    </span>
  )
}

/**
 * Opens (or reuses) the host's shadow root and adopts the shared design-system
 * sheet into it. Returns `null` where shadow DOM is unavailable — the preview
 * then renders plain rather than not at all, and still leaks nothing.
 */
function openShadowRoot(node: HTMLElement): ShadowRoot | null {
  let root = node.shadowRoot
  if (!root) {
    try {
      root = node.attachShadow({ mode: 'open' })
    } catch (err) {
      console.warn('[assets] shadow root unavailable for preview:', err)
      return null
    }
  }
  const sheet = designSystemPreviewSheet()
  if (sheet && 'adoptedStyleSheets' in root) root.adoptedStyleSheets = [sheet]
  return root
}

/**
 * A component that throws inside a card degrades to its own name. The canvas
 * has the same contract (`AlmErrorBoundary`): a broken component is a broken
 * component, and the panel must keep listing it so the author can still find
 * it — and still see that it is broken.
 */
class AssetPreviewBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[assets] preview for ${this.props.name} threw:`, error, info.componentStack)
  }

  render() {
    if (this.state.failed) {
      return <span className={styles.neutralLabel}>{this.props.name}</span>
    }
    return this.props.children
  }
}
