/**
 * The step budget a Studio agent turn works inside, and the one place its
 * number is written down.
 *
 * ## Why it is shared, and why it is here
 *
 * Three surfaces have to agree on the same integer or the control is a lie:
 *
 *   - the **prompt** (`server/ai/tools/studio/systemPrompt.ts`) states the
 *     budget to the model and asks it to report `step k/N` as it goes;
 *   - the **driver loop** caps rounds at it, so a model that ignores the
 *     budget is stopped by arithmetic rather than by hope;
 *   - the **panel** (`AgentActivity`) renders progress against it, so "is it
 *     stuck?" has an answer that is a number.
 *
 * The browser cannot import a server module and the server must not import an
 * admin one, so the constant lives in `@core/ai` — the leaf both already
 * depend on — rather than being copied into each and drifting.
 *
 * ## What the budget is NOT
 *
 * It is not a promise that the turn will take N steps. A model that finishes
 * in three has finished; the budget is a ceiling and a denominator, and the
 * progress line says "3 of 6" from the model's OWN reported plan whenever it
 * reported one, because its plan is a better denominator than the ceiling.
 */

/**
 * The maximum number of tool rounds one turn may take.
 *
 * 40 is well above an honest screen build (a screen is a `Write`, a
 * screenshot, a compare, and a fix pass — under ten) and well below the
 * unbounded loop the ceiling exists to stop. It is stated in the prompt so a
 * model can budget against it rather than discovering it as a truncation.
 */
export const AGENT_TURN_ROUND_BUDGET = 40

/**
 * Where the panel starts showing the round count against the budget.
 *
 * Below this, a count is noise — a turn on step 4 of 40 is simply working.
 * Above it, "will this be cut off?" is a real question and the surface owes
 * the user the number rather than a spinner.
 */
export const AGENT_TURN_ROUND_WARN_AT = Math.floor(AGENT_TURN_ROUND_BUDGET * 0.75)

/** A `step k/N` line the model reported about its own plan. */
export interface AgentTurnStepReport {
  /** `k` — which step it says it is on. */
  readonly index: number
  /** `N` — how many steps it says the plan has. Never below `index`. */
  readonly total: number
}

/**
 * `step 3/6` / `Step 3 of 6` / `step 3 / 6`, anywhere in a chunk of assistant
 * text. The LAST match wins — a turn that reports twice in one chunk is on
 * the later step.
 *
 * Deliberately narrow: a bare "3/6" is not a step report (it is a date, a
 * ratio, a fraction in copy), and only the literal word `step` in front of it
 * makes the claim. Three digits max, so a token count can never be read as a
 * plan.
 */
const STEP_REPORT_RE = /\bstep\s+(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\b/gi

/**
 * The step report in `text`, or `null`.
 *
 * Known limit, stated rather than hidden: text arrives as stream deltas, so a
 * report split across two deltas ("ste" + "p 3/6") is missed. That costs the
 * progress line its nicer denominator for one step and nothing else — the
 * caller falls back to counting tool calls, which is always available.
 */
export function parseTurnStepReport(text: string): AgentTurnStepReport | null {
  let found: AgentTurnStepReport | null = null
  for (const match of text.matchAll(STEP_REPORT_RE)) {
    const index = Number(match[1])
    const total = Number(match[2])
    // A report of "step 7/3" is not a plan, it is a typo; dropping it keeps
    // the line honest instead of rendering a progress bar past its end.
    if (index < 1 || total < 1 || index > total) continue
    found = { index, total }
  }
  return found
}

export interface TurnProgressInput {
  /** The model's own latest `step k/N`, when it reported one. */
  readonly reported: AgentTurnStepReport | null
  /** Tool calls this turn has STARTED — the round count the budget caps. */
  readonly roundsStarted: number
  /** Tool calls this turn has FINISHED, successfully or not. */
  readonly roundsDone: number
}

/**
 * The one-line progress string the panel renders beside the elapsed clock, or
 * `null` when there is nothing yet worth saying (no tool has run and the model
 * has reported no plan — the headline already says "getting started").
 *
 * Reads as "3 of 6" from the model's own plan when it has one, and as
 * "2 of 3 steps done" from the tool ledger when it does not. Past
 * {@link AGENT_TURN_ROUND_WARN_AT} the round count against the budget is
 * appended in either case, because at that point the honest question is not
 * "what is it doing" but "will it get to finish".
 */
export function formatTurnProgress(input: TurnProgressInput): string | null {
  const { reported, roundsStarted, roundsDone } = input
  const nearingCap = roundsStarted >= AGENT_TURN_ROUND_WARN_AT
  const capNote = nearingCap ? ` · ${roundsStarted}/${AGENT_TURN_ROUND_BUDGET} rounds` : ''

  if (reported) return `step ${reported.index} of ${reported.total}${capNote}`
  if (roundsStarted === 0) return null
  return `${roundsDone} of ${roundsStarted} step${roundsStarted === 1 ? '' : 's'} done${capNote}`
}
