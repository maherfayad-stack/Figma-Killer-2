/**
 * useStudioImportSetupPass — starts the agent's setup turn after an import.
 *
 * Mounted in the lazy editor body beside the other editor-only studio hooks,
 * and for the same reason `useStudioPrototypeLoad` is: there is nothing to set
 * up until there is a board to set up.
 *
 * WHY IT WAITS FOR THE RELOAD EVENT RATHER THAN FIRING FROM THE DIALOG
 * ───────────────────────────────────────────────────────────────────
 * The import dialog knows the project landed; it does not know the editor
 * switched to it. `setStudioWorkspaceDir` + `requestCmsSiteReload` are what
 * make every subsequent request target the new directory, and a turn started
 * before that lands would have the agent auditing the PREVIOUS project — the
 * same class of mistake `useStudioPrototypeLoad`'s own reload listener exists
 * to avoid, except here it would be an agent writing to the wrong repo.
 *
 * The pass is queued by the dialog and consumed here, exactly once. If the
 * user closes Studio before the editor mounts, the queued dir dies with the
 * page and no turn is ever started, which is the correct outcome: an agent
 * pass nobody is watching is a billed turn nobody asked to keep watching.
 */
import { useEffect } from 'react'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import { consumeImportSetupPass, importSetupBrief } from './importSetupPass'

/** The project's display name — the folder is the only name an import has. */
function projectNameFromDir(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

export function useStudioImportSetupPass(): void {
  useEffect(() => {
    function run() {
      const dir = consumeImportSetupPass()
      if (!dir) return

      const store = useEditorStore.getState()
      // Opened, not silent. The pass edits the user's files, so it happens
      // where they can read it, interrupt it and answer it — a turn running
      // behind a closed panel is indistinguishable from Studio changing their
      // repo on its own.
      store.openAgent()
      void store.sendAgentMessage([{ kind: 'text', text: importSetupBrief(projectNameFromDir(dir)) }])
    }

    // Both: the editor may mount fresh on an import from the Overview
    // launcher, or already be mounted and merely switch projects.
    run()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, run)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, run)
    }
  }, [])
}
