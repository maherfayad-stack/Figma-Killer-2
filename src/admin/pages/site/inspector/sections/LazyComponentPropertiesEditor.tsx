/**
 * The lazy boundary for `ComponentPropertiesEditor` and the two forms behind
 * its "+" buttons. They mount only after someone opens the "Main component"
 * mode, so their code — the editor, both popovers, the commits to the
 * component's definition — loads then, instead of riding in the editor body
 * every session pays for (`bundle-size-budgets.test.ts`,
 * `AdminCanvasEditorBody-`). Same split as `LazyVectorPaintControls`: this
 * module holds only the dynamic `import()`.
 */
import { lazy, Suspense } from 'react'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'

const ComponentPropertiesEditor = lazy(() =>
  import('./ComponentPropertiesEditor').then((m) => ({ default: m.ComponentPropertiesEditor })),
)

export function LazyComponentPropertiesEditor({ spec }: { spec: LocalComponentSpec }) {
  return (
    <Suspense fallback={null}>
      <ComponentPropertiesEditor spec={spec} />
    </Suspense>
  )
}
