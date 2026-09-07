/**
 * LazyImportSummaryDialog — the lazy boundary around `ImportSummaryDialog`,
 * for the ONE caller that reaches it without going through
 * `ImportProjectDialog` first: the launcher's drag-and-drop import.
 *
 * The dialog pulls in `Dialog` + `Select` and is closed almost all of the
 * time, so the launcher's first paint should not carry it. Inside
 * `ImportProjectDialog` no boundary is needed — that chunk is already loaded
 * by the time an import can finish.
 *
 * `fallback={null}`: the convention for every portal dialog behind a lazy
 * boundary here — there is no inline layout to shift while the chunk loads.
 */
import { lazy, Suspense } from 'react'
import type { ImportSummary } from '@site/studio/importSummary'

const ImportSummaryDialogImpl = lazy(() =>
  import('./ImportSummaryDialog').then((m) => ({ default: m.ImportSummaryDialog })),
)

interface LazyImportSummaryDialogProps {
  /** The finished import, or `null` when nothing is awaiting confirmation. */
  summary: ImportSummary | null
  onClose: () => void
  onOpen: (summary: ImportSummary) => void
}

export function LazyImportSummaryDialog({ summary, onClose, onOpen }: LazyImportSummaryDialogProps) {
  if (!summary) return null
  return (
    <Suspense fallback={null}>
      <ImportSummaryDialogImpl summary={summary} onClose={onClose} onOpen={onOpen} />
    </Suspense>
  )
}
