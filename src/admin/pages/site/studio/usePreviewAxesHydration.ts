/**
 * usePreviewAxesHydration — WS-10 Phase 1: on project open, loads the
 * persisted `previewAxes` (`.studio/meta.json`, D5 "per project") into
 * `canvasSlice.previewAxes`, and refreshes the dark-mode capability probe
 * (`previewAxesCapability.ts`) so `PreviewAxesControls.tsx` knows whether the
 * scheme toggle applies at all. Mounted once from `AdminCanvasEditorBody.tsx`,
 * alongside `useRegisterProjectModules` — same "one effect per project-dir
 * change" shape.
 */
import { useEffect } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { fetchPersistedPreviewAxes, refreshColorSchemeCapability, clearColorSchemeCapability } from './previewAxesCapability'

export function usePreviewAxesHydration(): void {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const setPreviewAxes = useEditorStore((s) => s.setPreviewAxes)

  useEffect(() => {
    if (!projectDir) {
      clearColorSchemeCapability()
      return
    }
    let cancelled = false
    void fetchPersistedPreviewAxes(projectDir).then((axes) => {
      if (!cancelled) setPreviewAxes(axes)
    })
    void refreshColorSchemeCapability(projectDir)
    return () => {
      cancelled = true
    }
  }, [projectDir, setPreviewAxes])
}
