/**
 * LazyMediaViewerWindow — lazy boundary around `MediaViewerWindow`.
 *
 * `MediaViewerWindow` (+ its `viewers/` subtree, `TagEditor`,
 * `ReplaceFileDialog`, and `useDebouncedSave`) is only needed when a user
 * actually opens an asset preview/edit flow — the callers
 * (`MediaLibraryControl`, `MediaExplorerPanel`) mount it unconditionally with
 * `open`/`editor` props that are usually falsy. `MediaViewerWindow` itself
 * already returns `null` when `!open || !editor`, so gating the dynamic
 * `import()` on the same condition here doesn't change when the window is
 * visible — it only defers the network fetch for its chunk until the first
 * time it actually needs to render.
 *
 * Suspense fallback is `null`: like `MediaPickerModal` (see
 * `MediaLibraryControl`), this is a portal-rendered overlay, so there is no
 * layout to shift while the chunk loads.
 */
import { lazy, Suspense } from 'react'
import type { MediaAssetEditor } from './MediaViewerWindow'

const MediaViewerWindowImpl = lazy(() =>
  import('./MediaViewerWindow').then((m) => ({ default: m.MediaViewerWindow })),
)

interface LazyMediaViewerWindowProps {
  editor: MediaAssetEditor | null
  open: boolean
  onClose: () => void
}

export function LazyMediaViewerWindow({ editor, open, onClose }: LazyMediaViewerWindowProps) {
  if (!open || !editor) return null
  return (
    <Suspense fallback={null}>
      <MediaViewerWindowImpl editor={editor} open={open} onClose={onClose} />
    </Suspense>
  )
}
