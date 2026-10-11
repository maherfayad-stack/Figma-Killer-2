/**
 * classOverridePlan - G-2b: "a class edit made inside a shared component
 * changes ONLY that instance". The pure half: given a class write aimed at an
 * element inside a component instance, decide which of three things it is.
 *
 *   - `direct` - not this module's business: the element is not inside an
 *     instance, or the class has no stylesheet source Studio writes (a
 *     compiled or generated class, a styled template), or the edit is made
 *     under a condition no at-rule can state (a state like `:hover`). The
 *     ordinary class write stays.
 *   - `override` - the element is the root of its component and the class's
 *     rule is a plain class in a stylesheet: the instance gets a modifier class
 *     on its call site and the values go to a rule one class more specific
 *     (`expose-class`). Nobody else's rendering changes.
 *   - `whole-component` - the edit would land in the shared rule and the codemod
 *     cannot give one instance its own: an element inside the component (only
 *     the root takes a class from its call site), a value being cleared. The
 *     ordinary write is kept, and `reason` is the one sentence that says why.
 *
 * Reads only what it is handed; touches nothing. The server stays the authority:
 * it refuses what it cannot prove (a root that does not take `className`, a
 * spread that filters it, a stylesheet it cannot parse) and the caller then
 * falls back to the ordinary write with that sentence.
 */
import { camelToKebabCssProperty } from '@core/css-codemods/browser'
import { inlineDepth, MAX_INSTANCE_OVERRIDE_DEPTH, type PageNode } from '@core/page-tree'
import { coalesceCssSideChanges, type DeclarationChange } from '@site/studio/sideShorthandWrites'

export interface ClassOverrideSource {
  /** The workspace-relative stylesheet the class is written in. */
  file: string
  /** The rule's selector as written there. */
  selector: string
}

export interface ClassOverrideEdit {
  file: string
  selector: string
  /** kebab-case property -> value, side shorthands coalesced (`padding`, not four sides). */
  declarations: Record<string, string>
  atRule?: string
}

export type ClassOverridePlan =
  | { kind: 'direct' }
  | { kind: 'whole-component'; reason: string }
  | { kind: 'override'; edit: ClassOverrideEdit }

export interface ClassOverridePlanInput {
  nodeId: string
  node: PageNode
  /** The instance node (call site) this element is the inlined root of, when the board has one. */
  instance: PageNode | undefined
  /** Where the class's rule is written, when a stylesheet owns it (`getStudioStyleRuleSources()`). */
  source: ClassOverrideSource | undefined
  /** The at-rule the edit's context is written under; `undefined` for the base context, `null` for one no at-rule states. */
  atRule: string | null | undefined
  patch: Readonly<Record<string, string | number | null | undefined>>
}

function everywhere(componentName: string, why: string): string {
  return `${why}, so this changes every ${componentName}.`
}

export function planClassOverride(input: ClassOverridePlanInput): ClassOverridePlan {
  const { nodeId, node, instance, source, atRule, patch } = input
  if (inlineDepth(nodeId) < 1) return { kind: 'direct' }
  if (!source || !/\.css$/i.test(source.file) || atRule === null) return { kind: 'direct' }
  const name = node.fromComponent ?? 'component'

  const changes: DeclarationChange[] = []
  let clearing = false
  for (const [property, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') {
      clearing = true
      continue
    }
    changes.push({ property: camelToKebabCssProperty(property), value: String(value) })
  }
  if (clearing) {
    return { kind: 'whole-component', reason: everywhere(name, `${name} sets that through a class, and removing a value can't be limited to one instance`) }
  }
  if (changes.length === 0) return { kind: 'direct' }
  if (inlineDepth(nodeId) > MAX_INSTANCE_OVERRIDE_DEPTH) {
    return { kind: 'whole-component', reason: everywhere(name, `This sits ${inlineDepth(nodeId)} components deep, and a class is only passed down ${MAX_INSTANCE_OVERRIDE_DEPTH} levels`) }
  }
  // Only the element a component returns takes a class from its call site.
  if (!instance || instance.children.length !== 1 || instance.children[0] !== nodeId) {
    return { kind: 'whole-component', reason: everywhere(name, `This element is styled by a class ${name} shares, and only ${name}'s outermost element can take a class for one instance`) }
  }
  const declarations: Record<string, string> = {}
  for (const change of coalesceCssSideChanges(changes)) {
    if (change.value !== null) declarations[change.property] = change.value
  }
  return { kind: 'override', edit: { file: source.file, selector: source.selector, declarations, ...(atRule !== undefined ? { atRule } : {}) } }
}

/** The refusals the server gives for "cannot give this instance its own class" - the edit then falls back to the ordinary write. */
export const CLASS_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  'class-not-root',
  'class-not-on-element',
  'class-selector-unsupported',
  'class-not-forwarded',
  'class-filtered',
  'call-site-spread',
  'call-site-class',
  'class-prop-elsewhere',
  'class-prop-conflict',
  'class-spread-root',
  'unsupported-class-expression',
  'unsupported-params',
  'unsupported-props-type',
  'not-in-component',
  'unresolvable',
  'package-component',
  'invalid-at-rule',
])

/** Why a class edit the server would not give to one instance is written to the component instead - one sentence. */
export function classRefusalSentence(reason: string, componentName: string): string | null {
  switch (reason) {
    case 'class-not-root':
    case 'class-not-on-element':
    case 'class-selector-unsupported':
      return everywhere(componentName, `That class isn't one ${componentName}'s outermost element carries on its own`)
    case 'class-not-forwarded':
    case 'class-filtered':
      return everywhere(componentName, `A component around ${componentName} doesn't pass the class on`)
    case 'call-site-spread':
    case 'call-site-class':
      return everywhere(componentName, `Some ${componentName} passes a className or spreads props, so adding a class to one of them could change another`)
    case 'class-prop-elsewhere':
    case 'class-prop-conflict':
    case 'class-spread-root':
    case 'unsupported-class-expression':
      return everywhere(componentName, `${componentName} doesn't take a className for its outermost element in a way Studio can extend`)
    case 'unsupported-params':
    case 'unsupported-props-type':
      return everywhere(componentName, `${componentName}'s props are declared in a way Studio can't extend`)
    case 'not-in-component':
    case 'unresolvable':
    case 'package-component':
      return everywhere(componentName, `Studio can't trace this ${componentName} to a component in your source`)
    case 'invalid-at-rule':
      return everywhere(componentName, `That condition can't be written as a rule for one instance`)
    default:
      return null
  }
}
