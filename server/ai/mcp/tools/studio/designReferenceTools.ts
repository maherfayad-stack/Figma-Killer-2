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
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { assertPathWithin } from '../../../../util/pathWithin'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { authoredFrameHeight, authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
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

/**
 * Read an image the agent already downloaded into the project.
 *
 * This is the route that actually closes the Figma loop. The in-canvas agent
 * runs as a Claude CLI subprocess whose MCP servers include the user's own
 * Figma connector, and an image that connector renders INLINE is a picture the
 * model can see but cannot re-emit as bytes — there is no path from it into
 * `imageBase64`. Its asset-DOWNLOAD tool writes real files to disk instead,
 * and the subprocess's cwd is the project, so the file is already somewhere
 * this function can reach. Without this input the agent's only remaining
 * option was to ask the user to attach the PNG by hand.
 *
 * Containment is asserted on the REAL paths, after `realpath`, not on the
 * lexical join: a project can legitimately contain symlinks (`node_modules`
 * most obviously), so a lexically-contained path can still resolve outside the
 * project. An absolute input is accepted rather than rejected — the CLI's cwd
 * is the project root, so its tools naturally hand back absolute paths — but
 * it is subject to exactly the same containment check.
 */
async function readProjectImageBytes(
  dir: string,
  filePath: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const candidate = isAbsolute(filePath) ? filePath : resolvePath(dir, filePath)

  let realRoot: string
  let realTarget: string
  try {
    realRoot = await realpath(dir)
    realTarget = await realpath(candidate)
  } catch {
    return { ok: false, error: `No file at "${filePath}" inside this project. Download the export first, then pass the path it was written to.` }
  }

  try {
    assertPathWithin(realRoot, realTarget)
  } catch {
    return { ok: false, error: `"${filePath}" resolves outside this project. A design reference must be read from a file inside the project directory.` }
  }

  const info = await stat(realTarget)
  if (!info.isFile()) return { ok: false, error: `"${filePath}" is not a file.` }
  if (info.size > DESIGN_REFERENCE_MAX_BYTES) {
    return {
      ok: false,
      error: `"${filePath}" is ${info.size} bytes, over the ${DESIGN_REFERENCE_MAX_BYTES}-byte design-reference limit.`,
    }
  }

  return { ok: true, bytes: new Uint8Array(await readFile(realTarget)) }
}

const registerDesignReferenceTool: AiTool = {
  name: 'studio_register_design_reference',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Durably register a design reference (typically a Figma export) for later measurement — the fix for "a design pasted into chat is a transient, lossy attachment with no handle a tool can address later". Stores the ORIGINAL bytes verbatim (never re-encoded, never downsampled) under .studio/references/ and returns { reference } with a durable id, intrinsic width/height, a content hash, and its byte size. Provide EXACTLY ONE of path (a file already on disk inside this project — USE THIS after a Figma MCP asset-download tool, or anything else that writes an export to disk; it is the reliable route when a connector renders an image inline that you can see but cannot re-emit), url (fetched SERVER-SIDE — when a tool returned a publicly fetchable download URL; note a Figma REST api.figma.com URL is NOT fetchable, it needs a token Studio does not have), or imageBase64 (only when you genuinely hold the bytes). Raster only — PNG/JPEG/GIF/WEBP/AVIF; an SVG is refused outright (no fixed intrinsic pixel size to diff against). Pass pageId to scope this reference to one Studio page (recommended — studio_list_design_references and studio_recommend_export_dpr both filter/require it), plus an optional label and source (e.g. a Figma file/node URL) for anyone reading this back later. Once registered, pair it with studio_recommend_export_dpr and studio_diff_frames\' referenceId input instead of base64-encoding it again on every diff call.',
  inputSchema: StudioRegisterDesignReferenceInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, url, path: filePath, imageBase64, pageId, label, source } = input as {
      dir?: string
      url?: string
      path?: string
      imageBase64?: string
      pageId?: string
      label?: string
      source?: string
    }

    const supplied = [url, filePath, imageBase64].filter((v) => v !== undefined).length
    if (supplied !== 1) {
      return { ok: false, error: 'Provide exactly one of url, path or imageBase64.' }
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
    } else if (filePath !== undefined) {
      const read = await readProjectImageBytes(dir, filePath)
      if (!read.ok) return { ok: false, error: read.error }
      bytes = read.bytes
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
    'Compute the studio_export_frames `dpr` that makes its capture of `pageId`\'s board frame land on `referenceId`\'s registered pixel WIDTH — the dpr-matching alternative to letting studio_diff_frames resample the reference (a resampled score is a weaker claim than a dpr-matched one; see studio_diff_frames\' own description). Uses the frame\'s AUTHORED width from .studio/boards.json (before any dpr scaling), not a live capture — height is content-driven (scroll-unroll can make the real capture taller than the frame\'s nominal height) and cannot be predicted from this alone, so only WIDTH is guaranteed exact when you export at the recommended dpr; verify the actual result via studio_export_frames\' own reported width/height afterward. `dprClamped` is true when the ideal ratio falls outside the tool\'s 0.5–3 range; `exactWidthMatchExpected` is false when either that clamp OR the shared vision-safe edge cap will keep the capture narrower than the reference — in either case, expect studio_diff_frames\' referenceId path to resample rather than get an exact dimension match. `heightLikelyClamped` is a SEPARATE, one-sided warning on the other axis: even the frame\'s NOMINAL authored height (a floor — the real captured height with scroll-unrolled content can only be taller) would already exceed the same vision-safe cap at the recommended dpr, so an exact HEIGHT match is not just unverified but essentially impossible — read `heightNote` for the numbers. A tall mobile screen at dpr 2 hits this routinely; this is the single most common reason a "matched width" comparison still comes back `dimensionMatch: "resampled"`.',
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

    // Height side: a SEPARATE, one-sided check on the other axis the vision-safe
    // cap also applies to (`renderEvidence.ts` clamps BOTH edges, not just the
    // one this tool otherwise reasons about). `authoredFrameHeight` is a FLOOR
    // — scroll-unrolled content can only make the real capture taller, never
    // shorter — so if even that floor clears the cap at `recommendedDpr`, an
    // exact height match is not just unverified, it is already known to be
    // unreachable. Silence (both null here) when no board frame exists for
    // this page at all; that failure mode is `frameWidth === null` above,
    // already handled, so this can only be a fresh, unrelated read.
    const frameHeight = authoredFrameHeight(dir, pageId)
    const rawCapturedHeight = frameHeight === null ? null : frameHeight * recommendedDpr
    const heightLikelyClamped = rawCapturedHeight !== null && rawCapturedHeight > AI_USER_IMAGE_MAX_EDGE
    const heightNote = heightLikelyClamped
      ? `The frame's authored height (${frameHeight}px, a FLOOR — real content may be taller) would already produce a ${Math.round(rawCapturedHeight!)}px-tall capture at dpr ${recommendedDpr}, above the shared ${AI_USER_IMAGE_MAX_EDGE}px vision-safe limit. An exact HEIGHT match is not reachable at any dpr that also keeps the width at its recommended value — expect studio_compare / studio_diff_frames' referenceId path to resample rather than get an exact dimension match, and treat that verdict as directional, not exact-pixel.`
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
      heightLikelyClamped,
      ...(heightNote ? { heightNote } : {}),
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
