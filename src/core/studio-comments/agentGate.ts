/**
 * agentGate — what the agent is allowed to do about a thread, given how much
 * its anchor can still be trusted.
 *
 * The anchoring itself lives in `@core/studio-anchor`, which is deliberately
 * policy-free: it reports a confidence and stops. This file is the policy, and
 * it is the load-bearing half for comments.
 *
 * An agent that acts on a `drifted` or `detached` anchor edits the WRONG
 * ELEMENT in the user's real source — the single worst thing this feature can
 * do, and it would do it silently, in a file the user did not open. So the
 * agent's write tools refuse on `drifted`/`detached` and reply in the thread
 * saying why. Same posture as `refuseStructuralEdit` takes for structural
 * writes: when there is not exactly one honest target, say so instead of
 * guessing.
 */
import type { AnchorConfidence } from '@core/studio-anchor'

/**
 * May the agent act on a thread anchored here — edit the source it points at,
 * then reply and resolve?
 *
 * Only when the anchor still names exactly one element we are sure about. The
 * false-negative direction is the safe one: a wrong refusal costs a round trip,
 * a wrong pass costs an edit to the wrong element.
 */
export function isAgentActionable(confidence: AnchorConfidence): boolean {
  // `unanchored` passes: there is no element that could have gone stale, so
  // the comment is exactly as actionable as it was the day it was written.
  // Folding "never had a target" into "lost its target" made every
  // free-floating pin permanently un-resolvable — a caught regression, not a
  // hypothetical (`commentTools.test.ts` asserts the distinction directly).
  return confidence === 'exact' || confidence === 'moved' || confidence === 'unanchored'
}

/** Why the agent refused — phrased for the reply it posts into the thread. */
export function explainAnchorRefusal(confidence: AnchorConfidence): string | null {
  switch (confidence) {
    case 'exact':
    case 'moved':
    case 'unanchored':
      return null
    case 'drifted':
      return 'The element this comment points at has been edited since the comment was written, so it may no longer describe what is there. Re-check it and comment again if it still applies.'
    case 'detached':
      return 'The element this comment pointed at no longer exists, so there is no single place to apply this change. The comment has been left open.'
  }
}
