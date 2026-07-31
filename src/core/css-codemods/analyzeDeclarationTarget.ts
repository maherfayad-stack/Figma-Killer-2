/**
 * analyzeDeclarationTarget — the honest-target check that must pass before
 * `setDeclaration` is allowed to touch a user's stylesheet.
 *
 * CLAUDE.md's governing invariant: *"a write must have exactly one honest
 * target. If an edit cannot land in exactly one place in the user's source
 * without destroying a binding or silently changing N call sites, the editor
 * refuses it and says why."*
 *
 * CSS makes that sharp in a way JSX does not. `setDeclaration` writes the
 * FIRST rule in the file whose selector matches — but the CSS cascade makes
 * the LAST declaration win. Those two disagree more often than they look:
 *
 *   - `.hero` declared twice in one file, both setting `color`. The value the
 *     inspector SHOWS came from the second block; writing the first produces
 *     no visible change at all, and the user watches their edit do nothing.
 *   - `padding-top` edited in a rule that also sets the `padding` shorthand
 *     further down. The shorthand resets all four sides after our write, so
 *     again: file changed, canvas unchanged.
 *   - the same, but the shorthand carries `!important`, which wins over a
 *     plain longhand regardless of source order.
 *
 * In every case the write would "succeed" and the user would see nothing. A
 * silent no-op is the single worst outcome available here — worse than
 * refusing, because it teaches the user the tool is broken without telling
 * them what to do instead. So each of these is a REFUSAL carrying a reason a
 * person can read and act on.
 *
 * What is deliberately NOT a refusal:
 *
 *   - A selector matching many elements. That is what a class IS, and the
 *     user picked the Class target knowingly (`StyleTargetChip` shows which
 *     of Element/Class is active). Refusing here would make the class editor
 *     useless.
 *   - The selector not existing in the file yet. `setDeclaration` appends a
 *     fresh rule at the end, which is unambiguous and cascades last — exactly
 *     one honest target.
 *   - The property not existing in an otherwise-matching rule.
 *     `applyDeclaration` appends it at the END of that rule's block, so no
 *     sibling declaration can come after it and override it.
 *
 * Pure: text in, verdict out. No filesystem, no knowledge of which project
 * this is — the same posture as every other function in this module. The
 * caller (`server/handlers/studioCssWriteback.ts`) runs this immediately
 * before `setDeclaration` on the same text it is about to write.
 */
import postcss, { type Declaration, type Root, type Rule } from 'postcss'

/** A named, user-readable reason a CSS write refused. `reason` is the machine tag; `message` is shown verbatim in a toast. */
export interface DeclarationTargetRefusal {
  reason: 'duplicate-selector' | 'duplicate-declaration' | 'shorthand-override' | 'important-override'
  message: string
}

export type DeclarationTargetAnalysis = { ok: true } | { ok: false; refusal: DeclarationTargetRefusal }

/**
 * Which shorthand properties reset which longhands.
 *
 * Not an exhaustive model of the CSS spec, and deliberately so: this table
 * only needs to cover the shorthands that realistically appear in a
 * hand-authored stylesheet alongside a longhand the Studio inspector can
 * emit. A shorthand missing from here degrades to today's behaviour (the
 * write happens) rather than to a wrong write, so an incomplete table is a
 * miss, never a corruption — the same accepted-limitation posture
 * `classifyStylesheetEditability`'s path heuristics take.
 */
const SHORTHAND_COVERAGE: ReadonlyArray<readonly [shorthand: string, covers: RegExp]> = [
  ['margin', /^margin-(top|right|bottom|left)$/],
  ['padding', /^padding-(top|right|bottom|left)$/],
  ['inset', /^(top|right|bottom|left)$/],
  ['gap', /^(row|column)-gap$/],
  ['overflow', /^overflow-(x|y)$/],
  ['background', /^background-[a-z-]+$/],
  ['font', /^font-(family|size|style|weight|variant)$|^line-height$/],
  ['border', /^border-(top|right|bottom|left|width|style|color)(-[a-z]+)?$/],
  ['border-radius', /^border-(top|bottom)-(left|right)-radius$/],
  ['border-width', /^border-(top|right|bottom|left)-width$/],
  ['border-style', /^border-(top|right|bottom|left)-style$/],
  ['border-color', /^border-(top|right|bottom|left)-color$/],
  ['flex', /^flex-(grow|shrink|basis)$/],
  ['flex-flow', /^flex-(direction|wrap)$/],
  ['place-items', /^(align|justify)-items$/],
  ['place-content', /^(align|justify)-content$/],
  ['transition', /^transition-[a-z-]+$/],
  ['animation', /^animation-[a-z-]+$/],
  ['list-style', /^list-style-[a-z-]+$/],
  ['outline', /^outline-[a-z-]+$/],
  ['grid-area', /^grid-(row|column)(-(start|end))?$/],
]

/** True when setting `longhand` would be reset by a declaration of `shorthand`. */
function shorthandCovers(shorthand: string, longhand: string): boolean {
  if (shorthand === longhand) return false
  for (const [name, covers] of SHORTHAND_COVERAGE) {
    if (name === shorthand && covers.test(longhand)) return true
  }
  return false
}

/** Every top-level rule in `root` whose selector matches `selector` exactly, trimmed — the same match rule `setDeclaration` uses. */
function matchingRules(root: Root, selector: string): Rule[] {
  const target = selector.trim()
  const matches: Rule[] = []
  root.each((node) => {
    if (node.type === 'rule' && node.selector.trim() === target) matches.push(node)
  })
  return matches
}

/** A rule's own direct declarations, in source order. Nested at-rules are not the target and are skipped. */
function ownDeclarations(rule: Rule): Declaration[] {
  const decls: Declaration[] = []
  rule.each((node) => {
    if (node.type === 'decl') decls.push(node)
  })
  return decls
}

/**
 * Whether `setDeclaration(cssText, selector, property, …)` would land on
 * exactly one honest target — see this module's doc for what each refusal
 * means and why the non-refusal cases are safe.
 */
export function analyzeDeclarationTarget(cssText: string, selector: string, property: string): DeclarationTargetAnalysis {
  let root: Root
  try {
    root = postcss.parse(cssText)
  } catch {
    // Unparseable CSS: `setDeclaration` would throw on the same input anyway.
    // Reported as a refusal rather than an exception so the user gets a
    // sentence instead of a stack trace in a toast.
    return {
      ok: false,
      refusal: {
        reason: 'duplicate-selector',
        message: `Studio could not parse this stylesheet, so it cannot safely edit ${selector}. Fix the CSS syntax and try again.`,
      },
    }
  }

  const prop = property.toLowerCase()
  const matches = matchingRules(root, selector)
  // No existing rule: `setDeclaration` appends a fresh one at the end of the
  // file, which cascades last and is unambiguous.
  if (matches.length === 0) return { ok: true }

  const target = matches[0]!

  // A LATER block with the same selector that also sets this property (or a
  // shorthand covering it) wins the cascade. `setDeclaration` writes the
  // first, so the edit would be invisible.
  for (const later of matches.slice(1)) {
    for (const decl of ownDeclarations(later)) {
      const declProp = decl.prop.toLowerCase()
      if (declProp === prop || shorthandCovers(declProp, prop)) {
        return {
          ok: false,
          refusal: {
            reason: 'duplicate-selector',
            message:
              `“${selector.trim()}” is declared more than once in this stylesheet, and a later block also sets ` +
              `“${declProp}”. Editing the first block would be overridden by the later one, so Studio will not guess ` +
              `which block you meant — merge the duplicate rules and try again.`,
          },
        }
      }
    }
  }

  const decls = ownDeclarations(target)
  const ownIndexes = decls.map((decl, i) => [decl.prop.toLowerCase(), i] as const).filter(([p]) => p === prop)

  // The same property twice in one block: the last wins, `setDeclaration`
  // writes the first.
  if (ownIndexes.length > 1) {
    return {
      ok: false,
      refusal: {
        reason: 'duplicate-declaration',
        message:
          `“${prop}” is declared more than once inside “${selector.trim()}”. The later declaration is the one taking ` +
          `effect, so editing this rule would change a line that does nothing — remove the duplicate and try again.`,
      },
    }
  }

  // Property absent → appended at the END of the block, where nothing can
  // follow it. Only an EXISTING declaration can be overridden by a sibling.
  const ownIndex = ownIndexes[0]?.[1]
  if (ownIndex === undefined) return { ok: true }

  for (let i = 0; i < decls.length; i += 1) {
    const decl = decls[i]!
    const declProp = decl.prop.toLowerCase()
    if (!shorthandCovers(declProp, prop)) continue
    // `!important` beats a plain longhand from any position; a plain
    // shorthand only beats it from later in the block.
    const beatsByImportance = decl.important && !decls[ownIndex]!.important
    if (!beatsByImportance && i < ownIndex) continue
    return {
      ok: false,
      refusal: {
        reason: beatsByImportance ? 'important-override' : 'shorthand-override',
        message: beatsByImportance
          ? `“${selector.trim()}” sets “${declProp}: … !important”, which overrides “${prop}” however it is written. ` +
            `Edit “${declProp}” instead, or drop the !important.`
          : `“${selector.trim()}” sets the “${declProp}” shorthand after “${prop}”, which resets it. A new “${prop}” ` +
            `value would have no effect — edit “${declProp}” instead.`,
      },
    }
  }

  return { ok: true }
}
