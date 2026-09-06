/**
 * LazyImportProjectDialog — the ONE lazy boundary around `ImportProjectDialog`.
 *
 * The dialog pulls in the `Dialog`/`Tabs`/`FileUpload` primitives plus both
 * import clients, and is closed almost all of the time. Two always-mounted
 * surfaces open it: the dashboard launcher's "Import project" action
 * (`DashboardPage`) and the Studio toolbar's `ImportProjectButton`. Both route
 * through this single `lazy()` reference rather than each calling `lazy()` on
 * the same dynamic import — the bundler would dedupe those into one chunk but
 * give them two distinct component identities. Same pattern as
 * `LazyModuleInserterDialog`.
 *
 * `fallback={null}`: the convention for every full-screen/portal dialog behind
 * a lazy boundary here (`SettingsModal`, `ModuleInserterDialog`,
 * `MediaPickerModal`) — there is no inline layout to shift while the chunk
 * loads.
 */
import { lazy, Suspense } from 'react'

const ImportProjectDialogImpl = lazy(() =>
  import('./ImportProjectDialog').then((m) => ({ default: m.ImportProjectDialog })),
)

interface LazyImportProjectDialogProps {
  open: boolean
  onClose: () => void
  /** See `ImportProjectDialog`'s own prop doc — fired once the import lands. */
  onImported?: () => void
}

export function LazyImportProjectDialog({
  open,
  onClose,
  onImported,
}: LazyImportProjectDialogProps) {
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <ImportProjectDialogImpl onClose={onClose} onImported={onImported} />
    </Suspense>
  )
}
