/**
 * variantStyleContext — the VARIANT EDIT CONTEXT (CV-4): given the element a
 * person selected inside a component and the variant values that element is
 * shown with, which ONE rule a style edit must land in — or why none can.
 *
 * Why a context at all. A component's markup is shared by every variant, so an
 * edit made while looking at `<Button variant="ghost">` has three places it
 * could honestly go: the base rule (`.btn`, every variant changes), an inline
 * `style` (every variant changes), or the member's own rule (`.btn-ghost`,
 * only ghost changes). Only the last is what "edit the ghost button" means, and
 * it is the one the cascade rules never pick on their own when the property is
 * set by `.btn` or by nothing. This module decides it from the CV-1 binding the
 * analyzer read off the component's source; the editor then writes it through
 * the same style ladder as any class edit (`setDeclaration`).
 *
 * Pure and browser-safe (no ts-morph, no postcss, no editor store): the server
 * test and the inspector call the same function.
 *
 * ## What lands, per binding
 *
 * | binding | the rule |
 * |---|---|
 * | `css-module-class`, `data-attr` | the rule the analyzer found for the member |
 * | `lookup-object`, `cva` | the stylesheet rule behind the entry's class (`entry.rule`) |
 * | anything else | REFUSED, by name, with a remedy |
 *
 * The refusals are the point: a binding the analyzer cannot prove has no
 * honest rule, and falling back to the base rule would change every variant.
 */
import type { VariantBinding } from './variantSchema'

/** One variant prop of the component, with the member the selected element shows for it. */
export interface VariantAxisInput {
  prop: string
  /** The member shown (`'ghost'`), `'true'` for a boolean that is on; `undefined` when the call site and the default say nothing. */
  member: string | undefined
  binding: VariantBinding | undefined
}

/** The tag-name position of the selected element inside the component's file (the `line:col` tail of its node id). */
export interface ElementTail {
  line: number
  column: number
}

export type VariantStyleRefusalReason = 'opaque-binding' | 'no-rule' | 'no-stylesheet-rule' | 'unsupported-binding'

export interface VariantStyleRule {
  kind: 'rule'
  prop: string
  member: string
  /** The rule's selector as written (`.btn-ghost`, `[data-variant="ghost"]`). */
  selector: string
  /** Workspace-relative POSIX path of the stylesheet. */
  file: string
  /** `Editing variant ghost: .btn-ghost in Button.module.css` */
  label: string
}

export interface VariantStyleRefusal {
  kind: 'refused'
  prop: string
  member: string
  reason: VariantStyleRefusalReason
  /** Names the prop, the member and the line, in one sentence. */
  message: string
  /** What the person can do instead. */
  remedy: string
  /** The component source line to open, when the refusal points at one. */
  openAt?: { file: string; line: number }
}

export type VariantStyleTarget = VariantStyleRule | VariantStyleRefusal

export interface VariantStyleContext {
  /** The axis the edit is aimed at. */
  chosen: VariantStyleTarget
  /** Every axis that styles this element, the chosen one included, in declaration order. */
  axes: ReadonlyArray<VariantStyleTarget>
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function describe(prop: string, member: string): string {
  return member === 'true' ? prop : `${prop} ${member}`
}

function ruleTarget(prop: string, member: string, selector: string, file: string): VariantStyleRule {
  return { kind: 'rule', prop, member, selector, file, label: `Editing ${describe(prop, member)}: ${selector} in ${basename(file)}` }
}

function refusal(
  prop: string,
  member: string,
  reason: VariantStyleRefusalReason,
  message: string,
  remedy: string,
  openAt?: { file: string; line: number },
): VariantStyleRefusal {
  return { kind: 'refused', prop, member, reason, message, remedy, ...(openAt ? { openAt } : {}) }
}

/** The rule (or the named reason there is none) for ONE axis showing ONE member. */
export function variantStyleTargetFor(prop: string, member: string, binding: VariantBinding): VariantStyleTarget {
  const who = describe(prop, member)
  switch (binding.kind) {
    case 'css-module-class': {
      const found = binding.rules.find((rule) => rule.member === member)
      if (found) return ruleTarget(prop, member, found.selector, found.range.file)
      return refusal(
        prop,
        member,
        'no-rule',
        `${who} has no rule in the stylesheet this component imports (it looks for .${binding.classPrefix}${member}${binding.classSuffix}), so there is no ${who}-only place to write.`,
        `Add the rule .${binding.classPrefix}${member}${binding.classSuffix} to the stylesheet, then edit again.`,
      )
    }
    case 'data-attr': {
      const found = binding.rules.find((rule) => rule.member === member)
      if (found) return ruleTarget(prop, member, found.selector, found.range.file)
      return refusal(
        prop,
        member,
        'no-rule',
        `${who} has no [${binding.attr}] rule in the stylesheet this component imports, so there is no ${who}-only place to write.`,
        `Add a [${binding.attr}="${member}"] rule to the stylesheet, then edit again.`,
      )
    }
    case 'lookup-object':
    case 'cva': {
      const entry = binding.entries.find((candidate) => candidate.member === member)
      if (entry?.rule) return ruleTarget(prop, member, entry.rule.selector, entry.rule.range.file)
      const line = entry?.range.line ?? binding.range.line
      const file = entry?.range.file ?? binding.range.file
      return refusal(
        prop,
        member,
        'no-stylesheet-rule',
        `${who} is styled by class names at ${file}:${line} that have no single rule in a stylesheet this component imports (utility classes such as Tailwind's, or shared with other values), and Studio cannot write a declaration into a class list.`,
        `Edit the classes at ${file}:${line} in code, or give ${who} one class that is defined in a stylesheet.`,
        { file, line },
      )
    }
    case 'boolean-class':
      return refusal(
        prop,
        member,
        'unsupported-binding',
        `${who} switches the class "${binding.className}" in code at ${binding.range.file}:${binding.range.line}, and Studio does not look that class up in a stylesheet.`,
        `Edit "${binding.className}" in its stylesheet, or move the styling to a rule per value.`,
        { file: binding.range.file, line: binding.range.line },
      )
    case 'opaque':
      return refusal(
        prop,
        member,
        'opaque-binding',
        `${who} is styled in computed code at ${binding.file}:${binding.line} (${binding.reason}), so an edit cannot be sent to ${who} alone.`,
        `Open ${binding.file}:${binding.line} and edit it there, or restructure it as one rule per value.`,
        { file: binding.file, line: binding.line },
      )
  }
}

/**
 * The context for the element `tail` names, or `null` when no variant prop
 * styles THAT element (an inner icon, a wrapper): the ordinary rules apply.
 *
 * `chosenProp` is the person's pick when several props style the element
 * (`variant` and `size`); without one, the first axis (declaration order)
 * that has a rule wins, so a refusal is never chosen over a place to write.
 */
export function deriveVariantStyleContext(
  tail: ElementTail,
  axes: ReadonlyArray<VariantAxisInput>,
  chosenProp?: string | null,
): VariantStyleContext | null {
  const targets: VariantStyleTarget[] = []
  for (const axis of axes) {
    const { binding, member } = axis
    if (!binding || member === undefined) continue
    const element = binding.element
    if (!element || element.line !== tail.line || element.column !== tail.column) continue
    targets.push(variantStyleTargetFor(axis.prop, member, binding))
  }
  if (targets.length === 0) return null
  const chosen =
    targets.find((target) => target.prop === chosenProp) ?? targets.find((target) => target.kind === 'rule') ?? targets[0]!
  return { chosen, axes: targets }
}
