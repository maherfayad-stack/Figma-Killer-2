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
 * ## A hop that spreads is not a level (G-2b, spread-forwarding)
 *
 * When `Card` hands its props to `Badge` with `{...props}` (or `{...rest}`), the
 * page's attribute reaches `Badge` as it is: `Card` is edited NOT AT ALL, the
 * prop is passed at the page's call site only, and `Badge` reads it. The run of
 * components from the page's down to the one that reads the prop shares one
 * name, free in every one of them and at every one of their call sites; `Card`
 * gains only the property in its props TYPE (so the page's call site still
 * type-checks), never a binding, which would take the prop out of `rest`. A
 * spread Studio cannot read as "all my props, unfiltered" (`{...omit(props, 'x')}`,
 * another object) is refused by name: the prop might never arrive.
 *
 * Everything is computed against the original texts and written together or not
 * at all: the page's call site, the call site inside each intermediate
 * component, and each component's signature. The refusals are `exposeLiteralAsProp`'s,
 * asked at every level (an undestructured `props` where a prop is to be bound, a
 * props type Studio cannot extend, a spread at any call site of any of the
 * components), and the chain itself must hold: each call site really sits inside
 * the component the one before it resolves to.
 *
 * Only a LITERAL travels. A value that is ALREADY a prop of the innermost
 * component is edited where the page passes it (`exposeFedProp.ts`): the chain
 * is walked up through every call site that forwards it as a bare read of its
 * own prop (or through a spread), each read exactly once, to the prop the page's
 * call site sets. A hop that gives the prop a value of its own (a literal, a
 * computed value) would make the edit shared, so it refuses, and a value of
 * another type than the prop carries is not widened through several
 * declarations.
 */
import * as path from 'node:path'
import { Node, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph'
import { createWorkspaceProject, paramReadCount } from '@core/page-parser'
import { MAX_INSTANCE_OVERRIDE_DEPTH } from '@core/page-tree'
import { buildParamBindings } from './detachComponent'
import { addOptionalPropToSignature } from './componentPropSignature'
import { hopKind, resolveCallChain, type Hop, type Level } from './callChain'
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
import { findJsxElementAtLocationOrThrow } from './locateJsxElement'
import { introducesSyntaxErrors } from './syntaxRegression'

interface Edit {
  pos: number
  remove: number
  text: string
}

/** One override, planned: a literal that travels down the chain, or a value that is already a prop (the page's call site is edited). */
type PlannedOverride = { fed: false; literal: LiteralSite } | { fed: true; edit: { edit: Edit } }

type Bindings = ReturnType<typeof buildParamBindings>

/**
 * A value that is already the bare read of the innermost component's prop
 * `paramName`: walk it up to the prop the page's call site sets, and plan that
 * call site's edit. Every hop must pass the prop on as `attr={ownProp}` (read
 * once) or through an unfiltered spread; the prop the walk ends on must be the
 * one the editor named.
 */
function fedEdit(levels: readonly Level[], bindingsOf: readonly Bindings[], hops: readonly (Hop | undefined)[], paramName: string, propName: string, value: string | number | boolean | undefined): { edit: Edit } {
  if (value === undefined) refuse('not-a-literal', `\`${propName}\` is already a prop here, so there is no literal to expose.`)
  let k = levels.length - 1
  let local: string | undefined = paramName
  const innermost = bindingsOf[k]!.params.get(paramName)!
  let attrName = innermost.attrName
  if (paramReadCount(levels[k]!.fn, paramName) !== 1) refuse('shared-prop', `\`${attrName}\` feeds more than one place in <${levels[k]!.identifier}>, so setting it here would change places you did not point at.`)
  while (k > 0) {
    const hop = hops[k]!
    if (hop.kind === 'spread') {
      // The page's attribute arrives under its own name; the forwarder never reads it.
      if (hop.destructured.has(attrName)) refuse('not-a-literal', `<${levels[k - 1]!.identifier}> takes \`${attrName}\` itself instead of passing it on.`)
      local = undefined
      k -= 1
      continue
    }
    const attribute = levels[k]!.callSite.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === attrName)
    const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
    const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
    const outer = expression && Node.isIdentifier(expression) ? bindingsOf[k - 1]!.params.get(expression.getText()) : undefined
    if (!expression || !outer) {
      refuse('not-a-literal', `<${levels[k - 1]!.identifier}> sets \`${attrName}\` itself rather than passing one of its own props on, so it is shared by every one of them.`)
    }
    if (paramReadCount(levels[k - 1]!.fn, expression.getText()) !== 1) {
      refuse('shared-prop', `\`${outer.attrName}\` feeds more than one place in <${levels[k - 1]!.identifier}>, so setting it here would change places you did not point at.`)
    }
    local = expression.getText()
    attrName = outer.attrName
    k -= 1
  }
  if (attrName !== propName) refuse('not-a-literal', `\`${propName}\` is not the prop this value is passed down as.`)
  const defaultText = local !== undefined ? bindingsOf[0]!.params.get(local)?.defaultText : innermost.defaultText
  const plan = planFedOverride({ fn: levels[0]!.fn, callSite: levels[0]!.callSite, paramName: local, propName, defaultText, value })
  if (!plan.ok) refuse(plan.reason, plan.message)
  if (needsWidening(plan, value) !== undefined) {
    refuse('unsupported-props-type', `\`${propName}\` is passed down through ${levels.length} components, and a value of another type would need each of their declarations changed.`)
  }
  return { edit: plan.edit }
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
    const chain = resolveCallChain(project, params.workspaceRoot, locations, remember)
    if (!chain.ok) return { ok: false, refusal: chain.refusal }
    const { levels } = chain

    const innermost = levels[levels.length - 1]!
    if (path.relative(innermost.componentFile.getFilePath(), params.elementFile) !== '') {
      refuse('not-in-component', `That element is not part of <${innermost.identifier}>'s own markup.`)
    }
    const element = findJsxElementAtLocationOrThrow(innermost.componentFile, params.elementFile, params.line, params.col)
    if (element.getStart() < innermost.fn.getStart() || element.getEnd() > innermost.fn.getEnd()) {
      refuse('not-in-component', `That element is not part of <${innermost.identifier}>'s own markup.`)
    }

    // hops[k]: how level k-1 hands its props to level k. A spread hop makes level k-1 a forwarder: no prop of its own.
    const hops: (Hop | undefined)[] = levels.map((level, k) => (k === 0 ? undefined : hopKind(levels[k - 1]!, level.callSite)))
    for (const hop of hops) if (hop?.kind === 'filtered') refuse('call-site-spread', hop.message)
    const last = levels.length - 1
    /** The level that actually declares the prop a level's attribute arrives at (itself, unless it only forwards). */
    const gainerOf: number[] = []
    for (let k = last; k >= 0; k -= 1) gainerOf[k] = k < last && hops[k + 1]?.kind === 'spread' ? gainerOf[k + 1]! : k

    // Every gainer takes a new prop, so its signature is vetted; a forwarder's type must at least be extensible.
    const bindingsOf = levels.map((level, k) => {
      const bindings = buildParamBindings(level.fn)
      const gains = gainerOf[k] === k
      if (gains && bindings.hasUndestructuredParam) {
        refuse('unsupported-params', `${level.identifier} takes an undestructured props parameter — Studio can't add a named prop without rewriting every "props.x".`)
      }
      if (/\.tsx?$/.test(level.componentFile.getFilePath()) && isTypedThroughVariable(level.fn) && !level.fn.getParameters()[0]?.getTypeNode()) {
        refuse('unsupported-props-type', `${level.identifier}'s props are typed through its variable (like FC<Props>), which Studio can't add a property to safely.`)
      }
      return bindings
    })

    const seenTargets = new Set<string>()
    const innerBindings = bindingsOf[last]!
    const innerPropNames = new Set([...innerBindings.params.keys(), ...(innerBindings.childrenParam ? [innerBindings.childrenParam] : [])])
    const planned: PlannedOverride[] = params.overrides.map((override) => {
      const key = targetKey(override.target)
      if (seenTargets.has(key)) refuse('not-a-literal', 'The same value was listed twice.')
      seenTargets.add(key)
      const paramName = fedIdentifier(element, override.target)
      if (paramName !== undefined && innerBindings.params.has(paramName)) {
        return { fed: true, edit: fedEdit(levels, bindingsOf, hops, paramName, override.propName, override.value) }
      }
      const literal = literalFor(element, innermost.componentFile, override.target)
      assertNotMappedOverProps(literal.anchor, innermost.fn, innerPropNames)
      return { fed: false, literal }
    })
    const literals: LiteralSite[] = planned.flatMap((entry) => (entry.fed ? [] : [entry.literal]))

    // Per prop-declaring level: one name, free in every component that carries it (the gainer and the forwarders above
    // it) and at every one of their call sites (a spread could already set the new prop; an attribute of that name
    // would start setting it).
    const verifiedSpreadSites = new Set(levels.flatMap((level, k) => (hops[k]?.kind === 'spread' ? [level.callSite] : [])))
    const nameAt: string[][] = levels.map(() => params.overrides.map(() => ''))
    let sitesAtTop = 1
    if (literals.length > 0) {
      for (let g = last; g >= 0; g -= 1) {
        if (gainerOf[g] !== g) continue
        const group = levels.map((_, k) => k).filter((k) => gainerOf[k] === g)
        const taken = new Set<string>(RESERVED_PROPS)
        for (const k of group) {
          const level = levels[k]!
          const sites = allCallSites(project, params.workspaceRoot, level.componentFile, level.target.exportedName ?? level.identifier, exportNameOf(level.componentFile, level.target.declaration))
          if (!sites.some((site) => site === level.callSite || (site.getSourceFile() === level.callFile && site.getStart() === level.callSite.getStart()))) sites.push(level.callSite)
          const spread = sites.find((site) => !verifiedSpreadSites.has(site) && !isSameSite(site, verifiedSpreadSites) && site.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr)))
          if (spread) {
            refuse('call-site-spread', `A <${level.identifier}> in ${path.basename(spread.getSourceFile().getFilePath())} spreads an object into it, which could already set a prop of the new name — nothing was changed.`)
          }
          for (const id of level.fn.getDescendantsOfKind(SyntaxKind.Identifier)) taken.add(id.getText())
          for (const name of topLevelBindingNames(level.componentFile)) taken.add(name)
          for (const binding of bindingsOf[k]!.params.values()) taken.add(binding.attrName)
          for (const site of sites) for (const attr of site.getAttributes()) if (Node.isJsxAttribute(attr)) taken.add(attr.getNameNode().getText())
          if (k === 0) sitesAtTop = sites.length
        }
        const names = params.overrides.map((override, i) => {
          if (planned[i]!.fed) return ''
          let name = override.propName
          for (let n = 2; taken.has(name); n += 1) name = `${override.propName}${n}`
          taken.add(name)
          return name
        })
        for (const k of group) nameAt[k] = names
      }
    }

    // Every text edit is one splice of the ORIGINAL texts, written together: the literal becomes its innermost prop;
    // the page's call site passes the value; each call site that is not a spread passes its own level's prop on.
    const fnIndexes = levels.map((level) => functionLikesOf(level.componentFile).indexOf(level.fn))
    const edits = new Map<SourceFile, Edit[]>()
    const push = (file: SourceFile, edit: Edit): void => void edits.set(file, [...(edits.get(file) ?? []), edit])
    planned.forEach((entry, i) => {
      if (entry.fed) push(levels[0]!.callFile, entry.edit.edit)
      else push(innermost.componentFile, { pos: entry.literal.start, remove: entry.literal.end - entry.literal.start, text: entry.literal.asJsx ? `{${nameAt[last]![i]}}` : nameAt[last]![i]! })
    })
    for (const [k, level] of levels.entries()) {
      if (hops[k]?.kind === 'spread') continue
      const text = params.overrides
        .map((override, i) => {
          if (planned[i]!.fed) return ''
          if (k > 0) return ` ${nameAt[k]![i]}={${nameAt[k - 1]![i]}}`
          return override.value === undefined ? '' : ` ${attributeText(nameAt[0]![i]!, override.value)}`
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
        const name = nameAt[k]![i]!
        const forwarder = gainerOf[k] !== k
        const signature = addOptionalPropToSignature(level.componentFile, functionAtIndex(level.componentFile, fnIndexes[k]!), {
          name,
          binding: `${name} = ${entry.literal.defaultText}`,
          type: propType(entry.literal, params.overrides[i]!.value),
          ...(forwarder ? { typeOnly: true } : {}),
        })
        if (!signature.ok) refuse('unsupported-props-type', signature.message)
      }
    }

    for (const [file, original] of originals) {
      if (introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[exposeThroughLevels] ${path.basename(file.getFilePath())} would not parse after passing \`${nameAt[0]!.join('`, `')}\` down — nothing was written.`)
      }
    }
    for (const file of originals.keys()) if (file.getFullText() !== originals.get(file)) file.saveSync()
    return { ok: true, propNames: params.overrides.map((override, i) => nameAt[0]![i] || override.propName), callSites: sitesAtTop }
  } catch (err) {
    for (const [file, original] of originals) if (file.getFullText() !== original) file.replaceWithText(original)
    if (err instanceof ExposeRefusal) return { ok: false, refusal: { reason: err.reason, message: err.message } }
    throw err
  }
}

/** The survey finds call sites as fresh nodes; a verified one is recognised by where it sits. */
function isSameSite(site: Node, verified: ReadonlySet<Node>): boolean {
  for (const known of verified) {
    if (known.getSourceFile().getFilePath() === site.getSourceFile().getFilePath() && known.getStart() === site.getStart()) return true
  }
  return false
}
