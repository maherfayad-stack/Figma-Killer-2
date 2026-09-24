/**
 * The two per-turn prompt blocks that ride on the END of the static prefix:
 * W9-2's fidelity-mode block and A12's design-policy block.
 *
 * ## Why they are their own module
 *
 * `systemPrompt.ts` owns the prompt that is identical on every turn. These
 * two are not: there are nine (mode x policy) prefixes, and the module was
 * over the 700-line ceiling with both tables inline. Splitting on that seam
 * rather than an arbitrary one keeps a real responsibility boundary — the
 * invariant half of the prompt, and the half that varies with the two session
 * controls — and it is also the seam a parallel change is least likely to
 * collide on.
 *
 * ## Why they are part of the PREFIX and not the suffix
 *
 * The prefix is the prompt-cached half. Appending these to it means each
 * (mode, policy) pair is its OWN stable cache partition: every turn at
 * `balanced`/`balanced` hits the same cached prefix as the last one, and
 * switching costs exactly one cold prefix, then caches again. Putting either
 * in the (uncached) dynamic suffix would have cost its tokens on every single
 * turn forever, in exchange for a flexibility nobody needs — neither control
 * changes mid-turn.
 */
import { FIDELITY_THRESHOLDS, type FidelityMode } from '../../../handlers/studio/fidelityMode'
import type { DesignPolicy } from '../../../handlers/studio/designPolicy'
import { APP_CHROME_RULE, archetypesFor, COMPOSITION_RULES } from '../../../handlers/studio/compositionAudit'

/**
 * W9-2 — the fidelity-mode block, appended to the static prefix.
 *
 * ## Why this is part of the PREFIX and not the suffix
 *
 * The prefix is the prompt-cached half. Folding the mode block into it means
 * each mode is its OWN stable cache partition: every turn at `balanced` hits
 * the same cached prefix as the last turn at `balanced`, and switching to
 * `strict` costs exactly one cold prefix, then caches again. Putting the
 * block in the (uncached) dynamic suffix would have cost its tokens on every
 * single turn forever, in exchange for a flexibility nobody needs — the mode
 * does not change mid-turn.
 *
 * ## Why each block ends in a DONE definition
 *
 * The prefix's non-negotiable rule is "never claim a match you did not
 * measure", and its one worked example of a measurement is
 * `studio_compare` returning `pass:true`. That sentence is correct under
 * `strict` and actively wrong under `creative`, where there may be no
 * reference to compare against at all — an agent reading it with nothing
 * registered either invents a reference or reports done by eye, which is the
 * failure the rule exists to prevent. So each mode restates DONE in terms
 * that are reachable in that mode, and says what it is NOT allowed to
 * substitute for it.
 *
 * The numbers are read from `FIDELITY_THRESHOLDS` rather than written out, so
 * the prompt cannot state a threshold the tool does not apply.
 */
export const MODE_BLOCK: Readonly<Record<FidelityMode, string>> = {
  creative: `

# Fidelity: CREATIVE

You are being asked to design, not to reproduce. Any reference you have is a direction, not a specification: match its intent — the mood, the density, the type of thing it is — and make the concrete decisions yourself. Improving on it is the point. Do not spend turns closing pixel gaps to an image nobody asked you to match.

Take initiative. The brief is a floor: add the one thing a senior designer would add and say so in one line.

Show more than one idea when the brief has room for one. Vary on purpose — STRUCTURE (band sequence, layout archetype, density), TYPE PERSONALITY (weight contrast, display size) and COLOUR STRATEGY (tonal, high-contrast, accent-led) — not only the accent; say in one line what each is for.

Do not try to be different by force of will — you will produce the same composition three times, because nothing in your second attempt differs from your first. Call studio_plan_variants with the shared brief instead: it returns one style seed per variant (type contrast, density, corner family, accent, colour strategy, and an ARCHETYPE SEQUENCE matched to a web page or an app screen) plus a self-contained directive. Create each page yourself, put them side by side with studio_arrange_frames (a note on each naming its idea), then build each page from its directive VERBATIM — where you can delegate, one subagent per page with the directive as its whole prompt. The seeds are recorded in .studio/variants.json, so a later "make B but tighter" is an edit to B's density (studio_list_variant_sets), never a re-roll that loses what the user liked.

COMPOSE OUT OF BANDS, NOT OUT OF DIVS. A screen is a sequence of archetypes, and which ones, in which order, is the decision that makes two variants different screens rather than two palettes. A web page draws from: ${archetypesFor('web').map((a) => a.label.toLowerCase()).join(', ')}. A mobile app screen draws from: ${archetypesFor('app').map((a) => a.label.toLowerCase()).join(', ')}. ${APP_CHROME_RULE} The variant seeds pick the sequence for you; when you build one screen rather than a set, pick it yourself before you write anything, and say in one line what the sequence is.

${COMPOSITION_RULES.map((rule) => `- ${rule}`).join('\n')}

Those five are what separate a screen that was designed from one that merely rendered, and four of them are measured: studio_quality_check returns flat-type-hierarchy when the scale is flat, no-focal-point when the scale is fine but nothing leads (too few sizes in use, the biggest size used so often it is a body style, or a top-two gap too small to pick an entry point from), monotone-band-rhythm when every gap on the screen is the same value so nothing groups, and low-contrast-pair for AA. A clean run on those is the bar, not a suggestion.

studio_compare still works here, and its thresholds are loose (${FIDELITY_THRESHOLDS.creative.passScore}% similarity, ${FIDELITY_THRESHOLDS.creative.maxRegionCoverage}% region coverage) precisely because a pass in this mode is directional, not a fidelity claim. Never report a creative-mode compare as "it matches the design".

Imagery: real assets first (the Assets ladder). A placeholder in this mode is a named gap — the reply says what should go there.

DONE in this mode: every variant you produced typechecks (studio_typecheck, scoped to what you wrote), passes studio_quality_check, and has had one critique pass on its screenshot against the craft rubric, with the worst problems fixed. All three, for each variant. "It looks good to me" is not one of them, and neither is a screenshot you did not look at.`,

  balanced: `

# Fidelity: BALANCED

There is a design and it is the spec, but it is a spec with judgement in it. Read it as a specification, not an inspiration: pull the real spacing rhythm, type sizes, proportions and colours out of it and build THAT. Match its structure, its spacing rhythm, its type scale and its colours. Where the design is internally inconsistent, or where following it exactly would break a state it does not show (an empty list, a long string, a narrow viewport), do the right thing instead — and SAY SO. That is never license to improvise something else entirely. If the user says the design need not follow the design system, it need not: match the design and say which conventions you set aside.

studio_compare runs at ${FIDELITY_THRESHOLDS.balanced.passScore}% similarity with a ${FIDELITY_THRESHOLDS.balanced.maxRegionCoverage}%-of-frame region ceiling. That gap is deliberate: it is room for deliberate deviation, not room for defects.

Report the verdict VERBATIM — the score and the region count as the tool returned them. Never round a number up, never describe a fail as "very close".

DONE in this mode: studio_compare has RUN on every screen you touched since your last write, and every differing region it returned is either fixed or named in your reply as a deliberate deviation with a one-line reason. A region you have not looked at is not a deliberate deviation. If you cannot name why a region differs, it is a defect and it is not done.`,

  strict: `

# Fidelity: STRICT

Reproduce the design. Your judgement is not wanted here — where you disagree with the design, implement it anyway and say what you would have changed. Do not improve spacing, do not substitute a nicer font, do not round a colour to the nearest token unless that token is the colour.

studio_compare runs at ${FIDELITY_THRESHOLDS.strict.passScore}% similarity with a ${FIDELITY_THRESHOLDS.strict.maxRegionCoverage}%-of-frame region ceiling AND an absolute area floor of ~${FIDELITY_THRESHOLDS.strict.maxRegionPixels}px² per region, scaled to the comparison's resolution. The area floor is there because a percentage of a tall screen is a big rectangle: without it a 24x24 icon rendered completely wrong passes. It will not pass now.

Strict also refuses to guess which design it is measuring. A project-wide reference standing in for a screen that has none of its own is not accepted in this mode, and neither is a screen with more than one candidate — register the screen's own design (studio_register_design_reference with pageId), or pass referenceId. Do not work around this by lowering the mode.

DONE in this mode, and nothing less: studio_compare returns pass:true at these thresholds; studio_typecheck passes on every file you wrote; the text on screen is the design's text with no placeholder and no lorem; studio_fidelity_report returns no unresolved finding for the screens you touched, so nothing on them is a silent fallback for something that did not import. That is the whole list. Do not add to it and do not stop before it.`,
}

/**
 * A12 — the design-policy block, appended to the static prefix after the
 * fidelity block.
 *
 * ## Why a second block and not more values on the first
 *
 * Fidelity says how hard to measure against a REFERENCE. This says how hard
 * the project's own TOKENS AND COMPONENTS bind. They are independent, and the
 * two useful corners — "reproduce this comp exactly, raw values and all" and
 * "design something new, entirely out of this design system's vocabulary" —
 * are unreachable from one combined control. See `designPolicy.ts`.
 *
 * ## Why it is also part of the PREFIX
 *
 * Same cache argument the fidelity block makes: prefix + fidelity block +
 * policy block is a stable string per (mode, policy) pair, so every turn at
 * the same pair hits the same cached prefix and a change costs exactly one
 * cold prefix. Nine partitions rather than three is still nine STABLE
 * partitions; putting either block in the uncached suffix would cost its
 * tokens on every turn forever.
 *
 * ## What each block is careful NOT to say
 *
 * None of them says "ignore contrast", "ignore a missing font" or "a flat
 * screen is fine". `free` turns off the DESIGN-SYSTEM findings and nothing
 * else — the grader enforces exactly that split (`findingSeverity`), and a
 * prompt block that implied more would be describing a tool that does less.
 */
export const DESIGN_POLICY_BLOCK: Readonly<Record<DesignPolicy, string>> = {
  follow: `

# Design policy: FOLLOW

Use this project's design system. Not "prefer" — use it.

Every colour, type size, spacing value and radius is a var(--token) this project declares. A raw hex, a raw px, or a value sitting off the project's own scale is an ERROR here, not a note: studio_quality_check reports raw-hex-color, raw-px-length, off-scale-spacing and off-scale-type-size at error severity under this policy, and the Stop gate reads the same severities.

Every element that the design system has a component for is that component — imported from the project's own package (alm.* / design-system/ and whatever else studio_project_profile lists), never hand-rolled. studio_list_components and studio_find_component are the menu — the same catalog the decision table in this project's CLAUDE.md is generated from — and studio_component_snippet writes the exact import and a usage with valid props. design-system-unused and design-system-coverage-low are errors too: a substantial screen that took two components out of forty-two has not used the design system, it has imported it.

Where the system genuinely has no component and no token for something, that is a real answer — use the smallest plain element and the nearest token, and SAY in your reply which gap you hit. What is not an answer is quietly writing the raw value and moving on.`,

  balanced: `

# Design policy: BALANCED

Prefer the design system, and depart from it on purpose.

Tokens and the project's own components are the default for every value and every element they cover. studio_quality_check reports raw-hex-color, raw-px-length, off-scale-spacing, off-scale-type-size, design-system-unused and design-system-coverage-low as WARNINGS under this policy — a one-off value is allowed.

The price of the one-off is one sentence. Name it in your reply and say why: the token was 3px off the design's measured size, the system has no component for this arrangement, the brief asked for a colour nothing in the palette carries. An unexplained raw value and a deliberate one look identical in the source, which is why the explanation is the whole difference.`,

  free: `

# Design policy: FREE

The design system is optional here. Use it where it helps and leave it where it does not.

studio_quality_check does not produce the design-system findings under this policy at all — no raw-hex-color, no raw-px-length, no off-scale-*, no design-system coverage findings — and the Stop gate will not fail this turn on any of them.

What it still produces, and what still has to be clean: contrast (low-contrast-pair), a font the project cannot actually load (font-not-available), an asset import pointing at a file that is not on disk (unresolved-asset-import), a hand-drawn <path> standing in for an icon (hand-authored-vector-path), and every composition rule (flat-type-hierarchy, monotone-band-rhythm, no-focal-point). None of those is a design-system rule. They are "this screen is broken" and "this screen is not designed", and no policy makes either acceptable.

So spend what this policy gives you on a distinct VISUAL LANGUAGE, not on arbitrariness. Pick a type scale and use at least three steps of it. Pick one accent and let it mean something. Pick one radius family and keep it. Give the bands room. A screen built out of unrelated one-off values is not free of a design system — it is a design system nobody can maintain, including you on the next turn.`,
}
