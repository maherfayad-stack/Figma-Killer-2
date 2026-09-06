/**
 * styledStyleRuleSources — W4-4 Phase B: `StyleRule.id -> the styled-component
 * TEMPLATE it was flattened out of`.
 *
 * This is the CSS-in-JS counterpart of `studioCss.ts`'s `StyleRuleSource` map,
 * and it exists for the identical reason. A style rule that reached the
 * registry through `extraCss` carries no memory of where it came from — the
 * client sees `.Card_sc__a1b2c3 { color: red }` and nothing else — so without a
 * map like this one, every declaration edit on a styled component is either
 * refused as unmapped (Phase A's behaviour, honest but useless) or written
 * somewhere invented (the bug the whole write-back discipline exists to
 * prevent).
 *
 * ## Why a separate map instead of widening `StyleRuleSource`
 *
 * The two write targets are not the same kind of thing and must never be
 * confused at a call site. A `StyleRuleSource` is a `.css` FILE plus a
 * SELECTOR, written by postcss. A styled source is a `.tsx` FILE plus a
 * `line:col` plus the synthetic CLASS the flattener scoped the template to,
 * written by ts-morph. Every guard downstream — the `.css` extension check,
 * `classifyStylesheetEditability`, `resolveContainedCssPath` — is correct for
 * one and wrong for the other. Two maps, two write paths, no branch that can
 * pick the wrong engine.
 *
 * ## The one-honest-target rule, applied to a class token
 *
 * A rule is mapped only when its selector's class tokens name EXACTLY ONE
 * template. `${Card}:hover &` legitimately flattens to a selector mentioning
 * two synthetic classes, and there is no single template whose text a
 * declaration under it belongs to — so it is left unmapped and presents as
 * read-only, exactly as it did before this feature existed.
 */
import type { CssInJsTemplate } from '@core/page-parser'
import type { StyleRule } from '@core/page-tree'

/**
 * A `StyleRule.id`'s write-back target inside a styled template. `line`/`col`
 * are the 1-based position of the `styled.…`/`css` TAG — `CssInJsTemplate.loc`
 * — which is the anchor `@core/ast-codemods`' `setStyledDeclaration` re-finds
 * the template by, and the same `rel:line:col` shape every other studio edit
 * kind encodes its target as.
 */
export interface StyledStyleRuleSource {
  /** Workspace-relative path of the `.tsx`/`.ts` file the template is written in. */
  file: string
  line: number
  col: number
  /** The synthetic class the template's CSS was flattened under, so the write side rebuilds the same selectors. */
  className: string
  /** The binding the template is assigned to (`Card`), for user-facing messages. */
  componentName: string
}

/** Class tokens in a selector — `.foo`, `.foo:hover`, `.a .b`, `.a.b`. Same shape `studioCss.ts` uses for the CSS-Modules inverse. */
const SELECTOR_CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g

/**
 * Every rule in `styleRules` that came out of one of `templates`, mapped back
 * to it. Rules from a real `.css` file, a Tailwind utility, or a compiled CSS
 * Module mention no synthetic class name and are simply absent — this map is
 * additive to `styleRuleSources`, never a competitor to it.
 */
export function styledStyleRuleSources(
  styleRules: Record<string, StyleRule>,
  templates: readonly CssInJsTemplate[],
): Record<string, StyledStyleRuleSource> {
  if (templates.length === 0) return {}

  const byClassName = new Map<string, StyledStyleRuleSource>()
  for (const template of templates) {
    // Class names are content-addressed (`syntheticClassName` hashes file +
    // binding + position), so the same template arriving once per call site it
    // was inlined at is the same entry — first one wins, and they agree.
    if (byClassName.has(template.className)) continue
    byClassName.set(template.className, {
      file: template.loc.file,
      line: template.loc.line,
      col: template.loc.col,
      className: template.className,
      componentName: template.componentName,
    })
  }

  const sources: Record<string, StyledStyleRuleSource> = {}
  for (const [ruleId, rule] of Object.entries(styleRules)) {
    const matched = new Set<StyledStyleRuleSource>()
    for (const [, className] of rule.selector.matchAll(SELECTOR_CLASS_RE)) {
      const source = byClassName.get(className!)
      if (source) matched.add(source)
    }
    // Zero: an ordinary CSS rule. More than one: a selector written across two
    // templates (`${Card}:hover &`) — no single template owns a declaration
    // under it, so it stays read-only rather than being written into whichever
    // one happened to sort first.
    if (matched.size === 1) sources[ruleId] = [...matched][0]!
  }
  return sources
}
