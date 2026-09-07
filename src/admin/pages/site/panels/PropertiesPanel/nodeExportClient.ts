/**
 * nodeExportClient — the Export section's four verbs, as plain async
 * functions the component can hand straight to a click handler.
 *
 * Every network hop rides `@core/http`: `apiBlobRequest` for the two binary
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

/**
 * Download a PNG of `nodeId` on `pageId` at the row's density.
 *
 * The server clamps the density against its own capture caps, so the file the
 * user gets may be smaller than @3× on a very tall screen — the row still
 * says what was ASKED for, because that is what the row means.
 */
export async function downloadNodePng(params: {
  pageId: string
  nodeId: string
  nodeLabel: string
  row: NodeExportRow
}): Promise<void> {
  const blob = await apiBlobRequest('/admin/api/studio/node-png', {
    method: 'POST',
    body: { ...dirField(), pageId: params.pageId, nodeId: params.nodeId, scale: params.row.scale },
    fallbackMessage: 'This element could not be exported as a PNG.',
  })
  if (!blob.type.toLowerCase().startsWith('image/png')) {
    throw new Error('The server did not return a PNG.')
  }
  saveBlobAsFile(blob, exportFileName(params.nodeLabel, params.row))
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
