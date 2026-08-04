/**
 * `studio_extract_reference_asset` — cut a picture out of the design and
 * write it into the project as a real file.
 *
 * ## The gap this closes
 *
 * The Studio prompt is explicit that a missing asset is a gap to name, not a
 * drawing prompt: "Hand-writing SVG path data to approximate an icon, or
 * shaping a photo out of CSS gradients and border-radius, produces exactly
 * the specks-and-blobs result that has already failed here twice." That rule
 * is right, and it left the agent with nowhere to go.
 *
 * Look at what was actually reachable. `studio_fetch_remote_asset` needs a
 * URL. `studio_upload_asset` needs bytes the model is holding. A connected
 * Figma MCP server can export the original — if the project has one connected
 * and authenticated. When the design arrived the way designs usually arrive —
 * a PNG pasted into chat — every one of those paths was closed, and the hero
 * image, the product photo, the app-store badge, the phone mockup existed
 * ONLY as pixels inside the reference. The honest move was a grey placeholder
 * box, and that is what the screens got.
 *
 * But the pixels are RIGHT THERE, in a file Studio already stores losslessly.
 * Cropping them is not a fake: it is the actual artwork, at the actual
 * resolution the comp carries, which for a 2x or 3x export is usually enough
 * to ship. It is not a substitute for the original vector when one is
 * reachable — the description says so — but "the real pixels from the comp"
 * beats both a placeholder and a CSS-gradient impersonation of a photograph.
 *
 * ## Why the bytes never transit the model
 *
 * Same posture as `studio_fetch_remote_asset`: the read, the crop, the
 * re-encode, and the write all happen in this process. A model cannot
 * transcribe an image block back into base64, so any design that made the
 * agent carry the bytes would fail — and a 4 MB PNG round-tripping through
 * context would be ruinous even if it worked. The agent hands over a
 * rectangle and gets back a path.
 *
 * ## Why PNG, always
 *
 * The crop is re-encoded rather than copied, because a rectangle of a JPEG is
 * not itself a JPEG. PNG is lossless, so cropping a lossless comp adds no
 * generation loss, and it keeps the alpha channel a WEBP/PNG source may have
 * — which matters for exactly the assets worth cutting out (a logo, a badge,
 * a masked product shot).
 */
import sharp from 'sharp'
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { landAssetBytes } from '../../../../handlers/studio/assetLanding'
import { readDesignReferenceBytes } from '../../../../handlers/studio/designReferenceStore'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolvePageByName } from './pageNameMatch'
import { resolveDesignReference } from './referenceResolve'

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    page: Type.String({
      minLength: 1,
      description: 'The screen this design is for, named the way you named the file — used to pick the reference.',
    }),
    referenceId: Type.Optional(
      Type.String({ description: 'Which registered design reference to cut from. Omit to use the one scoped to this page (or the most recently registered).' }),
    ),
    name: Type.String({
      minLength: 1,
      maxLength: 80,
      description: 'Base filename for the extracted asset, without an extension — "hero-phone", "apple-logo". The written file is always .png.',
    }),
    x: Type.Integer({ minimum: 0, description: 'Left edge of the crop, in the REFERENCE image\'s own pixels (the image you were shown).' }),
    y: Type.Integer({ minimum: 0, description: 'Top edge, in reference pixels.' }),
    width: Type.Integer({ minimum: 1, description: 'Width, in reference pixels.' }),
    height: Type.Integer({ minimum: 1, description: 'Height, in reference pixels.' }),
    targetDir: Type.Optional(
      Type.String({ description: 'Workspace-relative directory to write into. Defaults to the project\'s standard asset directory — omit it unless the project keeps images somewhere else.' }),
    ),
  },
  { additionalProperties: false },
)

export const studioExtractReferenceAssetTool: AiTool = {
  name: 'studio_extract_reference_asset',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Cut a rectangle out of a registered design reference and write it into the project as a real PNG — the way to get a photo, illustration, logo, badge or mockup that exists ONLY inside the design the user gave you. Give it the screen name, a base filename, and the rectangle in the reference image\'s own pixel coordinates; returns { relPath } ready to import, the same shape studio_upload_asset and studio_fetch_remote_asset return. The bytes are read, cropped and written server-side and never pass through you. PREFER a real source when one exists — an icon from the design system\'s own set, an export from a connected Figma MCP server, a URL through studio_fetch_remote_asset — because those give you the original vector at any size, while this gives you the comp\'s raster at whatever resolution it was exported. Use it when none of those are reachable, which is the ordinary case for a design pasted into chat. It is always better than the two things it replaces: a grey placeholder box, and a photograph impersonated with CSS gradients and border-radius. Requires studio.write.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, page, referenceId, name, x, y, width, height, targetDir } = input as {
      dir?: string
      page: string
      referenceId?: string
      name: string
      x: number
      y: number
      width: number
      height: number
      targetDir?: string
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const { pages } = await loadStudioPages(dir)
    const match = resolvePageByName(pages, page)
    if (!match) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(`No screen matched "${page}". This project has: ${known}.`)
    }

    const resolved = resolveDesignReference(dir, match.id, referenceId)
    if (!resolved.ok) return aiToolError(resolved.error)
    const { reference } = resolved

    const bytes = readDesignReferenceBytes(dir, reference)
    if (!bytes) {
      return aiToolError(`Design reference "${reference.id}" is registered but its file could not be read from disk — it may have been removed outside Studio.`)
    }

    // Refused rather than clamped, unlike `studio_measure_reference`. A
    // measurement that is a few pixels out is still a useful measurement; a
    // crop that is silently not the rectangle you asked for is a wrong image
    // written to disk under a name that says it is the right one.
    if (x >= reference.width || y >= reference.height) {
      return aiToolError(
        `The crop starts at (${x}, ${y}), which is outside this ${reference.width}x${reference.height} reference. Coordinates are in the reference image's own pixels.`,
      )
    }
    if (x + width > reference.width || y + height > reference.height) {
      return aiToolError(
        `The crop (${x}, ${y}, ${width}x${height}) runs past the edge of this ${reference.width}x${reference.height} reference. Shrink it to fit — a crop is never silently trimmed, because a file written under the name you chose has to be the rectangle you asked for.`,
      )
    }

    let png: Buffer
    try {
      png = await sharp(Buffer.from(bytes))
        .extract({ left: x, top: y, width, height })
        .png()
        .toBuffer()
    } catch (err) {
      return aiToolError(`Could not crop the reference: ${err instanceof Error ? err.message : String(err)}`)
    }

    const landed = landAssetBytes(dir, targetDir, png, name)
    if (!landed.ok) return aiToolError(landed.error)

    return aiToolOk({
      ok: true,
      dir,
      relPath: landed.relPath,
      width,
      height,
      bytesWritten: png.byteLength,
      reference: { id: reference.id, autoSelected: resolved.implicit },
    })
  },
}

export const studioExtractReferenceAssetMcpTools: AiTool[] = [studioExtractReferenceAssetTool]
