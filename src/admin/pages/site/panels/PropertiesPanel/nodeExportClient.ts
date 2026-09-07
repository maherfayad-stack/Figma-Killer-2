/**
 * nodeExportClient — the Export section's four verbs, as plain async
 * functions the component can hand straight to a click handler.
 *
 * Every network hop rides `@core/http`: `apiBlobRequest` for the binary
 * exports (PNG bytes from the capture route, an `.svg` asset from the
 * ordinary studio asset route) and `apiRequest` with a TypeBox schema for the
 * JSX read. Nothing here hand-rolls a `fetch`, and nothing casts a response
 * body.
 *
 * Failures throw. The caller (`ExportSection.tsx`) is the one place that
 * knows how to tell the user, and it does so through `pushToast` — so a
 * refusal reason written in `nodeExportModel.ts` or on the server reaches the
 * user verbatim instead of being swallowed here.
 */
import { apiBlobRequest, apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { saveBlobAsFile } from '@admin/shared/saveBlobAsFile'
import { studioWriteDir } from '@site/studio/studioWorkspaceDir'
import {
  exportFileName,
  resolveNodeSvgExport,
  type NodeExportRow,
} from './nodeExportModel'
import type { PageNode } from '@core/page-tree'

const NodeJsxResponseSchema = Type.Object({
  jsx: Type.String(),
  rel: Type.String(),
})

/** The project dir every studio call targets, folded into a request body. */
function dirField(): { dir?: string } {
  const dir = studioWriteDir()
  return dir ? { dir } : {}
}

export interface NodePngRequest {
  pageId: string
  /** Omit to photograph the WHOLE frame — see `nodeExportRoutes.ts`'s module doc. */
  nodeId?: string | null
  scale: 1 | 2 | 3
}

/**
 * The PNG bytes for one node (or one whole frame), as a `Blob`.
 *
 * The server clamps the density against its own capture caps, so the image may
 * be smaller than @3× on a very tall screen — callers still report what was
 * ASKED for, because that is what the request means.
 *
 * Shared by the download row and by ⌘⇧C (Copy as PNG), so the two verbs can
 * never disagree about which endpoint, which body, or which content-type check
 * is correct.
 */
export async function fetchNodePngBlob(request: NodePngRequest): Promise<Blob> {
  const blob = await apiBlobRequest('/admin/api/studio/node-png', {
    method: 'POST',
    body: {
      ...dirField(),
      pageId: request.pageId,
      ...(request.nodeId ? { nodeId: request.nodeId } : {}),
      scale: request.scale,
    },
    fallbackMessage: 'This element could not be exported as a PNG.',
  })
  if (!blob.type.toLowerCase().startsWith('image/png')) {
    throw new Error('The server did not return a PNG.')
  }
  return blob
}

/** Download a PNG of `nodeId` on `pageId` at the row's density. */
export async function downloadNodePng(params: {
  pageId: string
  nodeId: string
  nodeLabel: string
  row: NodeExportRow
}): Promise<void> {
  const blob = await fetchNodePngBlob({
    pageId: params.pageId,
    nodeId: params.nodeId,
    scale: params.row.scale,
  })
  saveBlobAsFile(blob, exportFileName(params.nodeLabel, params.row))
}

/**
 * Put a PNG of the current target on the system clipboard.
 *
 * `ClipboardItem` — not `writeText` — because the payload is bytes: this is
 * what lets the user paste straight into Figma, Slack or a doc. Both halves of
 * the API are feature-detected and refused BY NAME rather than throwing a bare
 * `TypeError` from a browser (or an insecure origin) that does not have them,
 * since "copy silently did nothing" is the failure this verb has to avoid.
 */
export async function copyPngToClipboard(request: NodePngRequest): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('This browser cannot put images on the clipboard. Use Export PNG to download the file instead.')
  }
  const blob = await fetchNodePngBlob(request)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/**
 * Download the node's SVG, or throw the named refusal.
 *
 * Both honest shapes are resolved without the server re-deriving anything:
 * inline markup the parse already serialised becomes a blob directly, and an
 * `.svg` asset is read through the same authenticated `/admin/api/studio/asset`
 * URL the canvas is already rendering it from. See `nodeExportModel.ts` for
 * why the decision itself lives on this side.
 */
export async function downloadNodeSvg(params: {
  node: Pick<PageNode, 'moduleId' | 'props'>
  nodeLabel: string
  row: NodeExportRow
}): Promise<void> {
  const resolved = resolveNodeSvgExport(params.node)
  if (!resolved.ok) throw new Error(resolved.message)

  const fileName = exportFileName(params.nodeLabel, params.row)
  if (resolved.source === 'inline') {
    saveBlobAsFile(new Blob([resolved.markup], { type: 'image/svg+xml' }), fileName)
    return
  }

  const blob = await apiBlobRequest(resolved.url, {
    fallbackMessage: 'This element’s SVG file could not be read.',
  })
  const mimeType = blob.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  // An asset route that answered with something other than SVG means the file
  // behind this `src` is not what its name claims. Refuse rather than save a
  // `.svg` holding a PNG.
  if (mimeType && mimeType !== 'image/svg+xml') {
    throw new Error('That file is not an SVG, despite its name — export PNG instead.')
  }
  saveBlobAsFile(blob, fileName)
}

/** The node's own JSX, read verbatim off disk. */
export async function readNodeJsxSource(nodeId: string): Promise<string> {
  const body = await apiRequest('/admin/api/studio/node-jsx', {
    method: 'POST',
    body: { ...dirField(), nodeId },
    schema: NodeJsxResponseSchema,
    fallbackMessage: 'This element’s JSX could not be read.',
  })
  return body.jsx
}

/** Write `text` to the system clipboard, or throw a reason the user can act on. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('This browser does not allow copying to the clipboard from here.')
  }
  await navigator.clipboard.writeText(text)
}
