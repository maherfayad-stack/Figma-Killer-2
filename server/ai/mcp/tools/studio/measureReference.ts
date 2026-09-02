/**
 * `studio_measure_reference` — read the design's own numbers before
 * reproducing it.
 *
 * ## Why this tool exists
 *
 * The harness could already tell the agent WHERE a screen was wrong
 * (`studio_compare` returns the differing rectangles) and WHAT tokens exist
 * (`studio_list_tokens`). It could not tell it what the design actually SAYS.
 * So every value the agent wrote was a guess made by looking at a picture:
 *
 *   - **Colour** by eye, then written as a raw hex — which the prompt forbids
 *     — or as whichever token name sounded right.
 *   - **Type size** by role. A screen title became `--type-headline-size`
 *     because "headline" reads like a heading. On a real project that token
 *     is 26px and the design drew ~21px, so every screen came out too large,
 *     in the same direction, for the same reason. Picking by name is not
 *     merely imprecise, it is BIASED: the grand-sounding token wins.
 *
 * Neither failure is fixable by telling the agent to look harder. `studio_
 * compare` proved that for structure; this is the same argument one level
 * down, for values. Measure, then choose.
 *
 * ## What it returns, and the two things that make it honest
 *
 * **Everything is in CSS px.** A comp exported at 2x holds a 21 CSS px
 * heading as 42 pixels of ink. Returning 42 would replace an eyeballed error
 * with a measured one twice the size. Lengths are scaled by the board frame's
 * authored width over the reference's pixel width before they are reported —
 * so they are directly comparable to the px in a stylesheet.
 *
 * **A font size is a RANGE, not a number.** A raster cannot say whether the
 * ink it measured was cap height (no descender) or a full ascender-to-
 * descender span; those differ by about a third. Both bounds are reported
 * with the assumption each rests on. Line-height, measured from the pitch
 * between two lines, needs no assumption and is reported as a plain number.
 *
 * Measured colours and sizes are matched against the project's OWN custom
 * properties (`projectTokenIndex`), so the answer is a token name where one
 * fits and an explicit "no token covers this" where none does — which is the
 * one case the prompt allows a raw value, and the agent can now tell the two
 * apart.
 *
 * ## The three-way mapping: measured -> design variable -> project token
 *
 * A project-token match alone still leaves a gap: "this fill is 71%
 * different from #0c9ab0" says nothing about whether the DESIGN actually
 * specifies #0c9ab0 or some other coral. When a design-variable table has
 * been ingested (`studio_ingest_design_variables`, sourced from an agent's
 * own call to a design tool's variable API — Figma's `get_variable_defs`
 * being the motivating case), each measured colour/size is ALSO matched
 * against the design's own declared variables (`designVariableIndex.ts`),
 * and — critically — the matched VARIABLE's own value (not the noisy
 * measured pixel) is what gets looked up against the project token index.
 * That turns "this region is 71% different" into "this fill is `coral/100
 * #EF4550` in the design, which is project token `--alm-coral-100`; you used
 * `--color-primary`" — a lookup chain, not a second layer of guessing.
 *
 * This is additive and silent-by-default: when no design-variable table
 * applies to this page/reference, `designVariable` is simply absent from
 * every result, and everything else behaves exactly as it did before this
 * existed — see `MeasureReferenceResult.designVariableIndex.setCount`, the
 * one field that tells a caller whether any table was even consulted.
 *
 * ## Why regions, and not "measure the whole thing"
 *
 * A screen has no single type size or colour. The caller has just LOOKED at
 * the reference (it arrives as an image block from `studio_compare` or
 * `studio_read_design_reference`), so it can point at the heading, the body
 * paragraph, and the primary button — which is the question it actually has.
 * Auto-segmenting the image would answer a different, vaguer question and be
 * wrong more often.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { readDesignReferenceBytes } from '../../../../handlers/studio/designReferenceStore'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { compileProjectStyles } from '../../../../handlers/studio/styleCompile'
import { measureReference, type MeasureRegionInput } from '../../../../handlers/studio/referenceMeasure'
import { resolveApplicableDesignVariableSets } from '../../../../handlers/studio/designVariableStore'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolvePageByName } from './pageNameMatch'
import { cssPxPerReferencePx, resolveDesignReference } from './referenceResolve'

const MAX_REGIONS = 12

const RegionSchema = Type.Object(
  {
    label: Type.Optional(
      Type.String({ description: 'What this rectangle is — "heading", "primary button", "body copy". Echoed back so several regions cannot be mis-paired.' }),
    ),
    x: Type.Integer({ minimum: 0, description: 'Left edge, in the REFERENCE image\'s own pixels (the image you were shown).' }),
    y: Type.Integer({ minimum: 0, description: 'Top edge, in reference pixels.' }),
    width: Type.Integer({ minimum: 1, description: 'Width, in reference pixels.' }),
    height: Type.Integer({ minimum: 1, description: 'Height, in reference pixels.' }),
  },
  { additionalProperties: false },
)

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    page: Type.String({
      minLength: 1,
      description: 'The screen this design is for, named the way you named the file — "Checkout", "Checkout.tsx", or a raw page id. Used to pick the reference and, through that screen\'s board frame, to convert measurements into CSS px.',
    }),
    referenceId: Type.Optional(
      Type.String({ description: 'Which registered design reference to measure. Omit to use the one scoped to this page (or the most recently registered) — which is what you want in the ordinary case.' }),
    ),
    regions: Type.Array(RegionSchema, {
      minItems: 1,
      maxItems: MAX_REGIONS,
      description: 'Rectangles to measure, in reference pixels. Point at the specific things you are about to write CSS for — the heading, the body paragraph, the button fill.',
    }),
  },
  { additionalProperties: false },
)

export const studioMeasureReferenceTool: AiTool = {
  name: 'studio_measure_reference',
  scope: 'shared',
  execution: 'server',
  description:
    'Read the design\'s ACTUAL colours and type sizes out of a registered design reference, instead of guessing them from the picture. Give it the screen name and rectangles in the reference image\'s own pixel coordinates; it returns, per region: the background and foreground colours as hex WITH the matching project token when one is within perceptual range, the WCAG contrast between them, the region\'s dominant palette, the measured text lines, a font-size RANGE, and the measured line-height. Every length is converted to CSS px using that screen\'s board frame width, so a 2x or 3x export does not hand you numbers twice the size you should write. The font size is a range on purpose — a flat image cannot say whether the ink measured was cap height or a full ascender-to-descender span, so both bounds are given with their assumption; line-height, measured from the pitch between two lines, is exact. fontSizePx.caveat is always present and always says the same thing: the range assumes a Latin UI sans face, and is a coarse estimate rather than a real measurement for a serif/display face or a non-Latin script (Arabic included) — trust a design connector\'s own token values over this range whenever both exist. Use this BEFORE writing a stylesheet for a screen that has a design: picking a token because its NAME suits the role ("headline" for a screen title) skews consistently large and is the single most common reason a rebuilt screen looks close but wrong. When no token is within range the response says so — that is the case where a raw value is the honest choice. IMPORTANT: if you have already called studio_ingest_design_variables for this design (e.g. after reading a Figma variable table with get_variable_defs), every colour/size result ALSO carries a designVariable field — the design\'s own declared name/value nearest this measurement, plus the project token resolved from THAT declared value. That is a settled fact, not a range or a guess — prefer it over fontSizePx/token whenever both are present. designVariablesIndexed.setCount in the response tells you whether any table applied at all; 0 means measure by pixel alone, same as before this existed.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, page, referenceId, regions } = input as {
      dir?: string
      page: string
      referenceId?: string
      regions: MeasureRegionInput[]
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

    const cssScale = cssPxPerReferencePx(dir, match.id, reference.width)
    if (cssScale === null) {
      return aiToolError(
        `"${match.title}" has no board frame, so there is no authored width to convert this reference's pixels into CSS px — and an unscaled measurement off a 2x export is exactly as wrong as guessing. Place the screen on the board (studio_set_frames) and call this again.`,
      )
    }

    // The same CSS the canvas gets, so a token this reports is a token that
    // actually cascades — see `projectTokenIndex`'s own doc.
    let cssSources: string[] = []
    try {
      const compiled = await compileProjectStyles(dir, resolveProjectProfile(dir))
      cssSources = [compiled.styles.vendorCss, compiled.styles.css]
    } catch (err) {
      // Token matching degrades to "no tokens"; the raw measurements are still
      // the point and are still correct.
      console.error('[studio_measure_reference] could not compile project styles for token matching:', err)
    }

    // The design's OWN declared values (studio_ingest_design_variables), when
    // any apply to this page/reference — project-wide, page-scoped, and
    // reference-scoped tables all count. `[]` (the ordinary case until an
    // agent ingests one) makes `measureReference`'s `designVariable` fields
    // simply absent below; nothing here changes behaviour for a project that
    // never calls that tool.
    const designVariableSets = resolveApplicableDesignVariableSets(dir, match.id, reference.id)

    const result = await measureReference(bytes, regions, { cssScale, cssSources, designVariableSets })

    return aiToolOk({
      ok: true,
      dir,
      page: { id: match.id, title: match.title },
      reference: {
        id: reference.id,
        ...(reference.label ? { label: reference.label } : {}),
        width: reference.width,
        height: reference.height,
        autoSelected: resolved.implicit,
      },
      // Stated explicitly: a caller that sees 0.5 here knows the reference is
      // a 2x export and that the numbers below have already been halved.
      cssPxPerReferencePx: Math.round(cssScale * 10_000) / 10_000,
      tokensIndexed: result.tokenIndex,
      // `setCount: 0` is the honest "no design-variable table has been
      // ingested for this page/reference" signal — call
      // studio_ingest_design_variables first if the user gave you a design
      // whose variables you can read (e.g. via a connected Figma MCP
      // server's get_variable_defs), then call this again.
      designVariablesIndexed: result.designVariableIndex,
      units: 'All lengths are CSS px, already scaled from reference pixels. fontSizePx is a range: capAssumption is the lower bound (the measured ink is cap height, no descender), ascenderAssumption the upper (the ink spans ascender to descender). fontSizePx.caveat names the range\'s own uncalibrated-for-this-face/script uncertainty — read it before trusting either bound. lineHeightPx is measured from line pitch and needs no assumption. Each colour/size MAY also carry designVariable: the design\'s own declared value nearest this measurement (from studio_ingest_design_variables), plus — resolved from THAT declared value, not from the pixel — the project token it maps to. Absent whenever no applicable table has been ingested (see designVariablesIndexed.setCount) or nothing was close enough.',
      regions: result.regions,
    })
  },
}

export const studioMeasureReferenceMcpTools: AiTool[] = [studioMeasureReferenceTool]
