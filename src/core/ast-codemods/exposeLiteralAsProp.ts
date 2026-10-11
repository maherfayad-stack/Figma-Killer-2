/**
 * exposeLiteralAsProp — P5-C (DET-7): "Expose as prop", React's own form of a
 * Figma instance override.
 *
 * An element inside a component's markup renders the SAME literal at every
 * call site — `<h2>Current text</h2>` in `Card.tsx`. Editing it there changes
 * every `<Card/>` (the "changes every instance" warning), and detaching this
 * one instance gives up the component. This is the honest middle: the
 * literal becomes an OPTIONAL prop whose DEFAULT is that same literal,
 *
 *     export function Card({ title, heading = 'Current text' }) {
 *       return <h2>{heading}</h2>
 *
 * so every call site that does not pass `heading` renders byte-for-byte what
 * it rendered before, and — only when the caller hands a `value` — this ONE
 * call site passes the new one (`<Card heading="New text" />`). Two files,
 * one gesture, zero blast radius; ⌘Z is the undo journal's `restore`.
 *
 * One call may expose SEVERAL literals of the one element (a gesture that sets
 * `width` and `height` together): they are located against the original text,
 * written in one splice per file, and given their signatures in order, so the
 * whole gesture is one write and one undo-journal entry.
 *
 * What can be exposed (`ExposeTarget`), each only when it is a LITERAL in the
 * component's own source — a binding is never baked:
 *   - `text`: an element whose whole content is one run of text (or one
 *     string in braces) — only the text is replaced, the whitespace around it
 *     stays, so it renders exactly as before;
 *   - `attribute`: `title="x"`, `{'x'}`, `{12}`, `{true}`;
 *   - `style`: one property of an inline `style={{ … }}` object.
 *
 * Refuses, with every file byte-identical:
 *   - `unresolvable` / `package-component` — the call site is not a local
 *     component (the same resolution detach uses);
 *   - `not-in-component` — the element is not in that component's own markup;
 *   - `not-a-literal` — the target is not a literal there (a binding, an
 *     entity, several children);
 *   - `unsupported-params` — an undestructured `props`;
 *   - `unsupported-props-type` — the props type is not a same-file object
 *     shape, or is given through the component's variable (`FC<Props>`);
 *   - `maps-over-props` — the literal is inside a `.map` over one of the
 *     component's own props;
 *   - `call-site-spread` — some call site spreads an object into the
 *     component, which could already carry a key of the new name.
 *
 * The prop's name is the caller's, or the first `name2`, `name3`… that no
 * identifier in the component, no module-scope name of its file, no existing
 * prop and no attribute at ANY call site already uses — a call site passing a
 * `heading` that `...rest` forwards today would otherwise start setting it.
 */
import * as path from 'node:path'
import { Node, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph'
import { createWorkspaceProject } from '@core/page-parser'
import { buildParamBindings } from './detachComponent'
import { addOptionalPropToSignature, widenPropType } from './componentPropSignature'
import { fedIdentifier, needsWidening, planFedOverride, type FedPlan } from './exposeFedProp'
import {
  ExposeRefusal,
  IDENTIFIER_RE,
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
  type ExposeLiteralAsPropParams,
  type ExposeLiteralAsPropResult,
  type LiteralSite,
} from './exposeLiteralSites'
import { exposeThroughLevels } from './exposeThroughLevels'
import { topLevelBindingNames } from './importReconcile'
import { findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { resolveComponentCallSite } from './resolveComponentCallSite'
import { introducesSyntaxErrors } from './syntaxRegression'

/** One override, planned: a literal that becomes a prop, or a value that already IS a prop (only the call site changes). */
type PlannedOverride = { fed: false; literal: LiteralSite } | { fed: true; plan: Extract<FedPlan, { ok: true }>; name: string }


export function exposeLiteralAsProp(params: ExposeLiteralAsPropParams): ExposeLiteralAsPropResult {
  if (params.overrides.length === 0) throw new Error('[exposeLiteralAsProp] nothing to expose.')
  for (const override of params.overrides) {
    if (!IDENTIFIER_RE.test(override.propName)) throw new Error(`[exposeLiteralAsProp] "${override.propName}" is not a valid prop name.`)
  }
  if (params.via && params.via.length > 0) return exposeThroughLevels(params, params.via)
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const callFile = loadSourceFile(project, params.callSiteFile)
  const callSite = findJsxElementAtLocationOrThrow(callFile, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  const identifier = callSite.getTagNameNode().getText().split('.')[0]!

  const resolved = resolveComponentCallSite(project, callFile, params.workspaceRoot, identifier, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  if (!resolved.ok) return { ok: false, refusal: { reason: resolved.failure.reason, message: resolved.failure.message } }
  const { target, fn } = resolved.result
  const componentFile = target.sourceFile
  const originals = new Map([[componentFile, componentFile.getFullText()], [callFile, callFile.getFullText()]])

  try {
    if (path.relative(componentFile.getFilePath(), params.elementFile) !== '') {
      refuse('not-in-component', `That element is not part of <${identifier}>'s own markup. Select an element inside it.`)
    }
    const element = findJsxElementAtLocationOrThrow(componentFile, params.elementFile, params.line, params.col)
    if (element.getStart() < fn.getStart() || element.getEnd() > fn.getEnd()) {
      refuse('not-in-component', `That element is not part of <${identifier}>'s own markup. Select an element inside it.`)
    }

    const { params: bindings, childrenParam, hasUndestructuredParam } = buildParamBindings(fn)
    if (hasUndestructuredParam) {
      refuse('unsupported-params', `${identifier} takes an undestructured props parameter, so a named prop cannot be added. Destructure its props in the code first.`)
    }
    if (/\.tsx?$/.test(componentFile.getFilePath()) && isTypedThroughVariable(fn) && !fn.getParameters()[0]?.getTypeNode()) {
      refuse('unsupported-props-type', `${identifier}'s props are typed through its variable (like FC<Props>), which Studio cannot extend. Add the property in the code.`)
    }

    const seenTargets = new Set<string>()
    const propNames = new Set([...bindings.keys(), ...(childrenParam ? [childrenParam] : [])])
    const planned = params.overrides.map((override): PlannedOverride => {
      const key = targetKey(override.target)
      if (seenTargets.has(key)) refuse('not-a-literal', 'The same value was listed twice. Reload the project and try again.')
      seenTargets.add(key)
      // OD-19 — a value that is already the bare read of a prop of this name: only the call site changes.
      const paramName = fedIdentifier(element, override.target)
      const binding = paramName !== undefined ? bindings.get(paramName) : undefined
      if (paramName !== undefined && binding?.attrName === override.propName) {
        if (override.value === undefined) refuse('not-a-literal', `\`${override.propName}\` is already a prop here, so there is no literal to expose. Edit the prop in the code.`)
        const plan = planFedOverride({ fn, callSite, paramName, propName: override.propName, defaultText: binding.defaultText, value: override.value })
        if (!plan.ok) refuse(plan.reason, plan.message)
        return { fed: true, plan, name: override.propName }
      }
      const literal = literalFor(element, componentFile, override.target)
      assertNotMappedOverProps(literal.anchor, fn, propNames)
      return { fed: false, literal }
    })
    const literals = planned.flatMap((entry) => (entry.fed ? [] : [entry.literal]))

    // A fed value adds no prop, so no other call site can collide with it: only a new prop needs the survey.
    const sites = literals.length === 0 ? [callSite] : allCallSites(project, params.workspaceRoot, componentFile, target.exportedName ?? identifier, exportNameOf(componentFile, target.declaration))
    if (!sites.some((site) => site === callSite || (site.getSourceFile() === callFile && site.getStart() === callSite.getStart()))) sites.push(callSite)
    const spread = literals.length === 0 ? undefined : sites.find((site) => site.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr)))
    if (spread) {
      refuse('call-site-spread', `A <${identifier}> in ${path.basename(spread.getSourceFile().getFilePath())} spreads an object that could already set a prop of the new name. Pass the props explicitly in the code.`)
    }

    const taken = new Set<string>([
      ...fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()),
      ...topLevelBindingNames(componentFile),
      ...[...bindings.values()].map((binding) => binding.attrName),
      ...sites.flatMap((site) => site.getAttributes().flatMap((attr) => (Node.isJsxAttribute(attr) ? [attr.getNameNode().getText()] : []))),
      ...RESERVED_PROPS,
    ])
    const names = params.overrides.map((override, i) => {
      const entry = planned[i]!
      if (entry.fed) return entry.name
      let name = override.propName
      for (let n = 2; taken.has(name); n += 1) name = `${override.propName}${n}`
      taken.add(name)
      return name
    })

    // Every text edit is one splice of the ORIGINAL texts (the call site and
    // the component may be one file, in either order), then the signature,
    // on the function found again by where the splice moved it.
    const fnIndex = functionLikesOf(componentFile).indexOf(fn)
    const attrs = callSite.getAttributes()
    const attrAt = attrs.length > 0 ? attrs[attrs.length - 1]!.getEnd() : callSite.getTagNameNode().getEnd()
    const attrText = params.overrides.map((override, i) => (override.value === undefined || planned[i]!.fed ? '' : ` ${attributeText(names[i]!, override.value)}`)).join('')
    const edits = new Map<SourceFile, { pos: number; remove: number; text: string }[]>()
    const push = (file: SourceFile, edit: { pos: number; remove: number; text: string }) => edits.set(file, [...(edits.get(file) ?? []), edit])
    planned.forEach((entry, i) => {
      if (entry.fed) push(callFile, entry.plan.edit)
      else push(componentFile, { pos: entry.literal.start, remove: entry.literal.end - entry.literal.start, text: entry.literal.asJsx ? `{${names[i]}}` : names[i]! })
    })
    if (attrText) push(callFile, { pos: attrAt, remove: 0, text: attrText })
    for (const [file, fileEdits] of edits) {
      let out = file.getFullText()
      for (const edit of [...fileEdits].sort((x, y) => y.pos - x.pos)) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos + edit.remove)
      file.replaceWithText(out)
    }
    for (const [i, entry] of planned.entries()) {
      const component = functionAtIndex(componentFile, fnIndex)
      const name = names[i]!
      const value = params.overrides[i]!.value
      const signature = entry.fed
        ? (() => {
            const widen = value === undefined ? undefined : needsWidening(entry.plan, value)
            return widen === undefined ? { ok: true as const } : widenPropType(componentFile, component, name, widen)
          })()
        : addOptionalPropToSignature(componentFile, component, { name, binding: `${name} = ${entry.literal.defaultText}`, type: propType(entry.literal, value) })
      if (!signature.ok) refuse('unsupported-props-type', signature.message)
    }

    for (const [file, original] of originals) {
      if (introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[exposeLiteralAsProp] ${path.basename(file.getFilePath())} would not parse after exposing \`${names.join('`, `')}\` — nothing was written.`)
      }
    }
    for (const file of originals.keys()) if (file.getFullText() !== originals.get(file)) file.saveSync()
    return { ok: true, propNames: names, callSites: sites.length }
  } catch (err) {
    for (const [file, original] of originals) if (file.getFullText() !== original) file.replaceWithText(original)
    if (err instanceof ExposeRefusal) return { ok: false, refusal: { reason: err.reason, message: err.message } }
    throw err
  }
}
