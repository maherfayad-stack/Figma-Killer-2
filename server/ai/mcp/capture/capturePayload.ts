/**
 * Builds the JSON payload the headless capture page renders from — Studio's
 * OWN parse output for a named set of pages, and nothing else.
 *
 * This is deliberately NOT `/admin/api/studio/load`. That route is the
 * editor's: it streams every page in the project, carries the writeback
 * mapping (`styleRuleSources`), the component classification, the trust tier
 * and the palette configuration, and it authenticates with the operator's
 * admin session. A capture needs none of that. What it needs is the smallest
 * set of things that make a frame render identically to the canvas:
 *
 *   - the requested pages, already parsed and inlined,
 *   - the project-wide style registry + conditions the pages' `classIds` index,
 *   - the raw authored/vendor CSS the canvas injects verbatim,
 *   - the persisted framework settings,
 *   - each frame's authored width/height off `.studio/boards.json`.
 *
 * `loadStudioPages` still runs unfiltered underneath, for exactly the reason
 * `studioLoadResponse.ts` records: the style registry is project-wide, so a
 * per-page parse would render the requested page with a stale cascade. The
 * shared `pageParseCache` means the pages this capture does not want cost
 * close to nothing once warm.
 *
 * ## Asset URLs
 *
 * A local image import is rewritten at parse time into
 * `/admin/api/studio/asset?dir=…&path=…`, which is session-cookie gated. The
 * headless browser has no session — by design (see `captureToken.ts`). So
 * every such prop is re-pointed at this feature's own token-gated asset
 * endpoint before the payload leaves the server. Rewriting here rather than
 * in the browser keeps the token out of the page's own logic and keeps `dir`
 * out of the URL entirely: the grant already knows which project it may read.
 */
import { FRAME_WIDTH, FRAME_HEIGHT } from '@core/studio-board'
import type { AgentCapturePayload, AgentCaptureFrame } from '@core/studio-capture'
import { AGENT_CAPTURE_ASSET_PATH } from '@core/studio-capture'
import { loadStudioPages } from '../../../handlers/studioPageLoad'
import { projectDisplayName } from '../../../handlers/studioProjects'
import { readStudioFrameworkFile } from '../../../handlers/studioFramework'
import { readBoardsFileOrEmpty } from '../../../handlers/studio/boardGeometry'
import type { CaptureGrant } from './captureToken'

/** The prefix `rewriteStudioAssetSentinels` produces for a resolved local image import. */
const STUDIO_ASSET_URL_PREFIX = '/admin/api/studio/asset?'

export interface CapturePayloadFailure {
  ok: false
  /** Named, not generic — the driver forwards this verbatim so a failure says which half broke. */
  code: 'capture-pages-not-found'
  error: string
}

export type CapturePayloadResult =
  | { ok: true; payload: AgentCapturePayload }
  | CapturePayloadFailure

/**
 * Re-point every parsed local-asset URL at the capture-token-gated endpoint.
 * `dir` is dropped from the URL on purpose — the grant is the authority on
 * which project may be read, so a rewritten URL carries no directory at all.
 */
function rewriteAssetUrlsForCapture(
  pages: AgentCapturePayload['pages'],
  token: string,
): void {
  const tokenParam = encodeURIComponent(token)
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      for (const [key, value] of Object.entries(node.props)) {
        if (typeof value !== 'string' || !value.startsWith(STUDIO_ASSET_URL_PREFIX)) continue
        const path = new URLSearchParams(value.slice(STUDIO_ASSET_URL_PREFIX.length)).get('path')
        if (path === null) continue
        node.props[key] = `${AGENT_CAPTURE_ASSET_PATH}?token=${tokenParam}&path=${encodeURIComponent(path)}`
      }
    }
  }
}

/**
 * Everything the capture page needs for `grant.pageIds`, in the order they
 * were requested. A requested id that no longer resolves to a page is dropped
 * (the file was deleted or renamed since the token was minted); the driver
 * reports it as a per-page failure rather than failing the batch. All of them
 * missing IS a failure — there is nothing to photograph.
 */
export async function buildCapturePayload(
  grant: CaptureGrant,
  token: string,
): Promise<CapturePayloadResult> {
  const { pages, styleRules, conditions, vendorCss, authoredCss } = await loadStudioPages(grant.dir)

  const pageById = new Map(pages.map((page) => [page.id, page]))
  const boardsFile = readBoardsFileOrEmpty(grant.dir)
  const frameByPageId = new Map<string, { width?: number; height?: number }>()
  for (const board of boardsFile.boards) {
    for (const frame of board.frames) {
      if (!frameByPageId.has(frame.pageId)) {
        frameByPageId.set(frame.pageId, { width: frame.width, height: frame.height })
      }
    }
  }

  const selectedPages: AgentCapturePayload['pages'] = []
  const frames: AgentCaptureFrame[] = []
  for (const pageId of grant.pageIds) {
    const page = pageById.get(pageId)
    if (!page) continue
    const geometry = frameByPageId.get(pageId)
    selectedPages.push(page)
    frames.push({
      pageId,
      width: geometry?.width ?? FRAME_WIDTH,
      height: geometry?.height ?? FRAME_HEIGHT,
    })
  }

  if (selectedPages.length === 0) {
    return {
      ok: false,
      code: 'capture-pages-not-found',
      error: `None of the requested pages (${grant.pageIds.join(', ')}) exist in ${grant.dir} any more — they were deleted or renamed after this capture started.`,
    }
  }

  rewriteAssetUrlsForCapture(selectedPages, token)

  return {
    ok: true,
    payload: {
      dir: grant.dir,
      projectName: projectDisplayName(grant.dir),
      frames,
      pages: selectedPages,
      styleRules,
      conditions,
      authoredCss,
      vendorCss,
      framework: readStudioFrameworkFile(grant.dir),
      ...(grant.axes ? { axes: grant.axes } : {}),
    },
  }
}
