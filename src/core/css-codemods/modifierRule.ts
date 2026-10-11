/**
 * modifierRule — the stylesheet half of a per-instance CLASS override (G-2b).
 *
 * Editing a class-styled value inside ONE instance of a shared component must
 * not rewrite the component's own rule (`.card { padding: 8px }`), which every
 * instance reads. The instance instead gets a modifier class, passed to the
 * component as `className`, and the new value lives in a rule that is exactly
 * one class more specific than the base:
 *
 *     .card { padding: 8px }
 *
 *     .card.card-home-2 { padding: 20px }
 *
 * `.card.card-home-2` beats `.card` wherever the two sit in the file, so the
 * rule needs no particular position to win — it is written right after the
 * base rule only because that is where a reader looks for it. A CSS Module
 * hashes its local class names, so the modifier (a literal the page's
 * `className` prop carries) is spelled `:global(...)` there:
 *
 *     .card:global(.card-home-2) { padding: 20px }
 *
 * The functions are text in, text out, like every codemod in this folder:
 * postcss locates, only the bytes of the new or changed declaration are new.
 * The base rule is never touched. An `atRule` scope writes the modifier inside
 * the same `@media`/`@container`/`@supports` block the edit was made under.
 */
import postcss, { type Container, type Root, type Rule } from 'postcss'
import { findAtRuleBlocks } from './cssAtRuleScope'
import { preservingLineEndings } from './preserveLineEndings'
import { readDeclarationScope, setDeclaration, type DeclarationWriteOptions, type DeclarationWriteRefusal } from './setDeclaration'
import { removeDeclaration } from './removeDeclaration'

/** How the stylesheet spells a class that must reach the DOM under its own name. */
export type ModifierConvention = 'plain' | 'module'

const CLASS_RE = '-?[_a-zA-Z][\\w-]*'
const PLAIN_MODIFIER_RE = new RegExp(`^(\\.${CLASS_RE})\\.(${CLASS_RE})$`)
const MODULE_MODIFIER_RE = new RegExp(`^(\\.${CLASS_RE}):global\\(\\.(${CLASS_RE})\\)$`)

/** `.card` + `card-home-2` → `.card.card-home-2`, or `.card:global(.card-home-2)` in a CSS Module. */
export function modifierSelector(baseSelector: string, token: string, convention: ModifierConvention): string {
  const base = baseSelector.trim()
  return convention === 'module' ? `${base}:global(.${token})` : `${base}.${token}`
}

/**
 * The base selector and the modifier token a selector is made of, when it is
 * exactly `<base>.<token>` or `<base>:global(.<token>)`. Anything else —
 * pseudo-classes, combinators, three classes — is not a modifier rule.
 */
export function parseModifierSelector(selector: string): { base: string; token: string } | null {
  const trimmed = selector.trim()
  const match = PLAIN_MODIFIER_RE.exec(trimmed) ?? MODULE_MODIFIER_RE.exec(trimmed)
  return match ? { base: match[1]!, token: match[2]! } : null
}

/** A single `.class` selector — the only base a modifier is built from. */
export function singleClassName(selector: string): string | null {
  const match = new RegExp(`^\\.(${CLASS_RE})$`).exec(selector.trim())
  return match ? match[1]! : null
}

/** Every class name any selector in the stylesheet mentions — what a fresh modifier name must not collide with. */
export function classNamesInStylesheet(css: string): Set<string> {
  const names = new Set<string>()
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of stripped.matchAll(new RegExp(`\\.(${CLASS_RE})`, 'g'))) names.add(match[1]!)
  return names
}

function matchingRules(containers: readonly Container[], selector: string): Rule[] {
  const target = selector.trim()
  const rules: Rule[] = []
  for (const container of containers) {
    container.each((node) => {
      if (node.type === 'rule' && node.selector.trim() === target) rules.push(node)
    })
  }
  return rules
}

/** Whether any rule at the top level or inside any at-rule block has exactly this selector. */
export function ruleExists(css: string, selector: string): boolean {
  let root: Root
  try {
    root = postcss.parse(css)
  } catch (_err) {
    // An unparseable stylesheet has no rule to find; the writer that follows refuses it by name.
    return false
  }
  const target = selector.trim()
  let found = false
  root.walkRules((rule) => {
    if (rule.selector.trim() === target) {
      found = true
      return false
    }
    return undefined
  })
  return found
}

/** The declarations the rules matching `selector` carry in the given scope, property → value; a later declaration wins. */
export function readRuleDeclarations(css: string, selector: string, options: DeclarationWriteOptions = {}): Record<string, string> {
  const read = readDeclarationScope(css, options)
  if ('refusal' in read) return {}
  const declarations: Record<string, string> = {}
  for (const rule of matchingRules(read.containers, selector)) {
    rule.each((node) => {
      if (node.type === 'decl') declarations[node.prop.toLowerCase()] = node.value
    })
  }
  return declarations
}

export type ModifierWriteResult =
  | { ok: true; css: string; changed: boolean; /** The modifier rule did not exist before this write. */ created: boolean }
  | { ok: false; refusal: DeclarationWriteRefusal }

function ruleFragment(selector: string, declarations: Readonly<Record<string, string>>, indent: string): Rule {
  const body = Object.entries(declarations)
    .map(([property, value]) => `${indent}  ${property}: ${value};`)
    .join('\n')
  const rule = postcss.parse(`${indent}${selector} {\n${body}\n${indent}}`).first
  if (!rule || rule.type !== 'rule') throw new Error('[css-codemods] unreachable: fragment did not yield a rule')
  return rule
}

/**
 * Sets `declarations` on the modifier rule, creating it right after the last
 * base rule in the scope when the stylesheet has none yet (at the end of the
 * scope when the base is not written in it — the block is created if needed).
 * An existing modifier rule is edited declaration by declaration with
 * `setDeclaration`, so a repeated edit of one instance converges on one rule.
 */
export function setModifierDeclarations(
  cssText: string,
  baseSelector: string,
  modifier: string,
  declarations: Readonly<Record<string, string>>,
  options: DeclarationWriteOptions = {},
): ModifierWriteResult {
  const entries = Object.entries(declarations)
  if (entries.length === 0) return { ok: true, css: cssText, changed: false, created: false }

  const read = readDeclarationScope(cssText, options)
  if ('refusal' in read) return { ok: false, refusal: read.refusal }

  if (matchingRules(read.containers, modifier).length > 0) {
    let css = cssText
    let changed = false
    for (const [property, value] of entries) {
      const result = setDeclaration(css, modifier, property, value, options)
      if (!result.ok) return { ok: false, refusal: result.refusal }
      if (result.changed) changed = true
      css = result.css
    }
    return { ok: true, css, changed, created: false }
  }

  let refusal: DeclarationWriteRefusal | null = null
  const rewrite = preservingLineEndings(cssText, (source) => {
    const again = readDeclarationScope(source, options)
    if ('refusal' in again) {
      refusal = again.refusal
      return { css: source, changed: false }
    }
    const bases = matchingRules(again.containers, baseSelector)
    const base = bases[bases.length - 1]
    if (base) {
      const inBlock = base.parent !== undefined && base.parent !== again.root
      const indent = inBlock ? '  ' : ''
      const rule = ruleFragment(modifier, declarations, indent)
      rule.raws.before = `\n\n${indent}`
      base.after(rule)
      return { css: again.root.toString(), changed: true }
    }
    if (again.scope === null) {
      const rule = ruleFragment(modifier, declarations, '')
      if (again.root.nodes.length > 0) rule.raws.before = '\n\n'
      again.root.append(rule)
      return { css: again.root.toString(), changed: true }
    }
    const lastBlock = findAtRuleBlocks(again.root, again.scope).at(-1)
    if (lastBlock) {
      lastBlock.append(ruleFragment(modifier, declarations, '  '))
      return { css: again.root.toString(), changed: true }
    }
    const body = entries.map(([property, value]) => `    ${property}: ${value};`).join('\n')
    const block = postcss.parse(`@${again.scope.name} ${again.scope.params.trim()} {\n  ${modifier} {\n${body}\n  }\n}`).first
    if (!block || block.type !== 'atrule') throw new Error('[css-codemods] unreachable: fragment did not yield an at-rule')
    if (again.root.nodes.length > 0) block.raws.before = '\n\n'
    again.root.append(block)
    return { css: again.root.toString(), changed: true }
  })
  return refusal ? { ok: false, refusal } : { ok: true, ...rewrite, created: true }
}

/** Removes `properties` from the modifier rule; an emptied rule (and an emptied block) goes with them. */
export function removeModifierDeclarations(
  cssText: string,
  modifier: string,
  properties: readonly string[],
  options: DeclarationWriteOptions = {},
): ModifierWriteResult {
  let css = cssText
  let changed = false
  for (const property of properties) {
    const result = removeDeclaration(css, modifier, property, options)
    if (!result.ok) return { ok: false, refusal: result.refusal }
    if (result.changed) changed = true
    css = result.css
  }
  return { ok: true, css, changed, created: false }
}
