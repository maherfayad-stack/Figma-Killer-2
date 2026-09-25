/**
 * `studio_plan_variants` — W9-3's creative half, as a verb.
 *
 * ## What it does, and what it deliberately does NOT do
 *
 * It generates N **style seeds** for one brief (`variantSeeds.ts`), records
 * the set in `.studio/variants.json` (`variantStore.ts`), and returns one
 * self-contained `directive` per variant — the exact text to send to that
 * variant's subagent, plus the page name it owns.
 *
 * It does not create the pages and it does not place them on the board.
 * That is not a shortcut, it is the correct seam: page creation and board
 * geometry are the ORCHESTRATOR's alone under the subagent contract
 * (`docs/features/agent.md` §"No subagents" — every shared file, including
 * `.studio/boards.json`, stays with the parent turn), and the tools for both
 * already exist. A tool that created three pages AND handed out three
 * directives would be doing the orchestrator's job in a place the
 * orchestrator cannot see the result of. Hence `plan`, not `build`: the name
 * says which half it owns.
 *
 * ## Why a tool rather than a prompt paragraph
 *
 * The prompt can ask for three variants (`MODE_BLOCK.creative` does). It
 * cannot make them different: a model given one brief three times returns the
 * same composition three times, because nothing in the second prompt differs
 * from the first. The variance has to be generated outside the model, from
 * the project's own token space, and recorded — which is exactly what a
 * server-resolved tool is for. See `variantSeeds.ts`'s module doc.
 *
 * Server-resolved: reads the project's compiled CSS for its token space, and
 * writes only Studio's own `.studio/variants.json`. It never touches the
 * user's source, never creates a page, and never runs project code — so it
 * carries `studio.write` (it persists project bookkeeping) and nothing
 * stronger.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { buildProjectTokenIndex, type ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { collectProjectTokenCss } from '../../../../handlers/studio/projectTokenSources'
import { generateVariantSeeds, MAX_VARIANTS_PER_SET } from '../../../../handlers/studio/variantSeeds'
import { resolveProjectDesignPolicy } from '../../../../handlers/studio/projectDesignPolicy'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import { getVariantSet, listVariantSets, recordVariantSet } from '../../../../handlers/studio/variantStore'
import type { ArchetypeSurface } from '../../../../handlers/studio/compositionAudit'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { readBoardsFile } from '../../../../handlers/studio/boardFrames'
import { resolveToolProjectDir } from './resolveToolProjectDir'

/** Below this frame width a board is a phone/tablet app, not a web page. */
const APP_FRAME_WIDTH_MAX = 768

/**
 * AI-12 — is this project's screen a web page or a mobile app screen? The
 * project's recorded platform (`.studio/meta.json`, chosen at creation) wins;
 * a project with none (every import) is judged by its board: the median frame
 * width under 768px is an app. No frames at all reads as web, the pool that
 * existed before app bands did.
 */
export function resolveArchetypeSurface(dir: string): ArchetypeSurface {
  const platform = readStudioMeta(dir).platform
  if (platform === 'mobile') return 'app'
  if (platform === 'web') return 'web'
  const widths = readBoardsFile(dir).boards.flatMap((board) => board.frames.map((frame) => frame.width)).filter((w): w is number => typeof w === 'number')
  if (widths.length === 0) return 'web'
  const sorted = [...widths].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]! < APP_FRAME_WIDTH_MAX ? 'app' : 'web'
}

/** Long enough for a real brief, short enough that the whole set stays a few KB on disk and in a tool result. */
const MAX_BRIEF_LENGTH = 4000
/** A page name is a file name — the same conservative identifier shape every Studio page scaffold produces. */
const PAGE_BASE_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/
/** Sets listed by `studio_list_variant_sets` in one call. */
const MAX_SETS_RETURNED = 10

const PlanInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    baseName: Type.String({
      minLength: 1,
      maxLength: 40,
      description: 'The screen name to suffix, in PascalCase and with no extension — "Home" produces the pages HomeA, HomeB, HomeC. Letters and digits only, starting with a letter, because this becomes a real .tsx file name.',
    }),
    brief: Type.String({
      minLength: 1,
      maxLength: MAX_BRIEF_LENGTH,
      description: 'The ONE brief every variant shares, in your own words and complete enough to build from on its own. It is echoed verbatim into each variant\'s directive, and each variant\'s subagent sees only that directive — so "the screen we discussed" produces three different screens for the wrong reason.',
    }),
    count: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: MAX_VARIANTS_PER_SET,
        description: `How many variants. Defaults to 3, which is the number the creative brief asks for: two reads as A-or-B, four is more screens than a person will compare. Maximum ${MAX_VARIANTS_PER_SET}.`,
      }),
    ),
    surface: Type.Optional(
      Type.Union([Type.Literal('web'), Type.Literal('app')], {
        description: 'Plan bands for a web page ("web": hero, feature grid, pricing, …) or a mobile app screen ("app": list rows, form step, order summary, empty state, …). Default: the project\'s platform, else its frame widths.',
      }),
    ),
    rngSeed: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Reproduce a previous set exactly — pass the rngSeed a previous studio_plan_variants call returned. Omit for a fresh set. This is for re-generating the SAME three directions, not for re-rolling until you like one.',
      }),
    ),
  },
  { additionalProperties: false },
)

const planVariantsTool: AiTool = {
  name: 'studio_plan_variants',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  headlessOnly:
    'Nothing in the editor plans variants. The only thing this writes is `.studio/variants.json`, which no panel reads, renders or can create — it exists so a LATER agent turn can edit variant B\'s recorded density instead of re-rolling the set. The editor\'s own equivalent of "try three directions" is the user writing three screens by hand, which produces no seed record at all, so there is no canvas action for this to be parity WITH.',
  requiredCapabilities: ['studio.write'],
  description:
    'Turn ONE brief into N genuinely different screens. Returns a style seed per variant — type contrast, spacing density, corner family, accent, colour strategy and a band sequence from web or app archetypes — every value a token this project declares, each axis drawn without replacement so the variants differ in structure. Use it before a from-scratch screen when the brief allows more than one idea. Each variant has a pageName (Home → HomeA, HomeB, HomeC) and a self-contained directive: build that page from it verbatim, or hand it to a subagent as its whole brief. It only PLANS: create the pages yourself and place them with studio_arrange_frames. The set is recorded in .studio/variants.json, so \'make B tighter\' edits B\'s seed (studio_list_variant_sets), never a re-roll. Type contrast never drops below the 1.6 ratio studio_quality_check grades.',
  inputSchema: PlanInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, baseName, brief, count, rngSeed, surface: surfaceInput } = input as {
      dir?: string
      baseName: string
      brief: string
      count?: number
      rngSeed?: number
      surface?: ArchetypeSurface
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    if (!PAGE_BASE_NAME_RE.test(baseName)) {
      return toolRefusal(
        'invalid-input',
        `"${baseName}" is not usable as a page base name — it becomes a real .tsx file name, so it must start with a letter and contain only letters and digits (no spaces, dashes, dots or extension).`,
        { remedy: 'Pass "Home", not "home page" or "Home.tsx".' },
      )
    }

    // The variants' whole point is that every value comes from the project's
    // OWN token space; without the token index there is nothing to vary over,
    // so this degrades to an empty index rather than inventing a palette. The
    // directives then say, per axis, that no token was found.
    // `collectProjectTokenCss` never throws; it degrades per source.
    const tokens: ProjectTokenIndex = buildProjectTokenIndex(...(await collectProjectTokenCss(dir)))

    const seed = rngSeed ?? Math.floor(Math.random() * 0x7fffffff)
    // A12 — the same policy the prompt block was built from, resolved through
    // the same chain: this turn's value, else the project's persisted default,
    // else `balanced`. Under `free` the seeds draw from an extended pool; under
    // everything else they stay inside the project's own token space.
    const designPolicy = ctx.designPolicy ?? resolveProjectDesignPolicy(dir, studioAgentUserKey(ctx.userId))
    const surface = surfaceInput ?? resolveArchetypeSurface(dir)
    const variants = generateVariantSeeds({ tokens, brief, baseName, count: count ?? 3, rngSeed: seed, designPolicy, surface })
    const set = recordVariantSet(dir, { baseName, brief, rngSeed: seed, variants })

    return {
      ok: true,
      dir,
      setId: set.id,
      rngSeed: seed,
      baseName,
      designPolicy,
      surface,
      variants: set.variants,
      tokensIndexed: { colorCount: tokens.colors.length, sizeCount: tokens.fontSizes.length + tokens.lengths.length },
      note:
        tokens.colors.length === 0 && tokens.fontSizes.length === 0
          ? 'This project\'s token index came back empty, so the seeds carry no token names — every directive says so per axis. Check studio_project_profile for a style-compile warning before treating the seeds as design-system-grounded.'
          : 'Create each page yourself, then send each variant\'s `directive` VERBATIM as that variant\'s subagent prompt. Do not merge the directives into one prompt — one subagent per page is what keeps the file ownership disjoint.',
    }
  },
}

const ListInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio.' }),
    ),
    setId: Type.Optional(
      Type.String({ description: 'Read one recorded set in full by its id (as returned by studio_plan_variants). Omit to list the most recent sets.' }),
    ),
  },
  { additionalProperties: false },
)

const listVariantSetsTool: AiTool = {
  name: 'studio_list_variant_sets',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Read back the variant style seeds recorded for this project by studio_plan_variants. This is what makes "make B but tighter" an EDIT: the set records exactly which accent, corner family, type contrast and density each variant was built to, so you change the one axis the user named and leave the rest of what they liked alone — instead of re-rolling and losing it. Pass setId for one set in full, or omit it for the most recent sets (newest first). Returns { sets[] }, each { id, createdAt, baseName, brief, rngSeed, variants[] }.',
  inputSchema: ListInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, setId } = input as { dir?: string; setId?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)

    if (setId !== undefined) {
      const set = getVariantSet(dir, setId)
      if (!set) {
        const known = listVariantSets(dir).map((s) => `${s.id} (${s.baseName})`).slice(0, MAX_SETS_RETURNED)
        return toolRefusal('no-such-variant-set', `No variant set "${setId}" is recorded for this project.`, {
          remedy: known.length > 0
            ? `Recorded sets: ${known.join(', ')}.`
            : 'No set has been recorded at all yet — call studio_plan_variants first.',
        })
      }
      return { ok: true, dir, sets: [set] }
    }

    const sets = listVariantSets(dir).slice(0, MAX_SETS_RETURNED)
    return {
      ok: true,
      dir,
      sets,
      ...(sets.length === 0
        ? { note: 'No variant sets have been recorded for this project yet — studio_plan_variants creates one.' }
        : {}),
    }
  },
}

export const studioVariantMcpTools: AiTool[] = [planVariantsTool, listVariantSetsTool]
