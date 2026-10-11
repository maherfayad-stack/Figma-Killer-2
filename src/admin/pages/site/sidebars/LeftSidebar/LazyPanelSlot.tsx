/**
 * LazyPanelSlot - mounts a left-sidebar panel the first time it is opened,
 * then keeps it mounted.
 *
 * The docked panels that are not part of the first paint (Variables,
 * Dependencies, Version control, Framework) are `lazy()` chunks so their code
 * stays out of `AdminCanvasEditorBody`. Nothing is imported or mounted until the
 * rail asks for the panel; after that the slot behaves exactly like the old
 * always-mounted one (the caller's wrapper toggles `hidden`), so a half-typed
 * value or a scroll position survives a tab switch.
 */
import { Suspense, useState, type ReactNode } from 'react'
import { SkeletonRows } from '@ui/components/Skeleton'

export function LazyPanelSlot({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active)
  if (active && !opened) setOpened(true)
  if (!opened) return null
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading panel">
          <SkeletonRows count={8} />
        </div>
      }
    >
      {children}
    </Suspense>
  )
}
