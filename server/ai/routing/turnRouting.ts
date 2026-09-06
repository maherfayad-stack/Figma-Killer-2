/**
 * Turn routing — deciding how much reasoning effort ONE turn is worth, from
 * cheap signals, before anything is spent.
 *
 * ## The problem
 *
 * Every turn shipped at the same `--effort` (`claudeCli.ts`'s `DEFAULT_EFFORT`,
 * `'medium'`), whether it was "rebuild the checkout screen from this Figma
 * frame" or "what does that class do?". The second one pays the first one's
 * price, in latency the user is sitting through and in a rate limit they will
 * hit later.
 *
 * ## The two rules that shape everything here
 *
 * **1. An explicit choice is never overridden.** If the user picked an effort
 * in the session controls, that value is used verbatim and this module does not
 * classify at all — it does not even get to agree with them. A router that
 * "improves on" a deliberate setting is a router the user has to fight, and the
 * only defensible way to earn the right to route is to be strictly additive to
 * a default nobody chose.
 *
 * **2. Misclassification is asymmetric, so unsure routes UP.** Under-serving a
 * build turn produces a wrong screen the user has to notice, describe, and pay
 * a full turn to fix. Over-serving a question costs a few seconds. So `'work'`
 * is the default answer and `'question'` has to be positively earned: no
 * attachment, short, no imperative verb, and question-shaped. Everything that
 * is merely AMBIGUOUS is work.
 *
 * ## What this does NOT do: choose a model
 *
 * Effort is routed; the model is not. Not an oversight — the driver surface
 * cannot support it honestly. `req.effort` is `undefined` until the user picks
 * one, which is exactly what makes "pinned vs default" knowable. `req.modelId`
 * has no such tell: the session ALWAYS carries a concrete model id, and nothing
 * on the request distinguishes "the user deliberately chose Opus" from "Opus is
 * what the credential defaulted to". Routing on that signal would silently
 * demote a deliberately-chosen model, which is precisely the failure rule 1
 * exists to prevent. Making model routing possible means recording WHY a model
 * id is set (defaulted vs chosen) on the conversation, and that is a schema
 * change, not a heuristic.
 *
 * Pure and dependency-free on purpose — `turnRouting.test.ts` covers the table.
 */

/** The kind of turn the prompt looks like. Surfaced to the user, so it must describe what was actually acted on. */
export type TurnShape = 'question' | 'smallEdit' | 'build'

/** The effort levels the CLI accepts; routing only ever selects from the cheap end of this scale. */
export type TurnEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface TurnRoutingSignals {
  /** The turn's user prompt text. */
  prompt: string
  /** Images/design references attached to THIS turn. A pasted design is never a question. */
  attachmentCount: number
  /** Files the PREVIOUS turn wrote (`turnWriteLog.ts`). Recent writes make a vague follow-up a review, not a query. */
  previousTurnWriteCount: number
}

export interface TurnRouting {
  /** `'pinned'` — the user's own choice, used verbatim. `'auto'` — classified here. */
  mode: 'pinned' | 'auto'
  effort: TurnEffort
  /** Only present in `'auto'` mode: what the prompt was classified as. */
  shape?: TurnShape
  /** One sentence, shown to the user. Says what was decided and why, never just what. */
  reason: string
}

/**
 * The effort a turn runs at when nobody pinned one. `'medium'` for anything
 * that is not a plain question — deliberately the SAME value the driver used
 * for every turn before routing existed, so the only behaviour change this
 * module can produce is spending LESS. Routing a build turn UP would be a
 * latency and rate-limit regression nobody asked for, and it would be an
 * unreviewable one: there is no measurement here saying `'high'` builds a
 * better screen.
 */
const DEFAULT_TURN_EFFORT: TurnEffort = 'medium'
const QUESTION_EFFORT: TurnEffort = 'low'

/**
 * Above this, a prompt is a brief, not a question — regardless of how it is
 * phrased. Set generously: a genuine question ("why does the header collapse
 * below 480px when the container is flex?") fits comfortably, while a pasted
 * spec does not.
 */
const MAX_QUESTION_CHARS = 320

/** Verbs that produce or restructure files. Any of these and the turn is work, whatever punctuation follows. */
const BUILD_VERBS =
  /\b(build|create|make|implement|design|redesign|rebuild|scaffold|generate|port|migrate|convert|refactor|rewrite|restructure|extract|install|add|write|compose|wire|hook\s+up|set\s+up|apply)\b/i

/** Verbs that adjust something that already exists — real work, but bounded. */
const SMALL_EDIT_VERBS =
  /\b(change|rename|tweak|adjust|nudge|move|swap|replace|increase|decrease|shrink|enlarge|set|fix|correct|remove|delete|hide|show|align|centre|center|bold|tighten|loosen|round|recolou?r|restyle|update)\b/i

/** Interrogative openers, plus a trailing question mark, plus the "explain/what is" family. */
const QUESTION_OPENERS =
  /^(what|why|how|where|which|who|when|is|are|was|were|does|do|did|can|could|should|would|will|any|explain|tell\s+me|describe|remind\s+me)\b/i

/**
 * Words that point AT something rather than naming it. On their own they are
 * nothing; right after a turn that wrote files they mean "the thing you just
 * did", and answering that well requires reading the work back rather than
 * answering from memory.
 */
const REFERS_TO_RECENT_WORK = /\b(this|that|it|these|those|there|still|again|now|the\s+(screen|page|change|edit|file|component))\b/i

function normalise(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ')
}

/**
 * Classify one turn. Pure: same signals, same answer, no clock and no I/O.
 *
 * The order of the checks IS the policy — each one can only push toward more
 * effort, never less, so reading it top to bottom is reading the escalation.
 */
export function classifyTurn(signals: TurnRoutingSignals): { shape: TurnShape; reason: string } {
  const prompt = normalise(signals.prompt)

  if (signals.attachmentCount > 0) {
    return {
      shape: 'build',
      reason: `Attached reference${signals.attachmentCount === 1 ? '' : 's'} — a turn with a design to match is never a plain question.`,
    }
  }
  if (prompt.length > MAX_QUESTION_CHARS) {
    return { shape: 'build', reason: 'Long prompt — read as a brief rather than a question.' }
  }
  if (BUILD_VERBS.test(prompt)) {
    return { shape: 'build', reason: 'Prompt asks for something to be built or restructured.' }
  }

  const questionShaped = prompt.endsWith('?') || QUESTION_OPENERS.test(prompt)
  if (questionShaped && !SMALL_EDIT_VERBS.test(prompt)) {
    // A vague question straight after a turn that wrote files ("is that right?",
    // "does this still work?") is a review of unread work, not a lookup.
    if (signals.previousTurnWriteCount > 0 && REFERS_TO_RECENT_WORK.test(prompt)) {
      return {
        shape: 'smallEdit',
        reason: `Question about the ${signals.previousTurnWriteCount} file${signals.previousTurnWriteCount === 1 ? '' : 's'} just written — answering it means reading the work back.`,
      }
    }
    return { shape: 'question', reason: 'Short, question-shaped, nothing attached, no edit requested.' }
  }
  if (SMALL_EDIT_VERBS.test(prompt)) {
    return { shape: 'smallEdit', reason: 'Prompt adjusts something that already exists.' }
  }
  return { shape: 'build', reason: 'Not clearly a question — routed up, because under-serving a build costs more than over-serving a question.' }
}

const EFFORT_BY_SHAPE: Readonly<Record<TurnShape, TurnEffort>> = {
  question: QUESTION_EFFORT,
  // `smallEdit` and `build` deliberately resolve to the SAME effort today —
  // see `DEFAULT_TURN_EFFORT` for why nothing routes above the old default.
  // The shapes stay distinct because the user is shown which one was picked,
  // and "small edit" and "build" are not the same claim about their prompt.
  smallEdit: DEFAULT_TURN_EFFORT,
  build: DEFAULT_TURN_EFFORT,
}

const EXPLICIT_EFFORTS: ReadonlySet<string> = new Set<TurnEffort>(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * The turn's effort, and how it was arrived at.
 *
 * `requestedEffort` wins outright whenever it is a real level — see rule 1 in
 * the module doc. An unrecognised value is treated as absent rather than
 * rejected: the session control can only produce valid levels, so a bad one
 * means a malformed request, and falling back to routing is strictly better
 * than failing the turn over a field the user never typed.
 */
export function resolveTurnRouting(params: {
  requestedEffort: string | undefined
  signals: TurnRoutingSignals
}): TurnRouting {
  const { requestedEffort, signals } = params
  if (requestedEffort !== undefined && EXPLICIT_EFFORTS.has(requestedEffort)) {
    return {
      mode: 'pinned',
      effort: requestedEffort as TurnEffort,
      reason: `Effort pinned to ${requestedEffort} in this session — auto-routing is off while it is set.`,
    }
  }
  const { shape, reason } = classifyTurn(signals)
  return { mode: 'auto', effort: EFFORT_BY_SHAPE[shape], shape, reason }
}
