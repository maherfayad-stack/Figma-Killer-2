/**
 * A12 design policy — `follow` / `balanced` / `free`: how much of the
 * project's design system the agent is required to use.
 *
 * ## Why this is a SECOND axis and not more values on the first
 *
 * `fidelityMode` (`./fidelityMode.ts`) answers "how hard do we measure against
 * a REFERENCE". This answers "how hard do we hold you to the project's own
 * TOKENS AND COMPONENTS". They are genuinely independent, and collapsing them
 * would make two useful positions unreachable:
 *
 *   - `strict` fidelity + `free` policy — reproduce this comp exactly, and
 *     yes, that means raw values the design system does not carry, because
 *     the comp is the spec and the system is not.
 *   - `creative` fidelity + `follow` policy — design something new, entirely
 *     out of this design system's own vocabulary. This is the position the
 *     owner asked for by name ("creative when I say creative, follows the
 *     design system when I say so") and the one a single combined control
 *     could never express.
 *
 * ## The three positions
 *
 *   - **follow** — tokens and `alm.*` / `design-system/` components only. The
 *     token and coverage findings are ERRORS: a raw hex, a raw px, an
 *     off-scale value, a screen that ignored the system, or one that took two
 *     components out of forty-two, all fail.
 *   - **balanced** — the default, and the only value that is never wrong in
 *     either direction. The same findings are WARNINGS: a one-off value is
 *     allowed, and the reply has to say which one and why.
 *   - **free** — the design system is optional. Those findings are OFF, and
 *     the prompt asks for a distinct visual language instead. A `free` turn is
 *     never failed by the Stop gate on a token finding, and `variantSeeds.ts`
 *     draws from an extended pool rather than only the project's declared
 *     tokens.
 *
 * ## What `free` does NOT turn off
 *
 * Contrast (`low-contrast-pair`), a missing font, an unresolved asset import,
 * a hand-drawn `<path>` masquerading as an icon, and the composition rules
 * (`monotone-band-rhythm`, `no-focal-point`, `flat-type-hierarchy`) all still
 * fire at every policy. None of them is a design-system rule — they are
 * "this screen is broken" and "this screen is not designed", and no policy a
 * user can pick makes either acceptable.
 *
 * Precedence mirrors `resolveFidelityMode` exactly, minus the two tiers that
 * have no analogue here (a design reference declares a fidelity for itself; it
 * declares nothing about the project's component library).
 */
import type { QualityFindingCode } from './qualityAudit'

export const DESIGN_POLICIES = ['follow', 'balanced', 'free'] as const
export type DesignPolicy = typeof DESIGN_POLICIES[number]

/**
 * `balanced`, always — the derived tier for a project that has never chosen.
 *
 * Not `follow`: arriving at "every raw value is an error" without a user
 * asking for it turns an ordinary from-scratch screen into a wall of failures
 * on a project whose design system may not even cover the screen. Not `free`
 * either: silently dropping the design-system rules is a loosening the server
 * must never do on its own — the same one-directional rule
 * `resolveFidelityMode` states for `strict`, pointing the other way.
 */
export const DEFAULT_DESIGN_POLICY: DesignPolicy = 'balanced'

/** Which tier of the precedence chain answered. Reported for the same reason `FidelityModeSource` is: a surprising verdict must be traceable to the thing that chose it. */
export type DesignPolicySource = 'tool-arg' | 'turn' | 'project' | 'default'

export interface DesignPolicyInputs {
  /** An explicit per-call tool argument. Highest precedence, always. */
  readonly toolArg?: DesignPolicy
  /** This turn's `AiChatRequestBody.designPolicy` — the composer's picker. */
  readonly turn?: DesignPolicy
  /** `.studio/meta.json`'s persisted per-project (per-account) default. */
  readonly project?: DesignPolicy
}

export interface ResolvedDesignPolicy {
  readonly policy: DesignPolicy
  readonly source: DesignPolicySource
}

/** The single precedence chain. Same shape and same reasoning as `resolveFidelityMode`; see the module doc for the two tiers it deliberately lacks. */
export function resolveDesignPolicy(inputs: DesignPolicyInputs): ResolvedDesignPolicy {
  if (inputs.toolArg) return { policy: inputs.toolArg, source: 'tool-arg' }
  if (inputs.turn) return { policy: inputs.turn, source: 'turn' }
  if (inputs.project) return { policy: inputs.project, source: 'project' }
  return { policy: DEFAULT_DESIGN_POLICY, source: 'default' }
}

/** Narrow an untrusted string (a hand-edited `.studio/meta.json`, an older build's manifest) to a policy, or `undefined`. */
export function asDesignPolicy(value: unknown): DesignPolicy | undefined {
  return typeof value === 'string' && (DESIGN_POLICIES as readonly string[]).includes(value)
    ? (value as DesignPolicy)
    : undefined
}

/**
 * How hard a finding bites. `off` means the finding is not produced at all —
 * not produced-and-hidden, because a finding the tool returns and the caller
 * is told to ignore is exactly the noise that trains an agent to ignore the
 * whole tool.
 */
export type FindingSeverity = 'error' | 'warning' | 'off'

/**
 * The finding codes this policy governs. Everything NOT in this list is
 * severity `error` at every policy and is listed in the module doc's "what
 * `free` does not turn off".
 *
 * `off-scale-spacing` and `off-scale-type-size` are here because they are
 * literally "you left the project's declared scale" — under `free` there is
 * no obligation to be on it. `flat-type-hierarchy` is NOT here: a flat screen
 * is a composition failure regardless of whose scale it used.
 */
export const DESIGN_SYSTEM_FINDING_CODES: readonly QualityFindingCode[] = [
  'raw-hex-color',
  'raw-px-length',
  'off-scale-spacing',
  'off-scale-type-size',
  'design-system-coverage-low',
  'design-system-unused',
]

/** Severity for `code` under `policy`. The one function every caller — the tool, the Stop gate, the prompt block — asks, so a policy can never mean one thing in the grader and another in the gate. */
export function findingSeverity(code: QualityFindingCode, policy: DesignPolicy): FindingSeverity {
  if (!DESIGN_SYSTEM_FINDING_CODES.includes(code)) return 'error'
  if (policy === 'follow') return 'error'
  if (policy === 'balanced') return 'warning'
  return 'off'
}

/**
 * One sentence naming what this policy asks for, for a tool result and a
 * digest line. Short on purpose: the full instruction lives in the prompt
 * block, and repeating it in every tool response would cost a paragraph per
 * call for something the model already read once.
 */
export function describeDesignPolicy(policy: DesignPolicy): string {
  switch (policy) {
    case 'follow':
      return 'follow — tokens and this project\'s own components only; a raw or off-scale value is an error.'
    case 'free':
      return 'free — the design system is optional; design-system findings are not produced at all.'
    default:
      return 'balanced — prefer tokens and components; a one-off value is allowed when your reply says which and why.'
  }
}
