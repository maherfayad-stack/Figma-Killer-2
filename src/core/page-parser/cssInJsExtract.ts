/**
 * cssInJsExtract — W4-4 Phase A: reads `styled.div\`…\`` /
 * `styled(Card)\`…\`` / emotion `css\`…\`` out of one source file's AST and
 * turns each into a compiled-origin `StyleRule` the canvas can render from.
 *
 * **READ SIDE ONLY.** Nothing here is a writeback target. The CSS produced
 * enters the registry through the same door Tailwind output and compiled CSS
 * Modules already use (`studioCss.ts`'s `extraCss`), which means it gets no
 * `StyleRuleSource` entry — so the CSS write-back's `unmapped` refusal, the
 * panel's "Style not saved to source" chip, and `canvasClassCss.ts`'s
 * `updatedAt === 0` overlay filter all treat it correctly with no new code.
 * Writing an edit BACK into a template is Phase B; see
 * `STUDIO-IMPORT-V2-PLAN.md` WS-3.
 *
 * ## Parse, never execute — where the line falls here
 *
 * A styled template is a tagged template literal, i.e. a function call. This
 * module never calls it. It reads the template's own text, resolves each
 * `${…}` through the SAME bounded evaluator every prop already goes through
 * (Tiers A/B/C — a const, a cross-file theme token, a member chain, a
 * resolvable pure call), and substitutes the resolved text. An interpolation
 * the evaluator declines is replaced by a sentinel and the ONE declaration
 * carrying it is dropped (`cssInJsTemplate.ts`), never the template.
 *
 * A ternary whose condition is not statically decidable gets
 * `branchSelection.ts`'s stated positional rule — the CONSEQUENT is taken and
 * the untaken side is recorded as a finding. That is the same
 * prefer-a-position-never-evaluate-state decision parser-06 documents for
 * JSX, applied to a value. `&&` deliberately does NOT get it: an `&&` in a
 * template is by construction the non-default state (`${p => p.active && css…}`),
 * so painting its right side by default would show a screen no user opens on,
 * where a ternary's consequent is the author's own first-written branch.
 *
 * ## The evaluator budget is this module's own
 *
 * Interpolations are resolved against a FRESH budget per file, never the
 * page's shared `pageBudget`. Two reasons, both load-bearing: adding CSS-in-JS
 * support must not be able to starve the prop/text resolution on the same
 * page, and a result that depends on how much budget happened to be left is
 * exactly the shape `staticEval.ts` documents as uncacheable. With its own
 * budget the result is a pure function of (file, preferredKey) and the
 * per-`SourceFile` memo below is sound — and a truncated one is still never
 * cached.
 *
 * ## Not extracted, on purpose
 *
 * `stitches` (a different API shape — `styled(tag, {objectStyles})`), emotion
 * OBJECT styles and the object form of the `css` prop (Phase C),
 * `vanilla-extract`, `keyframes`/`createGlobalStyle` (they declare a GLOBAL
 * name, not this element's styling — reported, not hoisted), and a theme
 * value reached only through a `ThemeProvider` at runtime (Tier A/B resolves
 * an imported theme object; a `({theme}) => theme.x` param does not resolve
 * and is dropped-and-reported).
 */
import { createHash } from 'node:crypto'
import { Node, type ConditionalExpression, type ImportDeclaration, type SourceFile } from 'ts-morph'
import { resolveExportedDeclaration } from './componentSources'
import { createEvalScope, createPageEvalBudget, evaluateExpression } from './staticEval'
import type { EvalScope, StaticEvalOptions, StaticValue } from './staticEval'
import {
  flattenTemplateCss,
  sentinelDeclaration,
  unresolvedSentinel,
  type TemplateSentinel,
} from './cssInJsTemplate'
import type { CssInJsBase, CssInJsExtraction, CssInJsFinding, CssInJsLibrary, CssInJsTemplate } from './types'

/**
 * Step budget for ONE file's worth of interpolation resolution — see this
 * module's "The evaluator budget is this module's own". Smaller than a page's
 * 20 000 because a template's interpolations are short expressions (a token
 * lookup, a ternary), not a whole i18n dictionary.
 */
const CSS_IN_JS_EVAL_BUDGET = 5000

/** Past this many templates in one file the extraction stops; a file with more is generated, not authored. */
const MAX_TEMPLATES_PER_FILE = 200

/** The import specifiers that make a tagged template a styled template, and what each binding they introduce means. */
const CSS_IN_JS_PACKAGES: Readonly<
  Record<string, { library: CssInJsLibrary; defaultRole?: BindingRole; named?: Readonly<Record<string, BindingRole>> }>
> = {
  'styled-components': { library: 'styled-components', defaultRole: 'styled', named: { styled: 'styled', css: 'css' } },
  'styled-components/macro': { library: 'styled-components', defaultRole: 'styled', named: { styled: 'styled', css: 'css' } },
  '@emotion/styled': { library: 'emotion', defaultRole: 'styled' },
  '@emotion/react': { library: 'emotion', named: { css: 'css' } },
  '@emotion/css': { library: 'emotion', named: { css: 'css' } },
}

type BindingRole = 'styled' | 'css'

/** `.attrs(…)`/`.withConfig(…)` sit between the factory and the template; both are unwrapped, `attrs` with a finding because it can inject props and inline styles this pass does not apply. */
const FACTORY_CHAIN_METHODS: ReadonlySet<string> = new Set(['attrs', 'withConfig'])

/**
 * What one styled binding renders, for the JSX attach step
 * (`cssInJsAttach.ts`). `classNames` is base-first so a
 * `styled(BaseStyled)` chain cascades the way styled-components' own class
 * ordering does.
 */
export interface StyledBinding {
  base: CssInJsBase
  /** Every class this binding puts on the element, base-first. */
  classNames: string[]
  template: CssInJsTemplate
  /**
   * A `css\`…\`` mixin's own already-substituted body text. Present only for
   * `base.kind === 'standalone'`, and it is what makes `${buttonStyles}` splice
   * the mixin's DECLARATIONS into the template that interpolates it — which is
   * what styled-components does — rather than a class selector.
   */
  mixinBody?: string
}

export interface CssInJsFile {
  extraction: CssInJsExtraction
  /** Binding name -> what it renders. Empty for a file with no CSS-in-JS. */
  bindings: ReadonlyMap<string, StyledBinding>
}

export const EMPTY_CSS_IN_JS_FILE: CssInJsFile = { extraction: { templates: [] }, bindings: new Map() }

/** Same "same input, same output, forever" contract `styleRuleId`/`hashLocalClass` hold — an id that churns per load churns selection, undo history and every `classIds` entry. */
function syntheticClassName(componentName: string, relFile: string, line: number, col: number): string {
  const hash = createHash('sha1').update(`${relFile}|${componentName}|${line}|${col}`).digest('hex').slice(0, 6)
  return `${componentName}_sc__${hash}`
}

/**
 * Every CSS-in-JS template in `sourceFile`, plus the binding map the JSX walk
 * needs. Returns `EMPTY_CSS_IN_JS_FILE` — cheaply, without touching the
 * evaluator — for a file that imports none of the recognised packages, which
 * is every file in every project that does not use CSS-in-JS.
 *
 * Never throws (mirrors `parsePageFile`'s contract): any unexpected failure
 * degrades to an empty extraction.
 */
export function extractCssInJs(sourceFile: SourceFile, relFile: string, evalOptions?: StaticEvalOptions): CssInJsFile {
  const cacheKey = evalOptions?.preferredKey ?? ''
  const cached = fileCache.get(sourceFile)?.get(cacheKey)
  if (cached) return cached
  // A file whose template interpolates a mixin from a file that imports back
  // from it would otherwise recurse forever — the memo below only fills in
  // AFTER extraction finishes, so it cannot break the cycle by itself. Same
  // posture as `staticEval.ts`'s `cycle` set: the second entry declines rather
  // than guesses.
  if (inFlight.has(sourceFile)) return EMPTY_CSS_IN_JS_FILE

  const budget = createPageEvalBudget(CSS_IN_JS_EVAL_BUDGET)
  let result: CssInJsFile
  inFlight.add(sourceFile)
  try {
    const roles = importedRoles(sourceFile)
    if (roles.size === 0) return EMPTY_CSS_IN_JS_FILE
    result = extractFile(sourceFile, relFile, roles, { ...evalOptions, pageBudget: budget })
  } catch (err) {
    console.error('[cssInJsExtract]', err)
    return EMPTY_CSS_IN_JS_FILE
  } finally {
    inFlight.delete(sourceFile)
  }

  // A guard-truncated result describes the budget that happened to be left,
  // not the code — the same rule `staticEval.ts`'s memo enforces. Caching one
  // would let "which file was parsed first" decide whether any copy resolved.
  if (budget.remaining > 0) {
    let byKey = fileCache.get(sourceFile)
    if (!byKey) {
      byKey = new Map()
      fileCache.set(sourceFile, byKey)
    }
    byKey.set(cacheKey, result)
  }
  return result
}

const fileCache = new WeakMap<SourceFile, Map<string, CssInJsFile>>()

/** Files currently being extracted — see `extractCssInJs`'s cycle guard. */
const inFlight = new Set<SourceFile>()

/** Local binding name -> what importing it means, for the packages in `CSS_IN_JS_PACKAGES`. */
function importedRoles(sourceFile: SourceFile): Map<string, { role: BindingRole; library: CssInJsLibrary }> {
  const roles = new Map<string, { role: BindingRole; library: CssInJsLibrary }>()
  for (const declaration of sourceFile.getImportDeclarations()) {
    const pkg = CSS_IN_JS_PACKAGES[declaration.getModuleSpecifierValue()]
    if (!pkg) continue

    const defaultImport = declaration.getDefaultImport()
    if (defaultImport && pkg.defaultRole) roles.set(defaultImport.getText(), { role: pkg.defaultRole, library: pkg.library })

    for (const named of declaration.getNamedImports()) {
      const role = pkg.named?.[named.getNameNode().getText()]
      if (!role) continue
      roles.set(named.getAliasNode()?.getText() ?? named.getNameNode().getText(), { role, library: pkg.library })
    }
  }
  return roles
}

/** Everything one file's extraction needs to thread through, so the helpers below stay parameter-light. */
interface ExtractState {
  sourceFile: SourceFile
  relFile: string
  scope: EvalScope
  evalOptions: StaticEvalOptions
  roles: ReadonlyMap<string, { role: BindingRole; library: CssInJsLibrary }>
  bindings: Map<string, StyledBinding>
  templates: CssInJsTemplate[]
  /** `${sharedMixin}` where the mixin lives in ANOTHER file — resolved through the same import walk the JSX attach step uses. Built on first use. */
  importedBinding(name: string): StyledBinding | undefined
}

function extractFile(
  sourceFile: SourceFile,
  relFile: string,
  roles: ReadonlyMap<string, { role: BindingRole; library: CssInJsLibrary }>,
  evalOptions: StaticEvalOptions,
): CssInJsFile {
  const state: ExtractState = {
    sourceFile,
    relFile,
    // Module scope only: a styled definition sits at module scope by
    // construction (it is a component identity, not a value computed per
    // render), so there is no component body whose locals could be in scope.
    scope: createEvalScope(sourceFile),
    evalOptions,
    roles,
    bindings: new Map(),
    templates: [],
    importedBinding: importedBindingLookup(sourceFile, relFile, evalOptions),
  }

  // Source order matters: `styled(Card)` can only chain onto a `Card` already
  // declared above it, which is also the only order JS itself allows.
  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (state.templates.length >= MAX_TEMPLATES_PER_FILE) break
    const initializer = declaration.getInitializer()
    if (!initializer || !Node.isTaggedTemplateExpression(initializer)) continue
    const name = declaration.getName()
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
    extractOne(name, initializer, state)
  }

  return { extraction: { templates: state.templates }, bindings: state.bindings }
}

/** The `styled.x` / `styled(X)` / `css` classification, with `.attrs(…)`/`.withConfig(…)` unwrapped. */
function classifyTag(
  tag: Node,
  state: ExtractState,
  findings: CssInJsFinding[],
): { base: CssInJsBase; library: CssInJsLibrary; inheritedClasses: string[] } | undefined {
  let current = tag
  // Unwrap `styled.div.attrs({…})` / `styled(X).withConfig({…})` chains.
  for (let hops = 0; hops < 4 && Node.isCallExpression(current); hops++) {
    const callee = current.getExpression()
    if (!Node.isPropertyAccessExpression(callee) || !FACTORY_CHAIN_METHODS.has(callee.getName())) break
    if (callee.getName() === 'attrs') {
      findings.push({
        kind: 'attrs-ignored',
        message: '`.attrs(…)` is not applied — it can inject props and inline styles this pass does not read.',
      })
    }
    current = callee.getExpression()
  }

  if (Node.isPropertyAccessExpression(current)) {
    const object = current.getExpression()
    const role = Node.isIdentifier(object) ? state.roles.get(object.getText()) : undefined
    if (role?.role !== 'styled') return undefined
    return { base: { kind: 'tag', tag: current.getName() }, library: role.library, inheritedClasses: [] }
  }

  if (Node.isCallExpression(current)) {
    const callee = current.getExpression()
    const role = Node.isIdentifier(callee) ? state.roles.get(callee.getText()) : undefined
    if (role?.role !== 'styled') return undefined
    const argument = current.getArguments()[0]
    if (!argument) return undefined
    // `styled('div')` — the string form of `styled.div`.
    if (Node.isStringLiteral(argument)) {
      return { base: { kind: 'tag', tag: argument.getLiteralValue() }, library: role.library, inheritedClasses: [] }
    }
    if (!Node.isIdentifier(argument)) return undefined
    const wrapped = state.bindings.get(argument.getText())
    // `styled(AlreadyStyled)` — styled-components renders the SAME host tag
    // with BOTH classes, so chaining is the faithful answer, not an
    // approximation.
    if (wrapped && wrapped.base.kind === 'tag') {
      return { base: wrapped.base, library: role.library, inheritedClasses: [...wrapped.classNames] }
    }
    findings.push({
      kind: 'wraps-component',
      expression: argument.getText(),
      message: `Wraps <${argument.getText()}/>, so the class lands on whatever that component renders — the CSS is registered, but which element it styles is decided in that component's own file.`,
    })
    return { base: { kind: 'component', name: argument.getText() }, library: role.library, inheritedClasses: [] }
  }

  if (Node.isIdentifier(current)) {
    const role = state.roles.get(current.getText())
    if (role?.role !== 'css') return undefined
    return { base: { kind: 'standalone' }, library: role.library, inheritedClasses: [] }
  }

  return undefined
}

function extractOne(componentName: string, tagged: Node, state: ExtractState): void {
  if (!Node.isTaggedTemplateExpression(tagged)) return
  const findings: CssInJsFinding[] = []
  const classified = classifyTag(tagged.getTag(), state, findings)
  if (!classified) return

  const tagNode = tagged.getTag()
  const { line, column } = state.sourceFile.getLineAndColumnAtPos(tagNode.getStart())
  const className = syntheticClassName(componentName, state.relFile, line, column)

  const substituted = substituteTemplate(tagged, state, findings)
  if (!substituted) return

  const flattened = flattenTemplateCss(className, substituted.body, substituted.sentinels)
  findings.push(...flattened.findings)

  const template: CssInJsTemplate = {
    componentName,
    className,
    base: classified.base,
    library: classified.library,
    loc: { file: state.relFile, line, col: column },
    status: flattened.declarationCount === 0 ? 'unresolvable' : findings.length === 0 ? 'clean' : 'partial',
    findings,
    declarationCount: flattened.declarationCount,
    css: flattened.css,
  }
  state.templates.push(template)
  state.bindings.set(componentName, {
    base: classified.base,
    classNames: [...classified.inheritedClasses, className],
    template,
    ...(classified.base.kind === 'standalone' ? { mixinBody: substituted.body } : {}),
  })
}

/** The template's text with every `${…}` resolved, plus one `TemplateSentinel` per interpolation that was not. */
function substituteTemplate(
  tagged: Node,
  state: ExtractState,
  findings: CssInJsFinding[],
): { body: string; sentinels: TemplateSentinel[] } | undefined {
  if (!Node.isTaggedTemplateExpression(tagged)) return undefined
  const template = tagged.getTemplate()
  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    return { body: template.getLiteralValue(), sentinels: [] }
  }
  if (!Node.isTemplateExpression(template)) return undefined

  const sentinels: TemplateSentinel[] = []
  let body = template.getHead().getLiteralText()

  for (const span of template.getTemplateSpans()) {
    const expression = span.getExpression()
    const literal = span.getLiteral().getLiteralText()
    const resolved = resolveInterpolation(expression, state, findings)
    if (resolved !== undefined) {
      body += resolved
    } else {
      const block = isStatementPosition(body)
      sentinels.push({ expression: shortenExpression(expression.getText()), block })
      body += block ? sentinelDeclaration(sentinels.length - 1) : unresolvedSentinel(sentinels.length - 1)
    }
    body += literal
  }

  return { body, sentinels }
}

/**
 * True when the next thing written would start a STATEMENT rather than
 * continue a declaration's value — i.e. nothing since the last `;`/`{`/`}`
 * has opened a property with a `:`. That is the `${sharedMixin}` shape, and it
 * needs a whole valid declaration substituted rather than a bare word, or
 * postcss rejects the entire template.
 */
function isStatementPosition(textSoFar: string): boolean {
  let segment = textSoFar
  for (const delimiter of [';', '{', '}']) {
    const index = segment.lastIndexOf(delimiter)
    if (index >= 0) segment = segment.slice(index + 1)
  }
  return !segment.includes(':')
}

/** Long enough to identify the interpolation in the source, short enough for a finding message and a toast. */
function shortenExpression(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat
}

/**
 * One `${…}` -> the text to splice in, or `undefined` when the evaluator
 * cannot read it. See this module's doc comment for the tier boundary and the
 * ternary rule.
 */
function resolveInterpolation(expression: Node, state: ExtractState, findings: CssInJsFinding[]): string | undefined {
  // A reference to another binding in this same file, resolved from what this
  // module already extracted rather than through the evaluator (which has no
  // notion of either shape):
  //   `${Card}:hover &`   — a styled component used as a SELECTOR.
  //   `${flexCenter}`     — a `css\`…\`` mixin, spliced as declarations.
  if (Node.isIdentifier(expression)) {
    const name = expression.getText()
    const binding = state.bindings.get(name) ?? state.importedBinding(name)
    if (binding?.base.kind === 'standalone') {
      if (binding.mixinBody !== undefined) return binding.mixinBody
    } else if (binding) {
      return `.${binding.classNames[binding.classNames.length - 1]}`
    }
  }

  const direct = staticText(evaluateExpression(expression, state.scope, state.evalOptions))
  if (direct !== undefined) return direct

  // The ternary rule — `branchSelection.ts`'s stated positional heuristic,
  // reached ONLY after the evaluator declined to decide the condition.
  const ternary = ternaryOf(expression)
  if (ternary) {
    const consequent = staticText(evaluateExpression(ternary.getWhenTrue(), state.scope, state.evalOptions))
    if (consequent !== undefined) {
      findings.push({
        kind: 'branch-guessed',
        expression: shortenExpression(ternary.getCondition().getText()),
        message: `\`${shortenExpression(ternary.getCondition().getText())}\` is not decidable from source, so the first branch was taken; \`${shortenExpression(ternary.getWhenFalse().getText())}\` is not applied.`,
      })
      return consequent
    }
  }

  return undefined
}

/** A ternary, or the ternary an interpolation arrow's body IS — `${(p) => (p.active ? 'a' : 'b')}` is the shape this exists for, parentheses and all. Only one level: an arrow with a block body is a program, not a value. */
function ternaryOf(expression: Node): ConditionalExpression | undefined {
  const bare = unwrapParens(expression)
  if (Node.isConditionalExpression(bare)) return bare
  if (Node.isArrowFunction(bare)) {
    const body = unwrapParens(bare.getBody())
    if (Node.isConditionalExpression(body)) return body
  }
  return undefined
}

function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

/**
 * A resolved value as CSS text, or `undefined` when there is nothing honest to
 * write. `false`/`null`/`undefined` become the empty string because that is
 * what styled-components itself does with them — a real answer, not a failure,
 * exactly the distinction parser-08 drew for `{kind:'undefined'}`.
 */
function staticText(value: StaticValue): string | undefined {
  if (value.kind === 'undefined') return ''
  if (value.kind !== 'literal') return undefined
  if (value.value === null || value.value === false) return ''
  // `${true}` has no CSS meaning; treating it as the word "true" would write a
  // declaration the app never had.
  if (value.value === true) return undefined
  return String(value.value)
}

/**
 * What ONE parse of one file can see: the file's own templates, plus — resolved
 * lazily, only for a JSX tag that actually turns out to name one — a styled
 * component IMPORTED from another file.
 *
 * The cross-file half is not optional polish. `export const Panel =
 * styled.section\`…\`` in `ui/Panel.tsx`, used as `<Panel>` in a route, is the
 * single most common way a real repo organises styled components, and it is
 * invisible to a same-file-only lookup: `Panel` is an imported identifier here,
 * and `inlineLocalComponents` cannot expand it either (a tagged template is not
 * a function that returns JSX), so the element would render as an opaque
 * "Unknown module" box with none of its CSS.
 *
 * Lazy, and negatively memoized, because the cost has to stay proportional to
 * what is used: a tag that is NOT a styled component costs one import-map hit
 * and one already-memoized `extractCssInJs` on the target file (whose own
 * early-out is a single import-declaration scan). That is the same order of
 * work `resolveComponentSources` already does for every component node.
 *
 * Resolution goes through `resolveExportedDeclaration`, so a barrel
 * (`export { Panel } from './Panel'`) and a renaming barrel both resolve —
 * the identical mechanism local-component inlining uses for the identical
 * question.
 */
export interface CssInJsScope {
  /** Every template this parse contributed: the file's own, plus each imported one a tag actually used. Grows during the walk. */
  templates: CssInJsTemplate[]
  /** `undefined` when `name` is not a styled/`css` binding reachable from this file. */
  binding(name: string): StyledBinding | undefined
  /** True when this file neither declares nor imports anything — the cheap early-out the JSX walk checks first. */
  empty: boolean
}

export function createCssInJsScope(
  sourceFile: SourceFile,
  relFile: string,
  evalOptions?: StaticEvalOptions,
): CssInJsScope {
  const own = extractCssInJs(sourceFile, relFile, evalOptions)
  const templates: CssInJsTemplate[] = [...own.extraction.templates]
  const seen = new Set(templates.map((t) => t.className))
  const lookupImported = importedBindingLookup(sourceFile, relFile, evalOptions)

  return {
    templates,
    empty: own.bindings.size === 0 && sourceFile.getImportDeclarations().length === 0,
    binding(name: string): StyledBinding | undefined {
      const local = own.bindings.get(name)
      if (local) return local

      const resolved = lookupImported(name)
      // An imported binding's template belongs to THIS page too — nothing else
      // will contribute it, since a tagged template is not a component
      // `inlineLocalComponents` ever parses.
      if (resolved && !seen.has(resolved.template.className)) {
        seen.add(resolved.template.className)
        templates.push(resolved.template)
      }
      return resolved
    },
  }
}

/**
 * `name -> the styled/`css` binding it is imported from`, lazy and negatively
 * memoized. Shared by the JSX attach step (`<Panel>`) and the extractor's own
 * interpolation resolution (`${buttonStyles}` where the mixin lives in another
 * file) — one import walk, two consumers, so they cannot disagree about what
 * `Panel` means.
 */
function importedBindingLookup(
  sourceFile: SourceFile,
  relFile: string,
  evalOptions?: StaticEvalOptions,
): (name: string) => StyledBinding | undefined {
  const workspaceRoot = workspaceRootOf(sourceFile, relFile)
  const declarations = sourceFile.getImportDeclarations()
  const memo = new Map<string, StyledBinding | undefined>()
  /** Built on the FIRST cross-file question, never for a file that asks none. */
  let importTargets: Map<string, { target: SourceFile; exportedName: string }> | undefined

  return (name: string): StyledBinding | undefined => {
    if (workspaceRoot.length === 0 || declarations.length === 0) return undefined
    if (memo.has(name)) return memo.get(name)
    importTargets ??= buildImportTargets(declarations)
    const entry = importTargets.get(name)
    const resolved = entry ? bindingIn(entry.target, entry.exportedName, workspaceRoot, evalOptions) : undefined
    memo.set(name, resolved)
    return resolved
  }
}

/**
 * Local import name -> the file that DECLARES it plus the name it is declared
 * under. Barrel-aware via `resolveExportedDeclaration`, the same walk
 * `componentSources.ts` uses for the same question — `export { Panel as Card }`
 * has to land on `Panel` in `Panel.tsx`, not on `Card` in `index.ts`, which
 * declares nothing.
 */
function buildImportTargets(
  declarations: readonly ImportDeclaration[],
): Map<string, { target: SourceFile; exportedName: string }> {
  const map = new Map<string, { target: SourceFile; exportedName: string }>()
  for (const declaration of declarations) {
    const target = declaration.getModuleSpecifierSourceFile()
    if (!target) continue
    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) map.set(defaultImport.getText(), { target, exportedName: 'default' })
    for (const named of declaration.getNamedImports()) {
      const importedName = named.getNameNode().getText()
      const localName = named.getAliasNode()?.getText() ?? importedName
      const declaring = resolveExportedDeclaration(target, importedName)
      map.set(localName, declaring ? { target: declaring.sourceFile, exportedName: declaring.name } : { target, exportedName: importedName })
    }
  }
  return map
}

/**
 * The workspace root, derived from the pair the caller already holds — the
 * file's absolute path and the same path relative to the root. Exact (`relFile`
 * is `path.relative(root, abs)` by construction at every call site), and it
 * avoids threading a fourth parameter through `parseJsxTree` and every one of
 * its callers for a value they all already computed.
 */
function workspaceRootOf(sourceFile: SourceFile, relFile: string): string {
  const abs = sourceFile.getFilePath()
  const suffix = `/${relFile}`
  return abs.endsWith(suffix) ? abs.slice(0, abs.length - suffix.length) : ''
}

/** `exportedName` is the name the DECLARING file uses; `'default'` means "the file's single default-exported binding", which for a styled component is the const it exports. */
function bindingIn(
  target: SourceFile,
  exportedName: string,
  workspaceRoot: string,
  evalOptions?: StaticEvalOptions,
): StyledBinding | undefined {
  const rel = relativePosix(workspaceRoot, target.getFilePath())
  if (rel === undefined) return undefined
  const file = extractCssInJs(target, rel, evalOptions)
  if (file.bindings.size === 0) return undefined
  if (exportedName !== 'default') return file.bindings.get(exportedName)

  const assignment = target.getExportAssignments().find((ea) => !ea.isExportEquals())
  const expression = assignment?.getExpression()
  return expression && Node.isIdentifier(expression) ? file.bindings.get(expression.getText()) : undefined
}

/** Workspace-relative POSIX path, or `undefined` when `abs` escapes the root — the same containment posture every other path read in this package takes. */
function relativePosix(workspaceRoot: string, abs: string): string | undefined {
  const prefix = `${workspaceRoot}/`
  if (!abs.startsWith(prefix)) return undefined
  return abs.slice(prefix.length)
}

/**
 * The stylesheet for a set of templates, deduplicated by class name.
 *
 * The dedupe is not an optimisation: one component file is re-parsed once per
 * call site it is inlined at, so a shared `styled.div` legitimately arrives 29
 * times, and 29 identical rules in `extraCss` would be 29 identical
 * `cssToStyleRules` parses collapsing onto one id anyway. Class names are
 * content-addressed (`syntheticClassName`), so identical name means identical
 * template.
 */
export function cssInJsStylesheet(templates: readonly CssInJsTemplate[]): string {
  const byClassName = new Map<string, string>()
  for (const template of templates) {
    if (template.css.length === 0) continue
    if (!byClassName.has(template.className)) byClassName.set(template.className, template.css)
  }
  return [...byClassName.values()].join('\n')
}

/** Merges two extractions (a page's own templates + an inlined component file's), deduplicated by class name and keeping source order. */
export function mergeCssInJs(
  a: CssInJsExtraction | undefined,
  b: CssInJsExtraction | undefined,
): CssInJsExtraction | undefined {
  if (!a) return b
  if (!b) return a
  const seen = new Set(a.templates.map((t) => t.className))
  const merged = [...a.templates]
  for (const template of b.templates) {
    if (seen.has(template.className)) continue
    seen.add(template.className)
    merged.push(template)
  }
  return { templates: merged }
}
