/**
 * exposeThroughLevels — G-2b: "Expose as prop" for an element that sits in a
 * component rendered by ANOTHER component.
 *
 *     // Page:   <Card />                         (the instance the user edits)
 *     // Card:   <Badge />                        (renders the next level)
 *     // Badge:  <span>New</span>                 (the literal)
 *
 * One level at a time, each component gains an optional prop whose default is
 * the SAME literal, and each call site hands the next level the value it was
 * given:
 *
 *     // Page:   <Card badgeLabel="Sale" />
 *     // Card:   ({ badgeLabel = 'New' }) => <Badge label={badgeLabel} />
 *     // Badge:  ({ label = 'New' }) => <span>{label}</span>
 *
 * So a `<Card />` that passes nothing renders what it always did, every other
 * place `<Badge />` is used renders what it always did, and only this one
 * instance shows the new value. The prop names are chosen per level (a name
 * free in THAT component and at every one of its call sites), and each level's
 * default is the literal itself, so the chain is byte-for-byte neutral until the
 * page passes a value.
 *
 * Everything is computed against the original texts and written together or not
 * at all: the page's call site, the call site inside each intermediate
 * component, and each component's signature. The refusals are `exposeLiteralAsProp`'s,
 * asked at every level (an undestructured `props`, a props type Studio cannot
 * extend, a spread at any call site of any of the components), and the chain
 * itself must hold: each call site really sits inside the component the one
 * before it resolves to.
 *
 * Only a LITERAL travels. A value that is ALREADY a prop of the innermost
 * component is edited where the page passes it (`exposeFedProp.ts`): the chain
 * is walked up through every call site that forwards it as a bare read of its
 * own prop, each read exactly once, to the prop the page's call site sets. A
 * hop that gives the prop a value of its own (a literal, a computed value)
 * would make the edit shared, so it refuses, and a value of another type than
 * the prop carries is not widened through several declarations.
 */
import * as path from 'node:path'
import { Node, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph'
import { createWorkspaceProject, paramReadCount, type FunctionLike } from '@core/page-parser'
import { MAX_INSTANCE_OVERRIDE_DEPTH } from '@core/page-tree'
import { buildParamBindings } from './detachComponent'
import { addOptionalPropToSignature } from './componentPropSignature'
import { fedIdentifier, needsWidening, planFedOverride } from './exposeFedProp'
import {
  RESERVED_PROPS,
  allCallSites,
  assertNotMappedOverProps,
  attributeText,
  exportNameOf,
  functionAtIndex,
  functionLikesOf,
  isTypedThroughVariable,
  literalFor,
  propType,
  refuse,
  targetKey,
  ExposeRefusal,
  type CallSiteLocation,
  type ExposeLiteralAsPropParams,
  type ExposeLiteralAsPropResult,
  type LiteralSite,
} from './exposeLiteralSites'
import { topLevelBindingNames } from './importReconcile'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import { resolveComponentCallSite, type ResolvedCallSiteComponent } from './resolveComponentCallSite'
import { introducesSyntaxErrors } from './syntaxRegression'

/** One component on the chain: the call site that renders it, and the component itself. */
interface Level {
  callFile: SourceFile
  callSite: JsxOpeningLikeElement
  identifier: string
  componentFile: SourceFile
  fn: FunctionLike
  target: ResolvedCallSiteComponent['target']
}

interface Edit {
  pos: number
  remove: number
  text: string
}

/** One override, planned: a literal that travels down the chain, or a value that is already a prop (the page's call site is edited). */
type PlannedOverride = { fed: false; literal: LiteralSite } | { fed: true; edit: { edit: Edit } }

/**
 * A value that is already the bare read of the innermost component's prop
 * `paramName`: walk it up to the prop the page's call site sets, and plan that
 * call site's edit. Every hop must pass the prop on as `attr={ownProp}` and
 * read it once; the prop the walk ends on must be the one the editor named.
 */
function fedEdit(levels: readonly Level[], bindingsOf: readonly ReturnType<typeof buildParamBindings>[], paramName: string, propName: string, value: string | number | boolean | undefined): { edit: Edit } {
  if (value === undefined) refuse('not-a-literal', `\`${propName}\` is already a prop here, so there is no literal to expose.`)
  let k = levels.length - 1
  let local = paramName
  let binding = bindingsOf[k]!.params.get(local)!
  if (paramReadCount(levels[k]!.fn, local) !== 1) refuse('shared-prop', `\`${binding.attrName}\` feeds more than one place in <${levels[k]!.identifier}>, so setting it here would change places you did not point at.`)
  while (k > 0) {
    const attribute = levels[k]!.callSite.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === binding.attrName)
    const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
    const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
    const outer = expression && Node.isIdentifier(expression) ? bindingsOf[k - 1]!.params.get(expression.getText()) : undefined
    if (!expression || !outer) {
      refuse('not-a-literal', `<${levels[k - 1]!.identifier}> sets \`${binding.attrName}\` itself rather than passing one of its own props on, so it is shared by every one of them.`)
    }
    if (paramReadCount(levels[k - 1]!.fn, expression.getText()) !== 1) {
      refuse('shared-prop', `\`${outer.attrName}\` feeds more than one place in <${levels[k - 1]!.identifier}>, so setting it here would change places you did not point at.`)
    }
    local = expression.getText()
    binding = outer
    k -= 1
  }
  if (binding.attrName !== propName) refuse('not-a-literal', `\`${propName}\` is not the prop this value is passed down as.`)
  const plan = planFedOverride({ fn: levels[0]!.fn, callSite: levels[0]!.callSite, paramName: local, propName, defaultText: binding.defaultText, value })
  if (!plan.ok) refuse(plan.reason, plan.message)
  if (needsWidening(plan, value) !== undefined) {
    refuse('unsupported-props-type', `\`${propName}\` is passed down through ${levels.length} components, and a value of another type would need each of their declarations changed.`)
  }
  return { edit: plan.edit }
}

function inside(outer: Node, inner: Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd()
}

export function exposeThroughLevels(params: ExposeLiteralAsPropParams, via: readonly CallSiteLocation[]): ExposeLiteralAsPropResult {
  if (via.length + 1 > MAX_INSTANCE_OVERRIDE_DEPTH) {
    return { ok: false, refusal: { reason: 'not-in-component', message: `This element sits ${via.length + 1} components deep; a value is only passed down ${MAX_INSTANCE_OVERRIDE_DEPTH} levels.` } }
  }
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const locations: CallSiteLocation[] = [{ file: params.callSiteFile, line: params.callSiteLine, col: params.callSiteCol }, ...via]
  const originals = new Map<SourceFile, string>()
  const remember = (file: SourceFile): void => {
    if (!originals.has(file)) originals.set(file, file.getFullText())
  }

  try {
    const levels: Level[] = []
    for (const [k, location] of locations.entries()) {
      const callFile = loadSourceFile(project, location.file)
      remember(callFile)
      const callSite = findJsxElementAtLocationOrThrow(callFile, location.file, location.line, location.col)
      const previous = levels[k - 1]
      // Each inner call site must really be part of the component the one above it renders.
      if (previous && (path.relative(previous.componentFile.getFilePath(), location.file) !== '' || !inside(previous.fn, callSite))) {
        refuse('not-in-component', `That element is not part of the markup <${previous.identifier}> renders.`)
      }
      const identifier = callSite.getTagNameNode().getText().split('.')[0]!
      const resolved = resolveComponentCallSite(project, callFile, params.workspaceRoot, identifier, location.file, location.line, location.col)
      if (!resolved.ok) return { ok: false, refusal: { reason: resolved.failure.reason, message: resolved.failure.message } }
      const { target, fn } = resolved.result
      remember(target.sourceFile)
      levels.push({ callFile, callSite, identifier, componentFile: target.sourceFile, fn, target })
    }

    const innermost = levels[levels.length - 1]!
    if (path.relative(innermost.componentFile.getFilePath(), params.elementFile) !== '') {
      refuse('not-in-component', `That element is not part of <${innermost.identifier}>'s own markup.`)
    }
    const element = findJsxElementAtLocationOrThrow(innermost.componentFile, params.elementFile, params.line, params.col)
    if (!inside(innermost.fn, element)) refuse('not-in-component', `That element is not part of <${innermost.identifier}>'s own markup.`)

    // Every level takes a new prop, so every level's signature and call sites are vetted.
    const bindingsOf = levels.map((level) => {
      const bindings = buildParamBindings(level.fn)
      if (bindings.hasUndestructuredParam) {
        refuse('unsupported-params', `${level.identifier} takes an undestructured props parameter — Studio can't add a named prop without rewriting every "props.x".`)
      }
      if (/\.tsx?$/.test(level.componentFile.getFilePath()) && isTypedThroughVariable(level.fn) && !level.fn.getParameters()[0]?.getTypeNode()) {
        refuse('unsupported-props-type', `${level.identifier}'s props are typed through its variable (like FC<Props>), which Studio can't add a property to safely.`)
      }
      return bindings
    })

    const seenTargets = new Set<string>()
    const innerBindings = bindingsOf[bindingsOf.length - 1]!
    const innerPropNames = new Set([...innerBindings.params.keys(), ...(innerBindings.childrenParam ? [innerBindings.childrenParam] : [])])
    const planned: PlannedOverride[] = params.overrides.map((override) => {
      const key = targetKey(override.target)
      if (seenTargets.has(key)) refuse('not-a-literal', 'The same value was listed twice.')
      seenTargets.add(key)
      const paramName = fedIdentifier(element, override.target)
      if (paramName !== undefined && innerBindings.params.has(paramName)) {
        return { fed: true, edit: fedEdit(levels, bindingsOf, paramName, override.propName, override.value) }
      }
      const literal = literalFor(element, innermost.componentFile, override.target)
      assertNotMappedOverProps(literal.anchor, innermost.fn, innerPropNames)
      return { fed: false, literal }
    })
    const literals: LiteralSite[] = planned.flatMap((entry) => (entry.fed ? [] : [entry.literal]))

    // Per level: every call site of the component (a spread could already set the new prop), and the names it takes.
    const names: string[][] = []
    const sitesAtTop: number[] = []
    for (const [k, level] of levels.entries()) {
      // A value that is already a prop adds none: the survey is only for new ones.
      if (literals.length === 0) {
        names.push(params.overrides.map(() => ''))
        sitesAtTop.push(1)
        continue
      }
      const sites = allCallSites(project, params.workspaceRoot, level.componentFile, level.target.exportedName ?? level.identifier, exportNameOf(level.componentFile, level.target.declaration))
      if (!sites.some((site) => site === level.callSite || (site.getSourceFile() === level.callFile && site.getStart() === level.callSite.getStart()))) sites.push(level.callSite)
      const spread = sites.find((site) => site.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr)))
      if (spread) {
        refuse('call-site-spread', `A <${level.identifier}> in ${path.basename(spread.getSourceFile().getFilePath())} spreads an object into it, which could already set a prop of the new name — nothing was changed.`)
      }
      const taken = new Set<string>([
        ...level.fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()),
        ...topLevelBindingNames(level.componentFile),
        ...[...bindingsOf[k]!.params.values()].map((binding) => binding.attrName),
        ...sites.flatMap((site) => site.getAttributes().flatMap((attr) => (Node.isJsxAttribute(attr) ? [attr.getNameNode().getText()] : []))),
        ...RESERVED_PROPS,
      ])
      names.push(
        params.overrides.map((override, i) => {
          if (planned[i]!.fed) return ''
          let name = override.propName
          for (let n = 2; taken.has(name); n += 1) name = `${override.propName}${n}`
          taken.add(name)
          return name
        }),
      )
      sitesAtTop.push(sites.length)
    }

    // Every text edit is one splice of the ORIGINAL texts, written together: the literal becomes its innermost prop;
    // the page's call site passes the value; each inner call site passes its own level's prop on.
    const fnIndexes = levels.map((level) => functionLikesOf(level.componentFile).indexOf(level.fn))
    const edits = new Map<SourceFile, Edit[]>()
    const push = (file: SourceFile, edit: Edit): void => void edits.set(file, [...(edits.get(file) ?? []), edit])
    const last = levels.length - 1
    planned.forEach((entry, i) => {
      if (entry.fed) push(levels[0]!.callFile, entry.edit.edit)
      else push(innermost.componentFile, { pos: entry.literal.start, remove: entry.literal.end - entry.literal.start, text: entry.literal.asJsx ? `{${names[last]![i]}}` : names[last]![i]! })
    })
    for (const [k, level] of levels.entries()) {
      const text = params.overrides
        .map((override, i) => {
          if (planned[i]!.fed) return ''
          if (k > 0) return ` ${names[k]![i]}={${names[k - 1]![i]}}`
          return override.value === undefined ? '' : ` ${attributeText(names[0]![i]!, override.value)}`
        })
        .join('')
      if (!text) continue
      const attrs = level.callSite.getAttributes()
      push(level.callFile, { pos: attrs.length > 0 ? attrs[attrs.length - 1]!.getEnd() : level.callSite.getTagNameNode().getEnd(), remove: 0, text })
    }
    for (const [file, fileEdits] of edits) {
      let out = file.getFullText()
      for (const edit of [...fileEdits].sort((x, y) => y.pos - x.pos)) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos + edit.remove)
      file.replaceWithText(out)
    }
    for (const [k, level] of levels.entries()) {
      for (const [i, entry] of planned.entries()) {
        if (entry.fed) continue
        const name = names[k]![i]!
        const signature = addOptionalPropToSignature(level.componentFile, functionAtIndex(level.componentFile, fnIndexes[k]!), {
          name,
          binding: `${name} = ${entry.literal.defaultText}`,
          type: propType(entry.literal, params.overrides[i]!.value),
        })
        if (!signature.ok) refuse('unsupported-props-type', signature.message)
      }
    }

    for (const [file, original] of originals) {
      if (introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[exposeThroughLevels] ${path.basename(file.getFilePath())} would not parse after passing \`${names[0]!.join('`, `')}\` down — nothing was written.`)
      }
    }
    for (const file of originals.keys()) if (file.getFullText() !== originals.get(file)) file.saveSync()
    return { ok: true, propNames: params.overrides.map((override, i) => names[0]![i] || override.propName), callSites: sitesAtTop[0]! }
  } catch (err) {
    for (const [file, original] of originals) if (file.getFullText() !== original) file.replaceWithText(original)
    if (err instanceof ExposeRefusal) return { ok: false, refusal: { reason: err.reason, message: err.message } }
    throw err
  }
}
