/**
 * W9-2 fidelity modes — `creative` / `balanced` / `strict`, the one control
 * that says how much of the agent's judgement is allowed and how hard the
 * measurement bites.
 *
 * ## Why one vocabulary, resolved in one function
 *
 * The mode arrives from five independent places, and before this module each
 * place would have grown its own default. That is how a control ends up
 * meaning something different in the prompt than it means in the ruler.
 * Everything that needs a mode calls {@link resolveFidelityMode} with
 * whatever inputs it happens to hold; the ones it does not hold are
 * `undefined` and are skipped. The precedence is therefore identical
 * everywhere even though the callers see different subsets:
 *
 *   1. **tool argument** — `studio_compare({ fidelityMode })`. An explicit
 *      per-call instruction is never overridden. Same rule `turnRouting`
 *      already applies to effort.
 *   2. **per-reference `mode`** — `DesignReference.mode`, set when the design
 *      was registered (PR #48's plumbing). A design that was registered as
 *      "this one has to be exact" says so about ITSELF, and outranks a
 *      session-wide preference, because the session preference was chosen
 *      without this design in view.
 *   3. **per-turn `fidelityMode`** — `AiChatRequestBody.fidelityMode`, the
 *      composer's picker. What the user has selected right now.
 *   4. **per-project default** — `.studio/meta.json`'s
 *      `agentSession.fidelityMode` (per account under `byUser`, same shape
 *      effort uses). Disk JSON. No database anywhere on this path.
 *   5. **derived** — a reference is armed for this project → `balanced`
 *      (there is something to measure, so measure it); none → `creative`
 *      (there is nothing to measure, so refusing to be creative would just
 *      mean refusing to work).
 *
 * ## Why `strict` is never the derived answer
 *
 * The derived tier only ever produces `balanced` or `creative`. `strict`
 * makes the Stop gate refuse everything that is not a measured pass at 99% —
 * arriving there without a user asking for it turns a working session into a
 * loop the user did not opt into. Escalation to strict is always somebody's
 * explicit gesture: a tool argument, a reference registered as strict, the
 * picker, or a project default the user saved. This mirrors
 * `permissionMode`'s rule from the other direction — there the server may
 * never widen on its own; here it may never tighten on its own.
 */

export const FIDELITY_MODES = ['creative', 'balanced', 'strict'] as const
export type FidelityMode = typeof FIDELITY_MODES[number]

/** Which tier of the precedence chain answered. Reported so a surprising verdict is traceable to the thing that chose it, rather than being an unattributable "strict happened". */
export type FidelityModeSource = 'tool-arg' | 'reference' | 'turn' | 'project' | 'derived'

export interface FidelityModeInputs {
  /** An explicit per-call tool argument. Highest precedence, always. */
  readonly toolArg?: FidelityMode
  /** The resolved design reference's own `mode`, when a reference is in hand. */
  readonly reference?: FidelityMode
  /** This turn's `AiChatRequestBody.fidelityMode`. */
  readonly turn?: FidelityMode
  /** `.studio/meta.json`'s persisted per-project (per-account) default. */
  readonly project?: FidelityMode
  /** Whether this project has ANY design reference registered — the only input to the derived tier. */
  readonly referenceArmed?: boolean
}

export interface ResolvedFidelityMode {
  readonly mode: FidelityMode
  readonly source: FidelityModeSource
}

/** The single precedence chain. See the module doc for why each tier sits where it does. */
export function resolveFidelityMode(inputs: FidelityModeInputs): ResolvedFidelityMode {
  if (inputs.toolArg) return { mode: inputs.toolArg, source: 'tool-arg' }
  if (inputs.reference) return { mode: inputs.reference, source: 'reference' }
  if (inputs.turn) return { mode: inputs.turn, source: 'turn' }
  if (inputs.project) return { mode: inputs.project, source: 'project' }
  return { mode: inputs.referenceArmed ? 'balanced' : 'creative', source: 'derived' }
}

/** Narrow an untrusted string (a hand-edited `.studio/meta.json`, a manifest written by an older build) to a mode, or `undefined`. */
export function asFidelityMode(value: unknown): FidelityMode | undefined {
  return typeof value === 'string' && (FIDELITY_MODES as readonly string[]).includes(value)
    ? (value as FidelityMode)
    : undefined
}

export interface FidelityThresholds {
  /** Overall similarity percentage at or above which a page counts toward a pass. */
  readonly passScore: number
  /** The largest share of the frame (percent) any single differing region may cover and still pass. The structural test. */
  readonly maxRegionCoverage: number
  /**
   * The largest AREA, in authored CSS px², any single differing region may
   * cover and still pass — `null` for the modes that do not apply one.
   *
   * This exists because `maxRegionCoverage` is a percentage OF THE FRAME, and
   * a percentage of a tall screen is a large absolute rectangle: on a
   * 375x2400 page, 0.5% of the frame is 4500 px², so a 24x24 icon rendered
   * completely wrong (576 px²) passes the structural test without ever being
   * looked at. Coverage catches "a big thing is wrong"; this catches "a small
   * thing is entirely wrong". Strict needs both.
   *
   * Expressed at 1x and scaled by the comparison's own px-per-CSS-px before
   * it is applied — a 2x Figma export is diffed at 2x, where the same icon is
   * 2304 px², and comparing that against an unscaled 400 would fail every
   * page for the crime of being exported at retina.
   */
  readonly maxRegionPixels: number | null
}

/**
 * What each mode measures. `studio_compare` reads this table; an explicit
 * `passScore`/`maxRegionCoverage` argument still overrides it, because a
 * caller who names a number means that number.
 *
 * - **creative** — directional, not a gate. There may not even be a reference.
 *   A score is still returned so the agent can see whether it is drifting,
 *   but a pass here is not a claim of fidelity and the prompt block says so.
 * - **balanced** — 92 / 6%. Loose enough that a deliberate improvement on the
 *   comp is not reported as a defect; tight enough that a wrong colour, a
 *   missing block, or type two steps off the scale still fails.
 * - **strict** — 99 / 0.5% plus the absolute area floor above. This is the
 *   "no mistakes" setting, and it is meant to be hard to pass.
 *
 * The 98 / 1.5 the tool used before this table is between balanced and
 * strict, and is deliberately not preserved as a fourth setting: it was one
 * number pretending to serve every intent.
 */
export const FIDELITY_THRESHOLDS: Readonly<Record<FidelityMode, FidelityThresholds>> = {
  creative: { passScore: 80, maxRegionCoverage: 12, maxRegionPixels: null },
  balanced: { passScore: 92, maxRegionCoverage: 6, maxRegionPixels: null },
  strict: { passScore: 99, maxRegionCoverage: 0.5, maxRegionPixels: 400 },
}

/**
 * The strict area floor in the pixels the diff actually runs in.
 *
 * `scale` is px-per-authored-CSS-px for the compared image (diff width ÷ the
 * board frame's authored width). Area scales with the square of a linear
 * scale, hence `scale ** 2`. A non-finite or non-positive scale means the
 * frame width is unknown, and an unknown scale must not silently become 1 —
 * that would apply a 1x floor to a 3x diff and fail everything, so the floor
 * is dropped (`null`) and coverage carries the verdict alone.
 */
export function scaledMaxRegionPixels(thresholds: FidelityThresholds, scale: number): number | null {
  if (thresholds.maxRegionPixels === null) return null
  if (!Number.isFinite(scale) || scale <= 0) return null
  return thresholds.maxRegionPixels * scale * scale
}
