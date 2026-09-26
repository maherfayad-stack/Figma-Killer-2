/**
 * The red-toast policy gate (P3-A, ROADMAP §7).
 *
 * The rule: **never show a red toast for something the editor could have done
 * itself.** A refusal is a `warning` with its one-click remedy (the editor
 * kept a promise; nothing broke). A read nobody clicked for retries quietly and
 * then shows its failure where the data would have been. A no-op is silence or
 * an `info` note. A success on a canvas gesture is the canvas changing. What is
 * left as `kind: 'error'` is an operation the user asked for that genuinely
 * failed after any retry — a Git push, an upload the server rejected, a
 * clipboard write the browser refused.
 *
 * The dispositions for every site are in
 * `docs/audits/2026-09-23-studio-audit/02-errors-client.md` §2. This gate pins
 * the result, file by file, so the count can only go DOWN on purpose:
 *
 *   - a new file with an error toast fails here, naming it;
 *   - a file whose count grows fails here, naming it;
 *   - a file whose count SHRINKS fails too, so the list is lowered in the same
 *     change and cannot quietly absorb a later regression.
 *
 * Counted: `kind: 'error'` in a non-test source file under `src/` that uses
 * `pushToast`. Before P3-A: 128 sites in 62 files. After: the table below.
 *
 * Adding a site: first check 02 §2 and ask whether the editor could do it
 * itself (retry, re-read, pick the obvious target), or whether the failure is
 * a refusal (`warning` + remedy). Only an operation failure the user must act
 * on belongs here — then add it to the table with a line in the PR body.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const SRC_ROOT = join(import.meta.dir, '../..')

/** `src/`-relative path → how many `kind: 'error'` toasts it may carry. */
const ALLOWED_ERROR_TOAST_SITES: ReadonlyMap<string, number> = new Map([
  // The one boundary that still toasts: nothing is left on screen to read.
  ['admin/main.tsx', 1],
  ['ui/components/ErrorBoundary/ErrorBoundary.tsx', 1],
  // Launcher, settings and import flows — explicit operations outside the canvas.
  ['admin/modals/Settings/sections/McpServersSection.tsx', 4],
  ['admin/modals/SiteImport/SiteImportModal.tsx', 2],
  ['admin/modals/SiteImport/shared/useCmsBundleImport.ts', 1],
  ['admin/pages/dashboard/DashboardPage.tsx', 7],
  ['admin/pages/dashboard/LauncherDropZone.tsx', 2],
  ['admin/pages/plugins/hooks/usePluginEventBridge.ts', 1],
  ['admin/shared/ExportDialog/ExportDialog.tsx', 1],
  ['admin/shared/dialogs/FrameworkManagerDialog/FrameworkManagerDialog.tsx', 1],
  ['admin/shared/dialogs/ImportProjectDialog/ImportSummaryDialog.tsx', 1],
  // Board chrome: trust tier, compiler consent, design-system move, create page (after its retry).
  ['admin/pages/site/canvas/BoardFramesLayer/AddPagePicker.tsx', 1],
  ['admin/pages/site/canvas/DesignSystemMigrateBanner/DesignSystemMigrateBanner.tsx', 1],
  ['admin/pages/site/canvas/LiveRuntimePill.tsx', 1],
  ['admin/pages/site/canvas/PackageComponentPlaceholder.tsx', 1],
  ['admin/pages/site/canvas/StyleCompileConsentBanner/StyleCompileConsentBanner.tsx', 2],
  // A PNG the clipboard refused.
  ['admin/pages/site/canvas/copyAsPng.ts', 1],
  // P5-B: the image drop's own actions — a drop where NO image could land.
  ['admin/pages/site/store/slices/site/imageDropActions.ts', 1],
  // Inspector: explicit detach/swap/export/copy actions.
  ['admin/pages/site/inspector/sections/ComponentSection.tsx', 5],
  ['admin/pages/site/inspector/sections/ExportSection.tsx', 4],
  ['admin/pages/site/panels/InspectPanel/InspectPanel.tsx', 2],
  ['admin/pages/site/panels/PropertiesPanel/ImageSourcePicker.tsx', 1],
  ['admin/pages/site/panels/PropertiesPanel/ImageSourceSection.tsx', 2],
  ['admin/pages/site/property-controls/SlotControl.tsx', 2],
  ['admin/pages/site/property-controls/SlotPicker.tsx', 4],
  ['admin/pages/site/store/constraintActions.ts', 1],
  ['admin/pages/site/store/openSourceFile.ts', 1],
  ['admin/pages/site/store/slices/site/pageActions.ts', 1],
  // Side panels (02 §2e): network operations the user asked for.
  ['admin/pages/site/agent/agentSlice.ts', 5],
  ['admin/pages/site/panels/AgentPanel/AgentComposer.tsx', 1],
  ['admin/pages/site/panels/AgentPanel/AgentImageContextMenu.tsx', 1],
  ['admin/pages/site/panels/AgentPanel/AgentSessionControls.tsx', 1],
  ['admin/pages/site/panels/AgentPanel/useDesignReferenceAttachment.ts', 4],
  ['admin/pages/site/panels/AgentPanel/usePendingImageAttachments.ts', 4],
  ['admin/pages/site/panels/AssetsPanel/ColorsSection.tsx', 1],
  ['admin/pages/site/panels/AssetsPanel/IconsSection.tsx', 1],
  ['admin/pages/site/panels/AssetsPanel/PackageBundleNotice.tsx', 1],
  ['admin/pages/site/panels/ContentPanel/ContentPanel.tsx', 5],
  ['admin/pages/site/panels/DependenciesPanel/InstallDependenciesPrompt.tsx', 2],
  ['admin/pages/site/panels/DependenciesPanel/useDependencyInstallJob.ts', 3],
  ['admin/pages/site/panels/FrameworkPanel/TokenImportStatus.tsx', 1],
  ['admin/pages/site/panels/GitPanel/DeploySection.tsx', 2],
  ['admin/pages/site/panels/GitPanel/GitHistorySection.tsx', 1],
  ['admin/pages/site/panels/GitPanel/GitPanel.tsx', 1],
  ['admin/pages/site/panels/GitPanel/RepositorySection.tsx', 4],
  ['admin/pages/site/panels/GitPanel/useDeployState.ts', 3],
  ['admin/pages/site/panels/TypographyPanel/FontsSection/FontsSection.tsx', 2],
  ['admin/pages/site/studio/commentActions.ts', 1],
  ['admin/pages/site/studio/commentBulkActions.ts', 1],
  ['admin/pages/site/studio/prototypeActions.ts', 1],
  ['admin/pages/site/toolbar/DownloadCodeButton.tsx', 1],
  ['admin/pages/site/toolbar/ShareDialog.tsx', 3],
  ['admin/pages/site/toolbar/Toolbar.tsx', 1],
])

const ERROR_KIND = /kind:\s*'error'/g

function countErrorToastSites(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of walkSourceTree(SRC_ROOT)) {
    const rel = toRepoRelativePosix(file).replace(/^src\//, '')
    if (rel.includes('__tests__/') || /\.test\.tsx?$/.test(rel)) continue
    const source = readSource(file)
    if (!source.includes('pushToast')) continue
    const count = source.match(ERROR_KIND)?.length ?? 0
    if (count > 0) counts.set(rel, count)
  }
  return counts
}

describe('red-toast policy (P3-A)', () => {
  it('every `kind: \'error\'` toast site is on the reviewed list, at its reviewed count', () => {
    const actual = countErrorToastSites()
    const problems: string[] = []
    for (const [file, count] of actual) {
      const allowed = ALLOWED_ERROR_TOAST_SITES.get(file)
      if (allowed === undefined) problems.push(`NEW  ${file}: ${count} error toast(s)`)
      else if (count > allowed) problems.push(`GREW ${file}: ${allowed} → ${count}`)
      else if (count < allowed) problems.push(`SHRANK ${file}: ${allowed} → ${count} (lower the table)`)
    }
    for (const [file, allowed] of ALLOWED_ERROR_TOAST_SITES) {
      if (!actual.has(file)) problems.push(`GONE ${file}: was ${allowed} (remove it from the table)`)
    }
    if (problems.length > 0) {
      throw new Error(
        '[red-toast policy] the error-toast sites drifted:\n' +
          problems.map((problem) => `  - ${problem}`).join('\n') +
          '\n\nA refusal is a warning with its remedy; a read retries and fails in place; a no-op is ' +
          'silent or info. Read this file’s header before adding an error toast.',
      )
    }
    expect(problems).toEqual([])
  })

  it('the canvas write path shows no red card at all', () => {
    // The surfaces 02 §2a/§2b are about: a gesture, an autosave, a refusal,
    // a load. Each used to own at least one `kind: 'error'`.
    const actual = countErrorToastSites()
    const writePath = [
      'admin/pages/site/studio/refusalToasts.ts',
      'admin/pages/site/studio/studioStructuralCommits.ts',
      // The shared structural commit body, split out of the file above.
      'admin/pages/site/studio/studioStructuralCommitEngine.ts',
      'admin/pages/site/store/slices/site/instanceOnlyGesture.ts',
      'admin/pages/site/studio/studioSaveRequests.ts',
      'admin/pages/site/studio/studioAssetEdit.ts',
      'admin/pages/site/studio/structuralCommitQueue.ts',
      'admin/pages/site/hooks/usePersistence.ts',
      'admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx',
      'admin/spotlight/commands/editor.ts',
    ]
    expect(writePath.filter((file) => actual.has(file))).toEqual([])
  })
})
