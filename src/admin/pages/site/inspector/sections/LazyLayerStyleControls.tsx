/**
 * The lazy boundary for `LayerStyleControls`: a loose layer's controls load the
 * first time one is selected instead of riding in the editor body every session
 * pays for (`bundle-size-budgets.test.ts`). Same split as `LazyVectorPaintControls`.
 */
import { lazy, Suspense } from 'react'
import type { PageNode } from '@core/page-tree'

const LayerStyleControls = lazy(() => import('./LayerStyleControls').then((m) => ({ default: m.LayerStyleControls })))

export function LazyLayerStyleControls({ nodeId, node }: { nodeId: string; node: PageNode }) {
  return (
    <Suspense fallback={null}>
      <LayerStyleControls nodeId={nodeId} node={node} />
    </Suspense>
  )
}
