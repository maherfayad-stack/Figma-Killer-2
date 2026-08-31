/**
 * The lazy boundary for `StudioCanvasChrome`, in its own module so `CanvasRoot`
 * imports one component and renders one line.
 *
 * `CanvasRoot` sits on the 700-line module budget, and it is the file every
 * canvas change has to touch; a `lazy()` call plus a `<Suspense>` wrapper for
 * each lazily-mounted piece is exactly the kind of boilerplate that pushes it
 * over. Same split the repo already uses for the lazy module-inserter dialog.
 *
 * Importing THIS module eagerly costs nothing — it contains only the dynamic
 * `import()`, so the chrome graph (notes toolbar, comment tool, the whole
 * `@core/studio-comments` reach) still stays out of the SitePage route chunk.
 */
import { lazy, Suspense, type RefObject } from 'react'

const StudioCanvasChrome = lazy(() =>
  import('./StudioCanvasChrome').then((m) => ({ default: m.StudioCanvasChrome })),
)

export function LazyStudioCanvasChrome({
  transformLayerRef,
}: {
  transformLayerRef: RefObject<HTMLDivElement | null>
}) {
  return (
    <Suspense fallback={null}>
      <StudioCanvasChrome transformLayerRef={transformLayerRef} />
    </Suspense>
  )
}
