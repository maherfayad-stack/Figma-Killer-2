/**
 * StudioToolbarActions — bundles the two Studio-only toolbar buttons
 * (`ImportGithubButton` + `DownloadCodeButton`) behind a single lazy
 * boundary.
 *
 * `AdminCanvasLayout` only renders these in Studio mode (`?studio`), which
 * is the minority case — the default CMS editor never needs them. Lazy-
 * loading each button separately would still pull two independent dynamic
 * `import()` graphs (and their preload dependency maps) into the eager
 * SitePage route chunk; bundling them into one module means the SitePage
 * shell pays for exactly one `import()` boundary instead of two.
 */
import { ImportGithubButton } from './ImportGithubButton'
import { DownloadCodeButton } from './DownloadCodeButton'

export function StudioToolbarActions() {
  return (
    <>
      <ImportGithubButton />
      <DownloadCodeButton />
    </>
  )
}
