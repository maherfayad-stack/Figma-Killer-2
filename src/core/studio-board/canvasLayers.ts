/**
 * canvasLayers — the free canvas's identity and path rules (OD-14, bundle
 * P5-G; design: `docs/audits/2026-09-23-studio-audit/10-free-canvas.md`).
 *
 * A **loose layer** is one item placed on the empty board, outside every
 * frame: an element, a component instance or an image. It is never part of a
 * page, the live preview, a publish or a deploy. Its CONTENT is a real TSX
 * module Studio owns, at `.studio/canvas/<layerId>.tsx`, parsed like a page;
 * its PLACEMENT (board x/y, z, lock, hide) lives in `.studio/boards.json`
 * (`Board.layers`, see `types.ts`). Content in code, position in board
 * metadata — the same split a frame already has.
 *
 * ## Why this module is the ONLY place that spells the path
 *
 * `.studio/` is Studio's control plane (trust tier, MCP approvals), and every
 * Studio writer refuses it (`@core/page-parser`'s `workspaceWriteScope.ts`,
 * P1-G). The free canvas needs exactly one exception to that rule, and an
 * exception is only as narrow as the predicate that grants it. So:
 *
 *  - the id grammar is fixed and tiny (`cl` + ten lowercase base-36
 *    characters), which admits no separator, no dot and no case variant;
 *  - {@link canvasLayerIdFromRel} accepts ONLY the exact
 *    `.studio/canvas/<id>.tsx` spelling — no `..`, no nesting, no backslash,
 *    no other extension, no uppercase;
 *  - every write builds its path FROM a validated id ({@link canvasLayerRelPath}),
 *    never from a client-supplied path.
 *
 * `canvas-layer-isolation.test.ts` holds the literal `.studio/canvas` to this
 * file, so a second, looser spelling cannot appear elsewhere unnoticed.
 */
import { Type, type Static } from '@sinclair/typebox'

/** The workspace-relative directory every layer module lives in. */
export const CANVAS_LAYER_DIR = '.studio/canvas'

/** `cl` + ten lowercase base-36 characters. */
export const CANVAS_LAYER_ID_PATTERN = '^cl[a-z0-9]{10}$'

export const CanvasLayerIdSchema = Type.String({ pattern: CANVAS_LAYER_ID_PATTERN })
export type CanvasLayerId = Static<typeof CanvasLayerIdSchema>

const CANVAS_LAYER_ID = new RegExp(CANVAS_LAYER_ID_PATTERN)

/**
 * The exact workspace-relative spelling of a layer module, anchored at both
 * ends. The ONE pattern `server/handlers/studioEditRouting.ts` lets past its
 * `.studio` refusal (`STUDIO_AUTHORED_SOURCE_PATTERNS`).
 */
export const CANVAS_LAYER_REL_PATTERN = /^\.studio\/canvas\/(cl[a-z0-9]{10})\.tsx$/

/** Page ids of layer modules start with this. No route-derived page id contains `:`. */
const CANVAS_LAYER_PAGE_PREFIX = 'canvas:'

/** Whether `value` is a well-formed layer id. */
export function isCanvasLayerId(value: string): value is CanvasLayerId {
  return CANVAS_LAYER_ID.test(value)
}

/**
 * A fresh layer id. Crypto-random, lowercase base-36, so it is unguessable and
 * cannot collide with an id minted in another tab in any practical sense.
 */
export function mintCanvasLayerId(): CanvasLayerId {
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let id = 'cl'
  for (const byte of bytes) id += (byte % 36).toString(36)
  return id
}

/** `.studio/canvas/<id>.tsx` — built from a validated id, never from a caller's path. */
export function canvasLayerRelPath(id: CanvasLayerId): string {
  if (!isCanvasLayerId(id)) throw new Error(`Not a canvas layer id: ${JSON.stringify(id)}`)
  return `${CANVAS_LAYER_DIR}/${id}.tsx`
}

/**
 * The layer id a workspace-relative path names, or `null` when it is not
 * EXACTLY a layer module's path. Forward slashes only: node ids, reload-scope
 * files and the parse cache all carry POSIX paths, and accepting a backslash
 * spelling here would be a second spelling of the same file.
 */
export function canvasLayerIdFromRel(rel: string): CanvasLayerId | null {
  const match = CANVAS_LAYER_REL_PATTERN.exec(rel)
  return match ? (match[1] as CanvasLayerId) : null
}

/** The page id a layer's parsed tree is stored under (`canvas:<id>`). */
export function canvasLayerPageId(id: CanvasLayerId): string {
  return `${CANVAS_LAYER_PAGE_PREFIX}${id}`
}

/** The layer id a page id names, or `null` for an ordinary page. */
export function canvasLayerIdFromPageId(pageId: string): CanvasLayerId | null {
  if (!pageId.startsWith(CANVAS_LAYER_PAGE_PREFIX)) return null
  const id = pageId.slice(CANVAS_LAYER_PAGE_PREFIX.length)
  return isCanvasLayerId(id) ? id : null
}

/** Whether a page id is a loose layer's rather than a real page's. */
export function isCanvasLayerPageId(pageId: string): boolean {
  return canvasLayerIdFromPageId(pageId) !== null
}

/**
 * The synthetic node id a layer-level edit (`canvas-layer-create`/`-delete`/
 * `-restore`) carries. Every edit on the wire names a `nodeId`; these kinds
 * address a FILE that may not exist yet, so the id names the layer instead
 * and never decodes to a source location.
 */
export function canvasLayerEditNodeId(id: CanvasLayerId): string {
  return `canvas-layer:${id}`
}

/** Whether a node id is a layer-level synthetic id (see {@link canvasLayerEditNodeId}). */
export function isCanvasLayerEditNodeId(nodeId: string): boolean {
  return nodeId.startsWith('canvas-layer:')
}

/**
 * The FIRST lines of every layer module Studio writes. A layer module lives in
 * the user's repository, and ESLint's flat config lints dot-directories: a
 * scratch file must never fail the user's `eslint .`. The comment says what
 * the file is to anyone who opens it.
 */
export const CANVAS_LAYER_MODULE_HEADER = [
  '/* eslint-disable */',
  '// Studio free-canvas layer. Not part of your app: nothing imports this file.',
].join('\n')
