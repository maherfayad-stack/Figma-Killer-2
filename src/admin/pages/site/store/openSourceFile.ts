/**
 * openSourceFile — "open this `rel:line:col` in the code panel", expressed as
 * a function of the state it needs rather than of the store singleton.
 *
 * Studio's code surface (`CodeEditorPanel`) opens a `SiteFile` by ID
 * (`openInEditor`), not by workspace-relative path, so every jump-to-source
 * affordance has to resolve a refusal's `origin.rel` against `site.files`
 * first. That resolution is one rule and lives here, once.
 *
 * **Why it takes `state` instead of calling `useEditorStore.getState()`:** the
 * store's own slices need this — a refused structural gesture is detected
 * inside a store action and its toast offers the jump — and a module in the
 * store's import graph must never import the composed store back
 * (`store.ts → siteSlice → … → this file → store.ts` is a cycle, gated by
 * `no-circular-dependencies.test.ts`). Components outside that graph use the
 * `jumpToSource` convenience wrapper, which supplies the state for them.
 *
 * `CodeMirrorEditor` has no line-scroll API today, so this opens the FILE, not
 * the exact line — a real step forward, not the full jump. A missing file (not
 * tracked as a `SiteFile` — an asset outside the workspace scan, a stale path)
 * surfaces through the global toast bus rather than failing silently.
 */
import { pushToast } from '@ui/components/Toast'

export interface SourceOrigin {
  rel: string
  line: number
  col: number
}

/** The slice of editor state a jump needs — structurally satisfied by the whole store. */
export interface SourceFileOpener {
  site: { files: ReadonlyArray<{ id: string; path: string }> } | null
  openInEditor: (fileId: string) => void
}

/** Opens `origin.rel` in the CodeEditor panel, or toasts why it couldn't. */
export function openSourceFile(state: SourceFileOpener, origin: SourceOrigin): void {
  const file = state.site?.files.find((f) => f.path === origin.rel)
  if (!file) {
    pushToast({
      kind: 'error',
      title: 'Could not open source',
      body: `${origin.rel} isn't tracked as a project file.`,
    })
    return
  }
  state.openInEditor(file.id)
}
