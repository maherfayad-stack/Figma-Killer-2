/**
 * The lazy boundary for `AddVariantPopover`, for the one caller that is not
 * already behind `LazyComponentPropertiesEditor`: the "+" in a variants-gallery
 * frame's header. The form and its write load on the first click, not with
 * the board (`bundle-size-budgets.test.ts`).
 */
import { lazy, Suspense, type ComponentProps } from 'react'

const AddVariantPopover = lazy(() => import('./AddVariantPopover').then((m) => ({ default: m.AddVariantPopover })))

export function LazyAddVariantPopover(props: ComponentProps<typeof AddVariantPopover>) {
  return (
    <Suspense fallback={null}>
      <AddVariantPopover {...props} />
    </Suspense>
  )
}
