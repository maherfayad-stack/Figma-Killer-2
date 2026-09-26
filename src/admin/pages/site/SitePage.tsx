import { useEffect } from 'react'
import { AdminCanvasLayout } from '@admin/layouts/AdminCanvasLayout'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { useEditorStore } from '@site/store/store'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import { RefusalDialog } from '@site/ui/RefusalDialog'
import { DetachConfirmDialog } from '@site/ui/DetachConfirmDialog'
import { ChromeBoundary } from '@site/ui/ChromeBoundary'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { agentProjectDir, executeAgentTool } from './agent'
import { flushEditorSave } from './hooks/editorSaveRef'

async function flushPendingSiteDraft(): Promise<void> {
  if (useEditorStore.getState().hasUnsavedChanges) await flushEditorSave()
}

/**
 * SitePage — visual editor route.
 *
 * The route renders the real admin/site shell immediately. Heavy editor body
 * work (DnD, canvas, panels, module registration, CodeMirror panel mount) is
 * lazy-loaded one level down by AdminCanvasLayout after the shell has painted.
 */
export function SitePage() {
  // THE editor keyboard listener (`K1`). One `document` keydown/keyup pair for
  // the whole workspace; every canvas shortcut registers a SCOPE handler with
  // it instead of adding a listener of its own — see
  // `canvas/editorKeyDispatcher.ts` for the precedence ladder. Mounted here,
  // above the lazy editor body, so it exists before the canvas does and
  // survives every remount below it.
  useEditorKeyDispatcher()

  // Relay MCP browser-tool calls to this open editor while it's mounted.
  // The bridge is registered server-side under `site:${projectKey}`, so it
  // has to say which project this tab is showing. `agentProjectDir` is passed
  // as the getter it is, not as a value: the project settles after the first
  // load, and every reconnect (≤120s) then picks up the current one without
  // this hook having to be reactive.
  useMcpWorkspaceBridge(agentProjectDir, executeAgentTool, flushPendingSiteDraft)

  // Consume cross-workspace pending actions queued by the spotlight. Each
  // action waits for the editor store to hydrate (site !== null) — we
  // subscribe once and tear down as soon as the action has fired so the
  // listener doesn't outlive the editor mount.
  useEffect(() => {
    function runIfHydrated(): boolean {
      const store = useEditorStore.getState()
      if (!store.site) return false

      const newPage = consumePendingAction('site.newPage')
      if (newPage) {
        const title = newPage.args?.['title']?.trim()
        if (title) store.addPage(title)
        return true
      }

      const newVc = consumePendingAction('site.newVisualComponent')
      if (newVc) {
        const name = newVc.args?.['name']?.trim()
        if (name) {
          const vcId = store.createVisualComponent(name)
          store.setActiveDocument({ kind: 'visualComponent', vcId })
        }
        return true
      }

      return true // hydrated but nothing queued — stop waiting
    }

    if (runIfHydrated()) return

    const unsubscribe = useEditorStore.subscribe(() => {
      if (runIfHydrated()) unsubscribe()
    })
    return unsubscribe
  }, [])

  return (
    <>
      <AdminCanvasLayout />
      {/* ERR-13 — outside every editor boundary but `admin-route`, which
          would take the whole editor down with it. */}
      <ChromeBoundary id="refusal-dialog">
        <RefusalDialog />
      </ChromeBoundary>
      {/* P5-C — the detach confirm, asked only when a detach loses something. */}
      <ChromeBoundary id="detach-confirm-dialog">
        <DetachConfirmDialog />
      </ChromeBoundary>
    </>
  )
}
