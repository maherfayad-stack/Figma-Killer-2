/**
 * `studio_upload_asset` — the one Studio tool that still genuinely needs the
 * user's own browser session.
 *
 * This file used to declare four `execution: 'browser'` tools. W9-6 moved
 * three of them server-side, because none of the three was ever about the
 * user's session: `studio_computed_styles` asks what the CSS on disk resolved
 * to (`computedStyles.ts`), and `studio_set_frame_axes` /
 * `studio_duplicate_frame_as_variant` write `.studio/boards.json`
 * (`frameAxesTools.ts`). Each one paid ~8s of bridge timeout and then refused
 * whenever no tab happened to be open, for a browser it did not need.
 *
 * This one stays. The upload posts real `FormData` to
 * `/admin/api/studio/asset-upload` as the signed-in user, and that endpoint's
 * authority is the operator's session — which is exactly the thing a
 * server-side tool has no honest way to hold. So the browser does the post,
 * and every validation (magic-number sniffing, containment, collision-safe
 * naming) happens server-side just as it does for a human upload.
 *
 * Like `exportFrames.ts`, this file declares only name/description/schema/gate.
 * The real work runs client-side (`src/admin/pages/site/agent/studioUploadAsset.ts`,
 * dispatched by `executor.ts`).
 */
import { StudioUploadAssetInputSchema } from '@core/ai'
import type { AiTool } from '../../../runtime/types'

const uploadAssetTool: AiTool = {
  name: 'studio_upload_asset',
  scope: 'site',
  execution: 'browser',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Land a new image file into the project — wraps the same POST /admin/api/studio/asset-upload endpoint the canvas\'s own asset picker uses (real bytes sniffed against image magic numbers, containment-checked target directory, collision-safe naming; a declared mimeType that does not match the actual bytes is refused). Returns { relPath } — the new file\'s workspace-relative POSIX path, ready to pass as an insert edit\'s import target or a kind:"asset" edit\'s assetPath. This is the ONLY way to land a genuinely NEW image file; studio_apply_edits\' asset-kind edit only repoints an EXISTING import at a file that is already on disk. It posts as the signed-in user, so it needs the project open in a Studio browser tab — studio_fetch_remote_asset is the headless alternative when the bytes are already at an http(s) URL. Requires studio.write.',
  inputSchema: StudioUploadAssetInputSchema,
}

export const studioUploadAssetMcpTools: AiTool[] = [uploadAssetTool]
