/**
 * LazyModuleInserterDialog — the ONE lazy boundary around `ModuleInserterDialog`.
 *
 * `ModuleInserterDialog` (module grid, wireframe previews, saved layouts, the
 * sandboxed module-preview iframe, and their own ~28 kB stylesheet) is
 * Studio's single heaviest chunk — see `bundle-size-budgets.test.ts` — yet it
 * is closed on first paint everywhere it is used. Three always-mounted
 * components open it: the toolbar "+ Add" button (`ModulePickerDropdown`),
 * the canvas selection toolbar's "Insert module" action
 * (`CanvasInsertModuleButton`), and the Layers panel's insert affordance
 * (`DomPanel`). Because those were the only static importers of the module,
 * the bundler grouped its whole graph into the eager bundle regardless of the
 * closed-by-default render gate.
 *
 * All three route through this ONE `lazy()` reference (not three separate
 * `lazy()` calls on the same dynamic import, which the bundler would dedupe
 * into one chunk but give three distinct component identities — sloppy, and
 * an avoidable remount if a caller's `open` state ever churns).
 *
 * `preloadModuleInserterDialog()` (`./preloadModuleInserterDialog.ts`, a
 * sibling non-component file — `react-refresh/only-export-components` forbids
 * mixing a plain function export into a component file) fires the same
 * `import()` ahead of the click, wired to a trigger's
 * `onPointerEnter`/`onFocus`. The chunk is unusually large, so warming it on
 * hover/focus intent means the click usually lands after the module is
 * already resident. It is a plain `import()`, not a second `lazy()`; the
 * browser/bundler module cache dedupes it against the one `lazy()` below
 * uses, so this does not reintroduce an eager import (nothing calls it on
 * mount).
 *
 * `fallback={null}`: same convention as every other full-screen/portal
 * dialog behind a lazy boundary in this codebase (`SettingsModal`,
 * `ImportProjectDialog`, `MediaPickerModal`) — there is no inline layout to
 * shift while the chunk loads, so nothing renders for the (usually
 * imperceptible, and prefetch-shortened) gap between click and paint.
 */
import { lazy, Suspense } from 'react'
import type { InsertLocation } from '@site/store/insertLocation'
import type { ModuleInserterItem } from './moduleInserterModel'

const ModuleInserterDialogImpl = lazy(() =>
  import('./ModuleInserterDialog').then((m) => ({ default: m.ModuleInserterDialog })),
)

interface LazyModuleInserterDialogProps {
  open: boolean
  onClose: () => void
  onInsertItem: (
    item: ModuleInserterItem,
    target: InsertLocation | undefined,
    mode: 'click' | 'drop',
  ) => boolean
}

export function LazyModuleInserterDialog({
  open,
  onClose,
  onInsertItem,
}: LazyModuleInserterDialogProps) {
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <ModuleInserterDialogImpl onClose={onClose} onInsertItem={onInsertItem} />
    </Suspense>
  )
}
