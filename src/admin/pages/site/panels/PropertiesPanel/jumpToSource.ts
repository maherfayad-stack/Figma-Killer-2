/**
 * jumpToSource — R8 (`docs/audits/2026-08-06/09-refusal-states.md`): every
 * refusal surface states a `file:line`, and until this landed none of it was
 * clickable — plain text in `SourceConstraintNotice`/`BranchChoiceNotice`.
 *
 * The resolution itself (`origin.rel` → `SiteFile` id → `openInEditor`) lives
 * in `@site/store/openSourceFile`, which takes the state it needs as an
 * argument so the editor STORE can call it too — a store slice must not import
 * the composed store back. This is the component-side convenience wrapper:
 * it supplies `useEditorStore.getState()` so a call site can hand the function
 * straight to a click handler.
 *
 * A plain function, not a hook — same pattern `LayerNodeContextMenu.tsx`'s
 * dispatch helpers use, so it takes no extra render-time subscription.
 */
import { useEditorStore } from '@site/store/store'
import { openSourceFile, type SourceOrigin } from '@site/store/openSourceFile'

export type { SourceOrigin }

/** Opens `origin.rel` in the CodeEditor panel, or toasts why it couldn't. */
export function jumpToSource(origin: SourceOrigin): void {
  openSourceFile(useEditorStore.getState(), origin)
}
