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
import { aiToolError } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { compileProjectStyles } from '../../../../handlers/studio/styleCompile'
import { buildProjectTokenIndex, type ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { generateVariantSeeds, MAX_VARIANTS_PER_SET } from '../../../../handlers/studio/variantSeeds'
import { getVariantSet, listVariantSets, recordVariantSet } from '../../../../handlers/studio/variantStore'
import { resolveToolProjectDir } from './resolveToolProjectDir'

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
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Turn ONE brief into N genuinely different screens instead of one screen with a different accent colour. Returns a style seed per variant — type contrast, spacing density, corner family, accent — each value taken from a token THIS project already declares, and each axis assigned without replacement so the variants differ structurally rather than by chance. Use it whenever you are about to build a from-scratch screen and the brief has room for more than one idea: a model given the same brief three times returns the same composition three times, because nothing in the second prompt differs from the first; this is where the difference comes from. Each variant comes back with a `pageName` (Home -> HomeA/HomeB/HomeC) and a self-contained `directive` — send that directive VERBATIM as the subagent prompt for that variant, since a subagent sees only the text it is given. This tool PLANS: you still create the pages and place them on the board yourself (that is the orchestrator\'s job under the parallel-work rules, not a subagent\'s), then fan out one subagent per variant. The set is recorded in .studio/variants.json with its seed, so "make B but tighter" is an edit to B\'s recorded density rather than a re-roll that loses everything the user liked — read it back with studio_list_variant_sets. Type contrast never goes below the same 1.6 ratio studio_quality_check\'s flat-type-hierarchy rule grades against, so a seed can never propose a screen its own audit would then fail.',
  inputSchema: PlanInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, baseName, brief, count, rngSeed } = input as {
      dir?: string
      baseName: string
      brief: string
      count?: number
      rngSeed?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    if (!PAGE_BASE_NAME_RE.test(baseName)) {
      return aiToolError(
        `"${baseName}" is not usable as a page base name — it becomes a real .tsx file name, so it must start with a letter and contain only letters and digits (no spaces, dashes, dots or extension). Pass "Home", not "home page" or "Home.tsx".`,
      )
    }

    // The variants' whole point is that every value comes from the project's
    // OWN token space; without the token index there is nothing to vary over,
    // so this degrades to an empty index rather than inventing a palette. The
    // directives then say, per axis, that no token was found.
    let tokens: ProjectTokenIndex = buildProjectTokenIndex()
    try {
      const profile = resolveProjectProfile(dir)
      const compiled = await compileProjectStyles(dir, profile)
      tokens = buildProjectTokenIndex(compiled.styles.vendorCss, compiled.styles.css)
    } catch (err) {
      console.error('[studio_plan_variants] could not resolve the project profile / compile project styles:', err)
    }

    const seed = rngSeed ?? Math.floor(Math.random() * 0x7fffffff)
    const variants = generateVariantSeeds({ tokens, brief, baseName, count: count ?? 3, rngSeed: seed })
    const set = recordVariantSet(dir, { baseName, brief, rngSeed: seed, variants })

    return {
      ok: true,
      dir,
      setId: set.id,
      rngSeed: seed,
      baseName,
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
        return aiToolError(
          known.length > 0
            ? `No variant set "${setId}" is recorded for this project. Recorded sets: ${known.join(', ')}.`
            : `No variant set "${setId}" is recorded for this project, and no set has been recorded at all yet — call studio_plan_variants first.`,
        )
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
