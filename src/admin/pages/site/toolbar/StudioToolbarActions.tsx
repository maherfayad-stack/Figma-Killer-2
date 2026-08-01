/**
 * StudioToolbarActions — bundles the Studio-only toolbar controls
 * (`ImportProjectButton`, `PreviewAxesControls`, `DownloadCodeButton`)
 * behind a single lazy boundary.
 *
 * `AdminCanvasLayout` only renders these in Studio mode (`?studio`), which
 * is the minority case — the default CMS editor never needs them. Lazy-
 * loading each control separately would still pull independent dynamic
 * `import()` graphs (and their preload dependency maps) into the eager
 * SitePage route chunk; bundling them into one module means the SitePage
 * shell pays for exactly one `import()` boundary instead of several.
 */
import { ImportProjectButton } from './ImportProjectButton'
import { PreviewAxesControls } from './PreviewAxesControls'
import { DownloadCodeButton } from './DownloadCodeButton'

export function StudioToolbarActions() {
  return (
    <>
      <ImportProjectButton />
      <PreviewAxesControls />
      <DownloadCodeButton />
    </>
  )
}
