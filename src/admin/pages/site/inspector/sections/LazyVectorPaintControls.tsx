/**
 * The lazy boundary for `VectorPaintControls`. The Vector controls mount only
 * for a selected inline `<svg>` (or a loose layer whose root is one), so their
 * code — the controls, the burst committer — loads the first time one is
 * selected instead of riding in the editor body every session pays for
 * (`bundle-size-budgets.test.ts`, `AdminCanvasEditorBody-`). Same split as
 * `LazyStudioCanvasChrome`: this module holds only the dynamic `import()`.
 */
import { lazy, Suspense } from 'react'
import type { PageNode } from '@core/page-tree'

const VectorPaintControls = lazy(() =>
  import('./VectorPaintControls').then((m) => ({ default: m.VectorPaintControls })),
)

export function LazyVectorPaintControls({ nodeId, node }: { nodeId: string; node: PageNode }) {
  return (
    <Suspense fallback={null}>
      <VectorPaintControls nodeId={nodeId} node={node} />
    </Suspense>
  )
}
