/**
 * Studio MCP tools — the durable design-reference store's agent-facing
 * surface: `studio_register_design_reference`, `studio_list_design_
 * references`, `studio_read_design_reference`, `studio_delete_design_
 * reference`, and `studio_recommend_export_dpr`. All `execution: 'server'`,
 * headless — the store itself (`designReferenceStore.ts`) is plain
 * filesystem state under `.studio/references/`, read/written the same way
 * every other headless Studio tool touches project state.
 *
 * Same store, two callers: the chat panel's own `POST/GET/DELETE
 * /admin/api/studio/reference-upload` (`referenceUpload.ts`) lands a
 * human-attached reference through `registerDesignReference` too — there is
 * exactly one write path regardless of which caller reaches it.
 *
 * **Why a register tool exists at all, distinct from `studio_upload_asset`/
 * `studio_fetch_remote_asset`:** those two land a file into APP CODE
 * (`src/assets`, importable by a component). A design reference is never
 * imported by the project — it is Studio's own measurement baseline, so it
 * gets its own store (`.studio/references/`), its own addressable id, and
 * its own metadata (`pageId`/`label`/`source`, a content hash) that an asset
 * upload has no use for.
 *
 * **Why `studio_recommend_export_dpr` exists:** the obvious move once you
 * have a registered reference is to resample it to match a fresh
 * `studio_export_frames` capture — that is the WORSE option (interpolation
 * artifacts show up as diff noise in exactly the regions being measured, and
 * it degrades a baseline that was deliberately kept lossless). The better
 * primary path is exporting the frame at the `dpr` that makes
 * `studio_export_frames`'s OWN capture land on the reference's pixel size in
 * the first place — this tool computes that `dpr` from the reference's
 * intrinsic width and the frame's AUTHORED width (`.studio/boards.json`),
 * before any capture happens. `studio_diff_frames`'s `referenceId` input
 * still reconciles a residual mismatch (a non-integer ratio, or a reference
 * wider than the shared vision-safe edge cap allows even at `dpr:3`) — see
 * that tool's own module doc — but calling this one first is what makes an
 * EXACT (non-resampled) match the common case rather than the exception.
 */
import {
  AI_USER_IMAGE_MAX_EDGE,
  DESIGN_REFERENCE_MAX_BYTES,
  StudioRegisterDesignReferenceInputSchema,
  StudioListDesignReferencesInputSchema,
  StudioReadDesignReferenceInputSchema,
  StudioDeleteDesignReferenceInputSchema,
  StudioRecommendExportDprInputSchema,
  aiToolError,
  aiToolOk,
} from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import { fetchRemoteBytes } from '../../../../handlers/studio/remoteAssetFetch'
import {
  getDesignReference,
  listDesignReferences,
  readDesignReferenceBytes,
  registerDesignReference,
  removeDesignReference,
} from '../../../../handlers/studio/designReferenceStore'

// ---------------------------------------------------------------------------
// studio_register_design_reference
// ---------------------------------------------------------------------------

const registerDesignReferenceTool: AiTool = {
  name: 'studio_register_design_reference',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Durably register a design reference (typically a Figma export) for later measurement — the fix for "a design pasted into chat is a transient, lossy attachment with no handle a tool can address later". Stores the ORIGINAL bytes verbatim (never re-encoded, never downsampled) under .studio/references/ and returns { reference } with a durable id, intrinsic width/height, a content hash, and its byte size. Provide EXACTLY ONE of url (fetched SERVER-SIDE, never transiting you — prefer this when another tool already returned a download URL, e.g. a connected Figma MCP server\'s export tool) or imageBase64 (when you already hold the bytes). Raster only — PNG/JPEG/GIF/WEBP/AVIF; an SVG is refused outright (no fixed intrinsic pixel size to diff against). Pass pageId to scope this reference to one Studio page (recommended — studio_list_design_references and studio_recommend_export_dpr both filter/require it), plus an optional label and source (e.g. a Figma file/node URL) for anyone reading this back later. Once registered, pair it with studio_recommend_export_dpr and studio_diff_frames\' referenceId input instead of base64-encoding it again on every diff call.',
  inputSchema: StudioRegisterDesignReferenceInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, url, imageBase64, pageId, label, source } = input as {
      dir?: string
      url?: string
      imageBase64?: string
      pageId?: string
      label?: string
      source?: string
    }

    if ((url !== undefined) === (imageBase64 !== undefined)) {
      return { ok: false, error: 'Provide exactly one of url or imageBase64.' }
    }

    const dir = resolveToolProjectDir(dirInput, ctx)

    let bytes: Uint8Array
    if (url !== undefined) {
      // A design reference is stored lossless on purpose, so it gets the
      // reference cap (50 MB) rather than `fetchRemoteBytes`'s ordinary
      // 25 MB asset ceiling — otherwise registering a comp BY URL failed at
      // a size the HTTP upload route happily accepted. See `maxBytes` on
      // `FetchRemoteAssetDeps` for why this is per-caller and not one shared
      // constant.
      const fetched = await fetchRemoteBytes(url, { maxBytes: DESIGN_REFERENCE_MAX_BYTES })
      if (!fetched.ok) return { ok: false, error: fetched.error }
      bytes = fetched.bytes
    } else {
      bytes = new Uint8Array(Buffer.from(imageBase64 as string, 'base64'))
    }

    const result = await registerDesignReference(dir, bytes, { pageId, label, source })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, dir, reference: result.reference }
  },
}

// ---------------------------------------------------------------------------
// studio_list_design_references
// ---------------------------------------------------------------------------

const listDesignReferencesTool: AiTool = {
  name: 'studio_list_design_references',
  scope: 'shared',
  execution: 'server',
  description:
    'List design references registered for this project (studio_register_design_reference). Pass pageId to restrict to references scoped to one Studio page. Capped (default 50, max 200) with an honest truncated/omittedCount — never a silent drop. Each entry is the full metadata (id, ext, mimeType, width, height, sizeBytes, contentHash, pageId?, label?, source?, createdAt) with no image bytes — call studio_read_design_reference with includeImage:true to actually see one.',
  inputSchema: StudioListDesignReferencesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageId, limit } = input as { dir?: string; pageId?: string; limit?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = listDesignReferences(dir, pageId, limit)
    return {
      ok: true,
      dir,
      totalCount: result.totalCount,
      returnedCount: result.references.length,
      truncated: result.truncated,
      ...(result.truncated ? { omittedCount: result.omittedCount } : {}),
      references: result.references,
    }
  },
}

// ---------------------------------------------------------------------------
// studio_read_design_reference
// ---------------------------------------------------------------------------

const readDesignReferenceTool: AiTool = {
  name: 'studio_read_design_reference',
  scope: 'shared',
  execution: 'server',
  description:
    'Read one registered design reference\'s metadata by id, optionally with its actual image bytes. includeImage:false (default) returns only the metadata — cheap, use this before studio_recommend_export_dpr or studio_diff_frames\' referenceId input, which both only need the metadata. includeImage:true also returns the ORIGINAL bytes as an MCP image block, so you can actually look at it — costs real context for a large reference. Returns ok:false with a clear reason for an unknown id, or for a registered id whose file is missing from disk (e.g. pruned outside Studio).',
  inputSchema: StudioReadDesignReferenceInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, referenceId, includeImage } = input as { dir?: string; referenceId: string; includeImage?: boolean }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const reference = getDesignReference(dir, referenceId)
    if (!reference) {
      return aiToolError(`No design reference "${referenceId}" found for this project — call studio_list_design_references to see what is registered.`)
    }
    if (!includeImage) {
      return aiToolOk({ ok: true, dir, reference })
    }
    const bytes = readDesignReferenceBytes(dir, reference)
    if (!bytes) {
      return aiToolError(`Design reference "${referenceId}" is registered but its file could not be read from disk — it may have been removed outside Studio.`)
    }
    return aiToolOk(
      { ok: true, dir, reference },
      [{ mimeType: reference.mimeType, data: Buffer.from(bytes).toString('base64') }],
    )
  },
}

// ---------------------------------------------------------------------------
// studio_delete_design_reference
// ---------------------------------------------------------------------------

const deleteDesignReferenceTool: AiTool = {
  name: 'studio_delete_design_reference',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Remove a registered design reference by id, deleting both its manifest entry and its on-disk bytes. Idempotent — removing an unknown or already-removed id still returns { ok: true, removed: false }, never an error. Requires studio.write.',
  inputSchema: StudioDeleteDesignReferenceInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, referenceId } = input as { dir?: string; referenceId: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = removeDesignReference(dir, referenceId)
    return { ok: true, dir, removed: result.removed }
  },
}

// ---------------------------------------------------------------------------
// studio_recommend_export_dpr
// ---------------------------------------------------------------------------

const DPR_MIN = 0.5
const DPR_MAX = 3

const recommendExportDprTool: AiTool = {
  name: 'studio_recommend_export_dpr',
  scope: 'shared',
  execution: 'server',
  description:
    'Compute the studio_export_frames `dpr` that makes its capture of `pageId`\'s board frame land on `referenceId`\'s registered pixel WIDTH — the dpr-matching alternative to letting studio_diff_frames resample the reference (a resampled score is a weaker claim than a dpr-matched one; see studio_diff_frames\' own description). Uses the frame\'s AUTHORED width from .studio/boards.json (before any dpr scaling), not a live capture — height is content-driven (scroll-unroll can make the real capture taller than the frame\'s nominal height) and cannot be predicted from this alone, so only WIDTH is guaranteed exact when you export at the recommended dpr; verify the actual result via studio_export_frames\' own reported width/height afterward. `dprClamped` is true when the ideal ratio falls outside the tool\'s 0.5–3 range; `exactWidthMatchExpected` is false when either that clamp OR the shared vision-safe edge cap will keep the capture narrower than the reference — in either case, expect studio_diff_frames\' referenceId path to resample rather than get an exact dimension match.',
  inputSchema: StudioRecommendExportDprInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageId, referenceId } = input as { dir?: string; pageId: string; referenceId: string }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const frameWidth = authoredFrameWidth(dir, pageId)
    if (frameWidth === null) {
      return { ok: false, error: `No board frame found for page "${pageId}" — call studio_list_pages first.` }
    }

    const reference = getDesignReference(dir, referenceId)
    if (!reference) {
      return { ok: false, error: `No design reference "${referenceId}" found for this project — call studio_list_design_references to see what is registered.` }
    }

    const idealDpr = reference.width / frameWidth
    const recommendedDpr = Math.round(Math.min(DPR_MAX, Math.max(DPR_MIN, idealDpr)) * 10_000) / 10_000
    const dprClamped = Math.abs(recommendedDpr - idealDpr) > 1e-9
    const rawCapturedWidth = frameWidth * recommendedDpr
    const visionCapClamped = rawCapturedWidth > AI_USER_IMAGE_MAX_EDGE
    const expectedCapturedWidth = Math.round(Math.min(rawCapturedWidth, AI_USER_IMAGE_MAX_EDGE))
    const exactWidthMatchExpected = expectedCapturedWidth === reference.width

    const note = exactWidthMatchExpected
      ? undefined
      : dprClamped
        ? `The ideal dpr (${idealDpr.toFixed(3)}) is outside the allowed ${DPR_MIN}-${DPR_MAX} range studio_export_frames accepts, so an exact width match isn't reachable via dpr alone.`
        : visionCapClamped
          ? `A dpr of ${recommendedDpr} would produce a ${Math.round(rawCapturedWidth)}px-wide capture, above the shared ${AI_USER_IMAGE_MAX_EDGE}px vision-safe limit studio_export_frames enforces — the actual capture will be narrower than the reference.`
          : undefined

    return {
      ok: true,
      dir,
      pageId,
      frameWidth,
      referenceId,
      referenceWidth: reference.width,
      referenceHeight: reference.height,
      recommendedDpr,
      dprClamped,
      expectedCapturedWidth,
      exactWidthMatchExpected,
      ...(note ? { note } : {}),
    }
  },
}

export const studioDesignReferenceMcpTools: AiTool[] = [
  registerDesignReferenceTool,
  listDesignReferencesTool,
  readDesignReferenceTool,
  deleteDesignReferenceTool,
  recommendExportDprTool,
]
