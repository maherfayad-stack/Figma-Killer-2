/**
 * jumpToSource — R8 (`docs/audits/2026-08-06/09-refusal-states.md`): every
 * refusal surface states a `file:line`, and until now none of it was
 * clickable — plain text in `SourceConstraintNotice`/`BranchChoiceNotice`.
 *
 * Studio's code surface (`CodeEditorPanel`) opens a `SiteFile` by ID
 * (`openInEditor`), not by workspace-relative path — this resolves an
 * `EditConstraint`/`textOrigin`/`BranchAlternative` origin's `rel` against
 * `site.files` to find that id. `CodeMirrorEditor` has no line-scroll API
 * today, so this opens the FILE, not the exact line — a real, working step
 * forward (R8's "S if a code surface exists and just needs a click handler"),
 * not the full jump. Missing the file (not tracked as a `SiteFile` — an
 * asset outside the workspace scan, a stale path) surfaces through the
 * global toast bus rather than failing silently, per this repo's error
 * handling rules.
 *
 * A plain function, not a hook — it reads `useEditorStore.getState()`
 * directly (same pattern `LayerNodeContextMenu.tsx`'s dispatch helpers use),
 * so it can be handed straight to a click handler with no extra render-time
 * subscription.
 */
import { useEditorStore } from '@site/store/store'
import { pushToast } from '@ui/components/Toast'

export interface SourceOrigin {
  rel: string
  line: number
  col: number
}

/** Opens `origin.rel` in the CodeEditor panel, or toasts why it couldn't. */
export function jumpToSource(origin: SourceOrigin): void {
  const { site, openInEditor } = useEditorStore.getState()
  const file = site?.files.find((f) => f.path === origin.rel)
  if (!file) {
    pushToast({
      kind: 'error',
      title: 'Could not open source',
      body: `${origin.rel} isn't tracked as a project file.`,
    })
    return
  }
  openInEditor(file.id)
}
