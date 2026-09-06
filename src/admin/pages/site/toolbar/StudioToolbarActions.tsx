/**
 * StudioToolbarActions — bundles the Studio toolbar controls
 * (`ImportProjectButton`, `PreviewAxesControls`, `ShareBoardButton`,
 * `DownloadCodeButton`) behind a single lazy boundary.
 *
 * `AdminCanvasLayout` renders these once the toolbar mounts. Lazy-loading
 * each control separately would still pull independent dynamic `import()`
 * graphs (and their preload dependency maps) into the eager SitePage route
 * chunk; bundling them into one module means the SitePage shell pays for
 * exactly one `import()` boundary instead of several.
 *
 * Share sits beside Download code deliberately: they are the same verb at two
 * altitudes — "show this to somebody" (a link, read-only) and "give this to
 * somebody" (the source, editable).
 */
import { ImportProjectButton } from './ImportProjectButton'
import { PreviewAxesControls } from './PreviewAxesControls'
import { ShareBoardButton } from './ShareBoardButton'
import { DownloadCodeButton } from './DownloadCodeButton'

export function StudioToolbarActions() {
  return (
    <>
      <ImportProjectButton />
      <PreviewAxesControls />
      <ShareBoardButton />
      <DownloadCodeButton />
    </>
  )
}
