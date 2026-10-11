/**
 * classOverride — G-2b: a class-styled value edited in ONE instance of a shared
 * component changes that instance, and no other.
 *
 * `.card { padding: 8px }` is read by every `<Card />`, so rewriting it is the
 * "changes every instance" write the editor used to warn about. Instead the
 * instance gets a modifier class and a rule one class more specific than the
 * component's own:
 *
 *     // Home.tsx       <Card className="card-home-2" title="…" />
 *     // Card.tsx       <div className={cn("card", className)}>
 *     // Card.css       .card.card-home-2 { padding: 20px }
 *
 * Three files, one gesture, all or nothing:
 *   - the component's ROOT takes the call site's `className` and joins it to its
 *     own (`classNameProp.ts`; nothing is edited when it already does);
 *   - the page's call site gains the modifier token (`setJsxClassName`);
 *   - the stylesheet gains the modifier rule next to the base rule
 *     (`@core/css-codemods`' `modifierRule.ts`), or an existing one for this
 *     instance is edited (a second edit converges on the one rule).
 *
 * The modifier is named `<class>-<page file>-<n>` (`card-home-2`: the second
 * `<Card>` of Home.tsx), the first such name nothing in the project's
 * stylesheets or in the two source files already uses (`freshName`).
 *
 * ## What reaches the root
 *
 * The class must be the ROOT element's: a modifier is passed to the component as
 * `className`, and only the root takes it. A component that only passes its props
 * on (`<Inner {...props} />`) is not edited either — the page's `className`
 * reaches `Inner` through the spread, `Inner` is the component whose root takes
 * it, and the forwarders gain only the property in their props type. A spread
 * that filters (`{...omit(props, 'className')}`), a forwarder that takes
 * `className` for itself, and a hop that passes props one by one are refused by
 * name: the class might never arrive.
 *
 * ## Refusals (every file byte-identical)
 *
 * `not-in-component`, `unresolvable`, `package-component` (the chain),
 * `class-not-root` (the element is not what the component returns),
 * `class-not-on-element` (the root does not name the class), `class-selector-unsupported`
 * (a rule that is not one plain class), `class-not-forwarded`, `class-filtered`,
 * `call-site-spread` (the page's call site spreads an object), `call-site-class`
 * (some other call site passes a `className` the component would now apply),
 * the `class-prop-*` / `class-spread-root` / `unsupported-*` set of
 * `ensureRootTakesClassName`, a stylesheet refusal (`css-syntax`,
 * `invalid-at-rule`), and `not-an-override` for an Apply-to-all with nothing to
 * apply.
 */
import * as path from 'node:path'
import { Node, QuoteKind, type Project, type SourceFile } from 'ts-morph'
import { classNamesInStylesheet, modifierSelector, parseModifierSelector, readRuleDeclarations, removeModifierDeclarations, ruleExists, setDeclaration, setModifierDeclarations, singleClassName, type ModifierConvention } from '@core/css-codemods'
import { createWorkspaceProject, getReturnedJsxRoots } from '@core/page-parser'
import { MAX_INSTANCE_OVERRIDE_DEPTH } from '@core/page-tree'
import { hopKind, resolveCallChain, type Level } from './callChain'
import { classNamesOnElement, ensureRootTakesClassName } from './classNameProp'
import { addOptionalPropToSignature } from './componentPropSignature'
import { allCallSites, exportNameOf, functionAtIndex, functionLikesOf, type CallSiteLocation } from './exposeLiteralSites'
import { freshName } from './freshName'
import { findJsxElementAtLocationOrThrow, type JsxOpeningLikeElement } from './locateJsxElement'
import { setJsxClassName } from './setJsxClassName'
import { introducesSyntaxErrors } from './syntaxRegression'

export interface ClassOverrideRefusal {
  reason: string
  message: string
}

export type ClassOverrideResult = { ok: true; token: string } | { ok: false; refusal: ClassOverrideRefusal }

interface ClassOverrideBase {
  workspaceRoot: string
  /** The call sites between the page and the element, outermost first (the page's own is first), as absolute file + `line:col`. */
  callSites: readonly CallSiteLocation[]
  /** The stylesheet holding the rule being edited: its text, how to write it back, and whether it is a CSS Module. */
  css: { text: string; write: (text: string) => void; convention: ModifierConvention }
  /** The rule the edit names, as the load reported it, and the conditional block it was made under. */
  selector: string
  atRule?: string
  project?: Project
}

export interface ExposeClassOverrideParams extends ClassOverrideBase {
  element: CallSiteLocation
  /** kebab-case property → value. */
  declarations: Readonly<Record<string, string>>
  /** Every class name any stylesheet of the project uses, so a fresh modifier collides with none. */
  projectClassNames: () => ReadonlySet<string>
}

export interface PromoteClassOverrideParams extends ClassOverrideBase {
  properties: readonly string[]
}

function refusal(reason: string, message: string): { ok: false; refusal: ClassOverrideRefusal } {
  return { ok: false, refusal: { reason, message } }
}

class Refused extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.reason = reason
  }
}

function refuse(reason: string, message: string): never {
  throw new Refused(reason, message)
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(text)
}

function kebab(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

/** The modifier rule an instance already has: a token its call site carries whose `<base> + token` rule the stylesheet states. */
function existingModifier(css: string, base: string, tokens: ReadonlySet<string>, convention: ModifierConvention): { token: string; selector: string } | undefined {
  for (const token of tokens) {
    for (const form of [convention, convention === 'module' ? 'plain' : 'module'] as const) {
      const selector = modifierSelector(base, token, form)
      if (ruleExists(css, selector)) return { token, selector }
    }
  }
  return undefined
}

function restore(originals: ReadonlyMap<SourceFile, string>): void {
  for (const [file, text] of originals) {
    if (file.getFullText() !== text) {
      file.replaceWithText(text)
      file.saveSync()
    }
  }
}

/** The element is exactly what the component returns (its chosen root). */
function assertRoot(level: Level, element: JsxOpeningLikeElement): JsxOpeningLikeElement {
  const root = getReturnedJsxRoots(level.fn).find((candidate) => candidate.chosen)?.expr
  const opening = root && Node.isJsxElement(root) ? root.getOpeningElement() : root && Node.isJsxSelfClosingElement(root) ? root : undefined
  if (!opening || opening.getTagNameNode().getStart() !== element.getTagNameNode().getStart()) {
    refuse('class-not-root', `Only the outermost element of <${level.identifier}> can take a class for one instance; this one is inside it, so its class is shared by every <${level.identifier}>.`)
  }
  return opening
}

/** Every hop below the page's call site must hand the page's props on untouched, or the class might never arrive. */
function assertForwarded(levels: readonly Level[]): void {
  for (let k = 1; k < levels.length; k += 1) {
    const outer = levels[k - 1]!
    const inner = levels[k]!
    const hop = hopKind(outer, inner.callSite)
    if (hop.kind === 'filtered') refuse('class-filtered', hop.message)
    if (hop.kind === 'explicit') {
      refuse('class-not-forwarded', `<${outer.identifier}> does not pass its props on to <${inner.identifier}> as a whole, so a class set on the page's <${levels[0]!.identifier}> would not reach it.`)
    }
    if (hop.destructured.has('className')) {
      refuse('class-filtered', `<${outer.identifier}> takes className for itself instead of passing it on to <${inner.identifier}>.`)
    }
    if (inner.callSite.getAttribute('className')) {
      refuse('class-filtered', `<${outer.identifier}> sets className on <${inner.identifier}> itself, so the page's class would replace it.`)
    }
  }
}

/** Another call site that passes `className` (or an object that may carry one) would start applying it once the component takes the prop. */
function assertNoStrayClassNames(project: Project, workspaceRoot: string, levels: readonly Level[]): void {
  for (const [k, level] of levels.entries()) {
    const sites = allCallSites(project, workspaceRoot, level.componentFile, level.target.exportedName ?? level.identifier, exportNameOf(level.componentFile, level.target.declaration))
    for (const site of sites) {
      const sameAs = (other: JsxOpeningLikeElement): boolean => site.getSourceFile() === other.getSourceFile() && site.getStart() === other.getStart()
      if (sameAs(level.callSite)) continue
      const stray = site.getAttributes().find((attr) => Node.isJsxSpreadAttribute(attr) || (Node.isJsxAttribute(attr) && attr.getNameNode().getText() === 'className'))
      if (stray) {
        refuse('call-site-class', `A <${level.identifier}> in ${path.basename(site.getSourceFile().getFilePath())} passes a className${k === 0 ? '' : ' or spreads props'} that <${levels[levels.length - 1]!.identifier}> does not apply today and would start to — nothing was changed.`)
      }
    }
  }
}

export function exposeClassOverride(params: ExposeClassOverrideParams): ClassOverrideResult {
  if (params.callSites.length === 0) return refusal('not-in-component', 'Only an element of a component can take a class for one instance.')
  if (params.callSites.length > MAX_INSTANCE_OVERRIDE_DEPTH) {
    return refusal('not-in-component', `This element sits ${params.callSites.length} components deep; a class is only passed down ${MAX_INSTANCE_OVERRIDE_DEPTH} levels.`)
  }
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const originals = new Map<SourceFile, string>()
  const remember = (file: SourceFile): void => {
    if (!originals.has(file)) originals.set(file, file.getFullText())
  }
  let cssWritten = false
  try {
    const chain = resolveCallChain(project, params.workspaceRoot, params.callSites, remember)
    if (!chain.ok) return { ok: false, refusal: chain.refusal }
    const { levels } = chain
    const page = levels[0]!
    const innermost = levels[levels.length - 1]!

    if (path.relative(innermost.componentFile.getFilePath(), params.element.file) !== '') {
      refuse('not-in-component', `That element is not part of <${innermost.identifier}>'s own markup.`)
    }
    const element = findJsxElementAtLocationOrThrow(innermost.componentFile, params.element.file, params.element.line, params.element.col)
    const root = assertRoot(innermost, element)
    assertForwarded(levels)
    if (page.callSite.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr))) {
      refuse('call-site-spread', `This <${page.identifier}> spreads an object of props, which could carry a className of its own — nothing was changed.`)
    }

    // Which rule is being edited, and which modifier it belongs to.
    const { convention } = params.css
    const pageTokens = classNamesOnElement(page.callSite).literals
    const parsed = parseModifierSelector(params.selector)
    const base = parsed && pageTokens.has(parsed.token) ? parsed.base : params.selector.trim()
    const baseName = singleClassName(base)
    if (baseName === null) refuse('class-selector-unsupported', 'Only a rule that is one plain class (like .card) can be overridden for one instance.')
    const named = classNamesOnElement(root)
    if (!named.literals.has(baseName) && !named.members.has(baseName)) {
      refuse('class-not-on-element', `<${innermost.identifier}>'s outermost element does not name .${baseName}, so Studio cannot tell this rule is the one it styles.`)
    }
    const existing = existingModifier(params.css.text, base, pageTokens, convention)
    let token: string
    let modifier: string
    if (existing) {
      ;({ token, selector: modifier } = existing)
    } else {
      const pageText = page.callFile.getFullText()
      const componentText = innermost.componentFile.getFullText()
      const known = params.projectClassNames()
      const stem = kebab(path.basename(page.callFile.getFilePath()).replace(/\.[^.]+$/, '')) || 'page'
      const ordinal = page.callFile.getDescendants().filter((node) => (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) && node.getTagNameNode().getText() === page.callSite.getTagNameNode().getText()).findIndex((node) => node.getStart() === page.callSite.getStart()) + 1
      token = freshName(`${baseName}-${stem}-${Math.max(ordinal, 1)}`, (candidate) => known.has(candidate) || hasWord(pageText, candidate) || hasWord(componentText, candidate))
      modifier = modifierSelector(base, token, convention)
    }

    const written = setModifierDeclarations(params.css.text, base, modifier, params.declarations, params.atRule === undefined ? {} : { atRule: params.atRule })
    if (!written.ok) return { ok: false, refusal: written.refusal }

    // The component's root takes the class; every component that only forwards gains the property in its type.
    const fnIndexes = levels.map((level) => functionLikesOf(level.componentFile).indexOf(level.fn))
    const plumbed = ensureRootTakesClassName(innermost.componentFile, innermost.fn, root)
    if (!plumbed.ok) return refusal(plumbed.reason, plumbed.message)
    if (plumbed.changed) {
      assertNoStrayClassNames(project, params.workspaceRoot, levels)
      for (const [k, level] of levels.entries()) {
        if (k === levels.length - 1) continue
        const outcome = addOptionalPropToSignature(level.componentFile, functionAtIndex(level.componentFile, fnIndexes[k]!), { name: 'className', binding: 'className', type: 'string', typeOnly: true })
        if (!outcome.ok) refuse('unsupported-props-type', outcome.message)
      }
    }
    for (const [file, original] of originals) {
      if (file.getFullText() !== original && introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[classOverride] ${path.basename(file.getFilePath())} would not parse after the class was passed — nothing was written.`)
      }
    }
    for (const [file, original] of originals) if (file.getFullText() !== original) file.saveSync()
    if (written.changed) {
      params.css.write(written.css)
      cssWritten = true
    }

    if (!pageTokens.has(token)) {
      const location = params.callSites[0]!
      const attached = setJsxClassName({ file: location.file, line: location.line, col: location.col, add: [{ kind: 'literal', token }], remove: [], project })
      if (!attached.ok) refuse('call-site-class', `The page's <${page.identifier}> could not take the class: ${attached.refusal.message}`)
    }
    return { ok: true, token }
  } catch (err) {
    restore(originals)
    if (cssWritten) params.css.write(params.css.text)
    if (err instanceof Refused) return refusal(err.reason, err.message)
    throw err
  }
}

/** "Apply to all": the instance's declarations for `properties` become the component's own rule, and the modifier goes once it is empty. */
export function promoteClassOverride(params: PromoteClassOverrideParams): ClassOverrideResult {
  const location = params.callSites[0]
  if (!location) return refusal('not-in-component', 'Only an instance placed on a page can have a class applied to every place its component is used.')
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const originals = new Map<SourceFile, string>()
  let cssWritten = false
  try {
    const pageFile = project.getSourceFile(location.file) ?? project.addSourceFileAtPath(location.file)
    pageFile.refreshFromFileSystemSync()
    originals.set(pageFile, pageFile.getFullText())
    const callSite = findJsxElementAtLocationOrThrow(pageFile, location.file, location.line, location.col)
    const base = params.selector.trim()
    if (singleClassName(base) === null) refuse('class-selector-unsupported', 'Only a rule that is one plain class (like .card) can take a value from one instance.')
    const tokens = classNamesOnElement(callSite).literals
    const found = existingModifier(params.css.text, base, tokens, params.css.convention)
    if (!found) refuse('not-an-override', 'This instance has no class override of that rule to apply.')

    const scope = params.atRule === undefined ? {} : { atRule: params.atRule }
    const declarations = readRuleDeclarations(params.css.text, found.selector, scope)
    const properties = params.properties.map((property) => property.toLowerCase()).filter((property) => declarations[property] !== undefined)
    if (properties.length === 0) refuse('not-an-override', 'This instance does not override those values.')

    let css = params.css.text
    for (const property of properties) {
      const set = setDeclaration(css, base, property, declarations[property]!, scope)
      if (!set.ok) refuse(set.refusal.reason, set.refusal.message)
      css = set.css
    }
    const removed = removeModifierDeclarations(css, found.selector, properties, scope)
    if (!removed.ok) refuse(removed.refusal.reason, removed.refusal.message)
    css = removed.css
    params.css.write(css)
    cssWritten = true

    // The modifier is gone once no scope of its rule says anything.
    if (!ruleExists(css, found.selector)) {
      const detached = setJsxClassName({ file: location.file, line: location.line, col: location.col, add: [], remove: [{ kind: 'literal', token: found.token }], project })
      if (!detached.ok) refuse('call-site-class', `The page's <${callSite.getTagNameNode().getText()}> could not drop the class: ${detached.refusal.message}`)
    }
    return { ok: true, token: found.token }
  } catch (err) {
    restore(originals)
    if (cssWritten) params.css.write(params.css.text)
    if (err instanceof Refused) return refusal(err.reason, err.message)
    throw err
  }
}

/** The class names every given stylesheet text mentions — what a fresh modifier name must not collide with. */
export function classNamesOfStylesheets(texts: Iterable<string>): Set<string> {
  const names = new Set<string>()
  for (const text of texts) for (const name of classNamesInStylesheet(text)) names.add(name)
  return names
}
