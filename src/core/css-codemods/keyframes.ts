/**
 * keyframes — the `@keyframes`-scoped half of the plain-CSS write-back tier
 * (W5-5, animation editing).
 *
 * `setDeclaration` addresses `<selector> { … }` at a file's top level and
 * `setDeclarationAtMedia` addresses the same rule one nesting level down,
 * inside `@media <query>`. Neither can reach a keyframe step: a step lives
 * inside an AT-RULE that is matched by NAME rather than by query, and its own
 * "selector" (`from`, `to`, `50%`) is a keyframe offset, not a CSS selector —
 * `findRule` would happily match the string `50%` but only ever at the scope
 * it was handed, and the at-rule name/params pair has no counterpart in the
 * `@media` matcher. So this module is the third scope, built to
 * `setDeclarationAtMedia`'s shape on purpose: same postcss CST round-trip,
 * same "create the container if it is missing" behaviour, same
 * formatting-preservation guarantee (every byte this codemod did not touch
 * round-trips verbatim through postcss's `raws`).
 *
 * Four functions, each the keyframes-scoped twin of an existing one:
 *
 *   - `readKeyframeSteps`      ← the READ side, which the inspector needs and
 *                                no other codemod provides (a `@keyframes`
 *                                block reaches the editor as an opaque
 *                                `StyleRule.rawCss` string).
 *   - `setDeclarationAtKeyframe`    ← `setDeclarationAtMedia`
 *   - `removeDeclarationAtKeyframe` ← `removeDeclaration`
 *   - `insertKeyframes`             ← `insertRule`, for a WHOLE new block.
 *
 * ## Why `insertRule` could not have done the create
 *
 * `insertRule`'s own doc offers "a new `@keyframes` step" as a use case, and
 * that is half true: it can add a `50% { … }` rule to a container it is given,
 * but its `buildRuleWithDeclarations` parses a literal `<selector> { … }`
 * fragment and THROWS unless the parse yields a `rule` node. `@keyframes fade
 * { … }` parses to an `atrule`, so creating the block itself has never been
 * reachable through it. `insertKeyframes` is that missing branch, written to
 * the same insert-vs-merge discipline: a block with this exact name already in
 * the file is MERGED into (each supplied step's declarations set on the
 * existing step, missing steps appended), never duplicated — two `@keyframes
 * fade` blocks in one file is the same cascade-shadowing hazard
 * `analyzeKeyframesTarget` exists to catch on the read side, and for
 * `@keyframes` it is worse than for a rule: the LAST block wins ENTIRELY
 * rather than merging declaration by declaration.
 *
 * ## Matching, and what is deliberately not matched
 *
 * A `keyframes`-family at-rule is matched by name — `@keyframes` and the
 * `-webkit-`/`-moz-` prefixed spellings alike, since a prefixed block is the
 * same animation and a codemod that silently ignored it would write a second,
 * shadowing definition. `params` (the animation name) is compared exactly,
 * trimmed, matching every other matcher in this module family. The FIRST
 * match in source order is the write target, exactly as `findRule` takes the
 * first selector match; when a file holds more than one,
 * `analyzeKeyframesTarget` refuses BEFORE any of these writers run, the same
 * way `analyzeDeclarationTarget` gates `setDeclaration`.
 *
 * A step is matched by its keyText, normalised only for whitespace and case
 * (`FROM` and `from` are the same step; `0%` and `from` are NOT — they are
 * equivalent to the CSS engine but distinct as authored text, and rewriting
 * one as the other would reformat source this module promises not to touch).
 */
import postcss, { type AtRule, type Root, type Rule } from 'postcss'
import { applyDeclaration } from './setDeclaration'
import type { SetDeclarationResult } from './setDeclaration'
import type { RemoveDeclarationResult } from './removeDeclaration'
import type { InsertRuleResult } from './insertRule'

/** One step of an `@keyframes` block, as authored. */
export interface KeyframeStep {
  /** The offset exactly as written — `from`, `to`, `0%`, or a list like `0%, 100%`. */
  keyText: string
  /** kebab-cased property → value, in source order. */
  declarations: Record<string, string>
}

/** A named, user-readable reason a keyframes write refused — same shape as `DeclarationTargetRefusal`. */
export interface KeyframesTargetRefusal {
  reason: 'duplicate-keyframes'
  message: string
}

export type KeyframesTargetAnalysis = { ok: true } | { ok: false; refusal: KeyframesTargetRefusal }

/** `@keyframes`, `@-webkit-keyframes`, `@-moz-keyframes`, … — see this module's "Matching". */
const KEYFRAMES_AT_RULE_RE = /^(?:-[a-z]+-)?keyframes$/i

/** The same at-rule name family, written as a whole prelude: `@keyframes fade-in`. */
const KEYFRAMES_PRELUDE_RE = /^@(?:-[a-z]+-)?keyframes\s+(.+)$/i

/**
 * The animation name in a `@keyframes fade-in` prelude, or `null` when the
 * text is not one.
 *
 * Studio stores a keyframes block as a `StyleRule` whose `selector` IS that
 * prelude (`siteImport/keyframesToStyleRule.ts`), so this is how both the
 * inspector and the save path get from a rule to the `name` every function
 * above matches on. It lives here, with the matcher it has to agree with,
 * rather than beside either caller — the two would otherwise each own a copy
 * of the vendor-prefix spelling, and a copy that drifts is a copy that writes
 * to the wrong block.
 */
export function keyframesNameFromSelector(selector: string): string | null {
  const match = KEYFRAMES_PRELUDE_RE.exec(selector.trim())
  return match ? match[1]!.trim() : null
}

function isKeyframesAtRule(node: Root['nodes'][number], name: string): node is AtRule {
  return (
    node.type === 'atrule' &&
    KEYFRAMES_AT_RULE_RE.test(node.name) &&
    node.params.trim() === name.trim()
  )
}

/** Every `keyframes`-family at-rule in `root` named `name`, in source order. */
function findKeyframesAtRules(root: Root, name: string): AtRule[] {
  const matches: AtRule[] = []
  root.each((node) => {
    if (isKeyframesAtRule(node, name)) matches.push(node)
  })
  return matches
}

/** Steps are matched case- and whitespace-insensitively; see this module's "Matching". */
function normalizeKeyText(keyText: string): string {
  return keyText.trim().toLowerCase().replace(/\s*,\s*/g, ',')
}

/** The step inside `atRule` whose keyText matches, or `undefined`. */
function findStep(atRule: AtRule, keyText: string): Rule | undefined {
  const target = normalizeKeyText(keyText)
  let found: Rule | undefined
  atRule.each((node) => {
    if (found) return false
    if (node.type === 'rule' && normalizeKeyText(node.selector) === target) {
      found = node
      return false
    }
    return undefined
  })
  return found
}

/**
 * Would a write to `@keyframes <name>` land on exactly one honest target?
 *
 * The `@keyframes`-shaped counterpart of `analyzeDeclarationTarget`, and it
 * needs exactly one rule where that one needs four: a second block with the
 * same name does not merge with the first, it REPLACES it wholesale, so
 * writing the first when a second exists changes the file and changes nothing
 * on screen. Run by the server immediately before any writer below, on the
 * same text it is about to write.
 *
 * A name with NO block yet is `ok` — `setDeclarationAtKeyframe` and
 * `insertKeyframes` both create one at the end of the file, which is
 * unambiguous and cascades last.
 */
export function analyzeKeyframesTarget(cssText: string, name: string): KeyframesTargetAnalysis {
  const root = postcss.parse(cssText)
  const matches = findKeyframesAtRules(root, name)
  if (matches.length <= 1) return { ok: true }
  return {
    ok: false,
    refusal: {
      reason: 'duplicate-keyframes',
      message:
        `This file declares @keyframes ${name} ${matches.length} times. The last one wins entirely, ` +
        'so editing any single block would change the file without changing the animation. ' +
        'Remove the duplicates and Studio can edit it.',
    },
  }
}

/**
 * The steps of `@keyframes <name>` in `cssText`, in source order, or `null`
 * when the file declares no such block.
 *
 * The read side of this module, and the reason it exists at all: a
 * `@keyframes` block reaches the editor as one opaque `StyleRule.rawCss`
 * string (`siteImport/keyframesToStyleRule.ts`), so the inspector has no way
 * to show a step, let alone edit one, without parsing it back. Declarations
 * keep their authored kebab-case names — this is a view of CSS text, not of a
 * `CSSPropertyBag`, and the caller converts if it needs the editor's camelCase
 * convention.
 *
 * A step whose block holds only comments contributes an empty `declarations`
 * rather than being dropped: it is a step the user wrote, and the editor must
 * be able to see it to add the first declaration to it.
 */
export function readKeyframeSteps(cssText: string, name: string): KeyframeStep[] | null {
  let root: Root
  try {
    root = postcss.parse(cssText)
  } catch (_err) {
    // Unparseable text is "no block here", not a crash — the caller is often
    // rendering a panel for CSS that arrived from an arbitrary repository.
    return null
  }
  const atRule = findKeyframesAtRules(root, name)[0]
  if (!atRule) return null

  const steps: KeyframeStep[] = []
  atRule.each((node) => {
    if (node.type !== 'rule') return
    const declarations: Record<string, string> = {}
    node.each((child) => {
      if (child.type === 'decl') declarations[child.prop.trim()] = child.value.trim()
    })
    steps.push({ keyText: node.selector.trim(), declarations })
  })
  return steps
}

/** Build a fresh step node via a literal-fragment parse — `setDeclaration`'s `buildRule` technique, indented one level inside the at-rule. */
function buildStep(keyText: string, declarations: Readonly<Record<string, string>>): Rule {
  const body = Object.entries(declarations)
    .map(([property, value]) => `    ${property}: ${value};`)
    .join('\n')
  const fragment = postcss.parse(`  ${keyText} {\n${body}\n  }`)
  const rule = fragment.first
  if (!rule || rule.type !== 'rule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield a keyframe step')
  }
  return rule
}

/** The literal CSS text of a whole `@keyframes` block — the one reliable way to get correct nested indentation (see `setDeclarationAtMedia`'s note). */
function keyframesFragment(name: string, steps: readonly KeyframeStep[]): string {
  const body = steps
    .map((step) => {
      const decls = Object.entries(step.declarations)
        .map(([property, value]) => `    ${property}: ${value};`)
        .join('\n')
      return `  ${step.keyText} {\n${decls}\n  }`
    })
    .join('\n')
  return `@keyframes ${name} {\n${body}\n}`
}

/** Append a parsed `@keyframes` fragment to `root`, separated from whatever precedes it. */
function appendKeyframes(root: Root, name: string, steps: readonly KeyframeStep[]): void {
  const fragment = postcss.parse(keyframesFragment(name, steps))
  const atRule = fragment.first
  if (!atRule || atRule.type !== 'atrule') {
    throw new Error('[css-codemods] unreachable: parsed fragment did not yield an at-rule node')
  }
  if (root.nodes.length > 0) atRule.raws.before = '\n\n'
  root.append(atRule)
}

/**
 * Set one declaration inside one step of `@keyframes <name>`, creating the
 * step — and the whole block — at the end of the file if either is missing.
 * The exact `setDeclarationAtMedia` contract, one scope over.
 */
export function setDeclarationAtKeyframe(
  cssText: string,
  name: string,
  keyText: string,
  property: string,
  value: string,
): SetDeclarationResult {
  const root: Root = postcss.parse(cssText)
  const atRule = findKeyframesAtRules(root, name)[0]

  if (!atRule) {
    appendKeyframes(root, name, [{ keyText, declarations: { [property]: value } }])
    return { css: root.toString(), changed: true }
  }

  const step = findStep(atRule, keyText)
  if (step) {
    const changed = applyDeclaration(step, property, value)
    return { css: changed ? root.toString() : cssText, changed }
  }

  atRule.append(buildStep(keyText, { [property]: value }))
  return { css: root.toString(), changed: true }
}

/**
 * Remove one declaration from one step of `@keyframes <name>`.
 *
 * Same empty-container cleanup as `removeDeclaration`: a step left with no
 * nodes at all is removed (`50% {}` is dead text), and a block left with no
 * steps goes with it. A step still holding a comment keeps its block, because
 * a comment is a node the user wrote. An already-absent declaration is
 * `changed: false`, never an error — a re-sent removal on a later autosave
 * tick must be a no-op.
 */
export function removeDeclarationAtKeyframe(
  cssText: string,
  name: string,
  keyText: string,
  property: string,
): RemoveDeclarationResult {
  const root: Root = postcss.parse(cssText)
  const atRule = findKeyframesAtRules(root, name)[0]
  if (!atRule) return { css: cssText, changed: false }

  const step = findStep(atRule, keyText)
  if (!step) return { css: cssText, changed: false }

  const propLower = property.toLowerCase()
  let removed = false
  step.each((node) => {
    if (node.type === 'decl' && node.prop.toLowerCase() === propLower) {
      node.remove()
      removed = true
      return false
    }
    return undefined
  })
  if (!removed) return { css: cssText, changed: false }

  if (step.nodes.length === 0) {
    step.remove()
    if ((atRule.nodes?.length ?? 0) === 0) atRule.remove()
  }
  return { css: root.toString(), changed: true }
}

/**
 * Insert (or, for an already-existing block of the same name, merge into) a
 * whole `@keyframes <name>` block. `insertRule`'s contract for the at-rule
 * `insertRule` cannot build — see this module's doc.
 *
 * Merging means: each supplied step's declarations are SET on the matching
 * existing step (via `applyDeclaration`, shared verbatim with `setDeclaration`
 * so the two codemods' notion of "the same declaration" cannot drift), and a
 * step the block does not have yet is appended. Nothing is ever removed — a
 * step the caller did not mention is left exactly as the user wrote it.
 */
export function insertKeyframes(
  cssText: string,
  name: string,
  steps: readonly KeyframeStep[],
): InsertRuleResult {
  const root: Root = postcss.parse(cssText)
  const atRule = findKeyframesAtRules(root, name)[0]

  if (!atRule) {
    appendKeyframes(root, name, steps)
    return { css: root.toString(), changed: true }
  }

  let changed = false
  for (const step of steps) {
    const existing = findStep(atRule, step.keyText)
    if (!existing) {
      atRule.append(buildStep(step.keyText, step.declarations))
      changed = true
      continue
    }
    for (const [property, value] of Object.entries(step.declarations)) {
      if (applyDeclaration(existing, property, value)) changed = true
    }
  }
  return { css: changed ? root.toString() : cssText, changed }
}
