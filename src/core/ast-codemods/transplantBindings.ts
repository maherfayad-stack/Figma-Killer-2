/**
 * transplantBindings - which of the names a moved element reads travel with it,
 * and how. Split out of `transplantJsxElement.ts` (module-size budget) because
 * it is the whole decision behind a cross-file move: the splice is mechanical,
 * this is the part that can refuse.
 *
 * Every free name of the subtree lands in exactly one bucket, and the same walk
 * is run again over each declaration a bucket pulls in, so what is carried is
 * the transitive closure - never a name whose own dependencies stay behind:
 *
 *  - **Module scope, importable** - an import of the origin, or a helper it
 *    exports. Carried as an import at the destination (aliased on a clash).
 *  - **Module scope, not exported** - a plain constant or function the origin
 *    keeps to itself. COPIED into the destination's module scope (deduped when
 *    the destination already declares the identical thing, renamed on a clash).
 *    A component does not copy: it refuses `unexported-binding`.
 *  - **Component scope, context hook** (`const { t } = useLanguage()`) - the
 *    CALL is re-established at the destination (`transplantCarry.ts`).
 *  - **Component scope, plain declaration** (`const total = a * b`,
 *    `function onPick() {}`) - COPIED into the destination component's body,
 *    after any hook it reads. G-1a.
 *  - **Component scope, anything the component owns** - a prop, state, a ref, a
 *    `.map` row, a `let`. Refuses `captured-scope` and names it. Moving state
 *    changes behaviour and is a separate decision (G-1b); baking a prop or row
 *    value is another (G-1c).
 *
 * Nothing is executed. A "plain" declaration is plain because of what it
 * READS, found by the same static scope walk as everything else here.
 */
import * as path from 'node:path'
import type { Block, CallExpression, Node, SourceFile } from 'ts-morph'
import type { TextEdit } from './jsxChildRange'
import { planImportBindings, type ImportRequirement } from './jsxImportEdits'
import { relativeSpecifier } from './importReconcile'
import { analyzeFreeVariables, bindingKindAt } from './subtreeFreeVariables'
import { enclosingFunctionComponent, findHookBindingForName } from './detachHooks'
import { materializeHookGroup, moduleDerivedAlias, type HookCarryGroup } from './transplantCarry'
import { freshName } from './freshName'
import {
  declarationText,
  declaresIdentically,
  findLocalBinding,
  findModuleDeclaration,
  isComponentName,
  namesInUse,
  type CarriableDeclaration,
} from './transplantScopeCarry'

/** One declaration copied to the destination, for the notice the gesture shows. */
export interface CarriedDeclaration {
  /** The name it had in the origin. */
  name: string
  /** The name it has at the destination - different only after a clash. */
  as: string
  scope: 'body' | 'module'
  /** True when the destination already declared the identical thing, so nothing was written. */
  reused: boolean
}

export interface CarryDestination {
  source: SourceFile
  file: string
  /** The destination component's body - where hooks and body-level declarations are written. Absent when it has none. */
  body?: Block
  /** The indent body-level declarations are written at (continuation lines; the first line sits at a statement start). */
  bodyIndent: string
}

export interface CarryRefusal {
  reason: 'captured-scope' | 'unexported-binding'
  message: string
}

export type CarriedBindings =
  | {
      ok: true
      requirements: Map<string, ImportRequirement>
      renames: Map<string, string>
      hookEdits: TextEdit[]
      /** Each NEW hook statement `hookEdits` writes, as text - what a lift's module body is built from. */
      hookStatements: string[]
      /** Copied component-body declarations, dependencies first, indented for `bodyIndent`. */
      bodyStatements: string[]
      /** Copied module-level declarations, dependencies first. */
      moduleStatements: string[]
      carried: CarriedDeclaration[]
    }
  | { ok: false; refusal: CarryRefusal }

interface Pending {
  name: string
  node: CarriableDeclaration
  /** Reads nothing but imports and globals - so an identical declaration already at the destination means the same thing. */
  leaf: boolean
}

export function resolveCarriedBindings(
  subtree: Node,
  originSource: SourceFile,
  originText: string,
  destination: CarryDestination,
): CarriedBindings {
  const { source: destinationSource, file: destinationFile, body: destinationBody } = destination
  const originComponent = enclosingFunctionComponent(subtree)
  const canCarryHooks = destinationBody !== undefined

  const requirements = new Map<string, ImportRequirement>()
  const hookGroups = new Map<CallExpression, HookCarryGroup>()
  const captured: string[] = []
  const unexported: string[] = []
  const bodyDeclarations: Pending[] = []
  const moduleDeclarations: Pending[] = []
  const visited = new Set<string>()

  /** Walks `root`'s free names; returns whether it reads only imports and globals. */
  function visit(root: Node, ownName: string | undefined): boolean {
    let leaf = true
    for (const variable of analyzeFreeVariables(root, originSource)) {
      const { name } = variable
      if (name === ownName) continue

      if (bindingKindAt(root, name, originSource) === 'module') {
        const requirement = resolveCarriedBinding(name, originSource, destinationFile)
        if (requirement === UNEXPORTED) {
          if (carryModuleDeclaration(name, variable.isComponentTag)) leaf = false
          else unexported.push(name)
        } else if (requirement) {
          requirements.set(name, requirement)
        }
        continue
      }

      const hook = originComponent && canCarryHooks ? findHookBindingForName(originComponent, name) : undefined
      if (hook && hook !== 'unmovable') {
        const calleeRequirement = resolveCarriedBinding(hook.label, originSource, destinationFile)
        if (calleeRequirement === UNEXPORTED) {
          captured.push(name)
          continue
        }
        let group = hookGroups.get(hook.call)
        if (!group) {
          group = { hook, names: new Map() }
          hookGroups.set(hook.call, group)
        }
        const key = hook.binding.kind === 'keys' ? hook.binding.keys.find((k) => k.local === name)?.key : undefined
        group.names.set(name, key)
        if (calleeRequirement) requirements.set(hook.label, calleeRequirement)
        leaf = false
        continue
      }

      const local = originComponent ? findLocalBinding(originComponent, name) : undefined
      if (local?.kind === 'declaration' && carryBodyDeclaration(name, local.statement)) leaf = false
      else captured.push(name)
    }
    return leaf
  }

  function carryBodyDeclaration(name: string, statement: CarriableDeclaration): boolean {
    const key = `body:${name}`
    if (visited.has(key)) return true
    visited.add(key)
    const leaf = visit(statement, name)
    bodyDeclarations.push({ name, node: statement, leaf })
    return true
  }

  function carryModuleDeclaration(name: string, usedAsTag: boolean): boolean {
    const key = `module:${name}`
    if (visited.has(key)) return true
    const statement = findModuleDeclaration(originSource, name)
    if (!statement || usedAsTag || isComponentName(name)) return false
    visited.add(key)
    const leaf = visit(statement, name)
    moduleDeclarations.push({ name, node: statement, leaf })
    return true
  }

  visit(subtree, undefined)

  if (captured.length > 0) {
    const names = [...new Set(captured)].map((name) => `"${name}"`).join(', ')
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message:
          `It reads ${names}, which belong to the component it is written in (a prop, state, a list row) and cannot follow it to another file. ` +
          `Keep it inside its own frame, or move ${captured.length === 1 ? 'that value' : 'those values'} into a shared file first.`,
      },
    }
  }
  if (unexported.length > 0) {
    const name = unexported[0]!
    return {
      ok: false,
      refusal: {
        reason: 'unexported-binding',
        message: `It uses "${name}", which its file keeps private, so the other file cannot import it. Export "${name}" from its own file first, then drag again.`,
      },
    }
  }
  if (bodyDeclarations.length > 0 && !destinationBody) {
    const names = bodyDeclarations.map((declaration) => `"${declaration.name}"`).join(', ')
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message: `It reads ${names}, which need a component body to live in, and the place it is going to has none. Drop it into a component that has a body.`,
      },
    }
  }

  // Every requirement - the free names AND each hook's own callee - planned
  // together, so a callee that happens to collide gets exactly the same
  // aliasing treatment as anything else (`planImportBindings`).
  const bindings = planImportBindings(destinationSource, requirements, { preferredAlias: moduleDerivedAlias })
  const renames = new Map<string, string>()
  for (const name of requirements.keys()) {
    const local = bindings.localName(name)
    if (local !== name) renames.set(name, local)
  }

  const hookEdits: TextEdit[] = []
  const hookStatements: string[] = []
  if (destinationBody) {
    for (const group of hookGroups.values()) {
      const calleeLocal = bindings.localName(group.hook.label)
      const materialized = materializeHookGroup(destinationSource, destinationBody, calleeLocal, group)
      for (const [name, text] of materialized.reads) renames.set(name, text)
      hookEdits.push(...materialized.edits)
      if (materialized.statement) hookStatements.push(materialized.statement)
    }
  }

  // A hook's own binding shape (whole vs. destructured) can disagree with an
  // EXISTING call the destination already makes to the same hook - reading a
  // whole value against a call the destination only ever destructures has no
  // field to reuse, and `materializeHookGroup` leaves that one name
  // unresolved rather than guess. Caught here, once, for every group: a
  // partial rename is worse than a refusal, because it would write the
  // moved subtree referencing a name nothing in the destination binds.
  for (const group of hookGroups.values()) {
    for (const name of group.names.keys()) {
      if (renames.has(name)) continue
      return {
        ok: false,
        refusal: {
          reason: 'captured-scope',
          message: `This element reads \`${name}\` from ${group.hook.label}(), and the destination component already calls ${group.hook.label}() in a shape that has no "${name}" to reuse. Give it a matching binding first, then drag again.`,
        },
      }
    }
  }

  // The copied declarations. Every name the destination uses - and every one
  // the imports and hook reads above are about to add - is off limits; a
  // declaration that would collide takes the next free name and every read of
  // it (in the subtree and in the other copies) follows.
  const used = namesInUse(destinationSource)
  for (const name of requirements.keys()) used.add(bindings.localName(name))
  for (const replacement of renames.values()) for (const word of replacement.match(/[A-Za-z_$][\w$]*/g) ?? []) used.add(word)

  const carried: CarriedDeclaration[] = []
  const moduleStatements: string[] = []
  const bodyStatements: string[] = []
  const copy = (pending: Pending, scope: 'body' | 'module'): void => {
    const container = scope === 'module' ? destinationSource : destinationBody!
    const indent = scope === 'module' ? '' : destination.bodyIndent
    const plain = declarationText(pending.node, originText, renames, indent)
    if (pending.leaf && declaresIdentically(container, pending.name, plain)) {
      carried.push({ name: pending.name, as: pending.name, scope, reused: true })
      return
    }
    const as = freshName(pending.name, (candidate) => used.has(candidate))
    used.add(as)
    if (as !== pending.name) renames.set(pending.name, as)
    const text = as === pending.name ? plain : declarationText(pending.node, originText, renames, indent)
    ;(scope === 'module' ? moduleStatements : bodyStatements).push(text)
    carried.push({ name: pending.name, as, scope, reused: false })
  }
  for (const pending of moduleDeclarations) copy(pending, 'module')
  for (const pending of bodyDeclarations) copy(pending, 'body')

  return { ok: true, requirements: bindings.required, renames, hookEdits, hookStatements, bodyStatements, moduleStatements, carried }
}

/**
 * The origin declares this name but keeps it to itself - see
 * {@link resolveCarriedBinding}.
 */
const UNEXPORTED = Symbol('unexported')

/**
 * Where `name` comes from, expressed as an import the DESTINATION file can
 * carry - or `undefined` when the origin file neither imports nor declares it
 * (a global, or a name this walk cannot trace, which `analyzeFreeVariables`
 * has already narrowed to almost nothing), or {@link UNEXPORTED} when the
 * origin declares it but does not export it.
 *
 * The same resolution `addReconciledImports` performs, expressed as a
 * REQUIREMENT rather than applied as a ts-morph mutation: this codemod writes
 * byte splices, and a ts-morph `addImportDeclaration` would reprint offsets the
 * splices were measured against.
 */
function resolveCarriedBinding(
  name: string,
  originSource: SourceFile,
  destinationFile: string,
): ImportRequirement | typeof UNEXPORTED | undefined {
  for (const declaration of originSource.getImportDeclarations()) {
    const specifierText = declaration.getModuleSpecifierValue()
    const specifier = specifierText.startsWith('.')
      ? relativeSpecifier(destinationFile, path.resolve(path.dirname(originSource.getFilePath()), specifierText))
      : specifierText

    if (declaration.getDefaultImport()?.getText() === name) return { specifier, style: 'default' }
    if (declaration.getNamespaceImport()?.getText() === name) return { specifier, style: 'namespace' }
    const named = declaration
      .getNamedImports()
      .some((entry) => (entry.getAliasNode() ?? entry.getNameNode()).getText() === name)
    if (named) return { specifier, style: 'named' }
  }

  // A helper the origin file declares itself: the destination imports it FROM
  // the origin. That only works when the origin EXPORTS it (`sec-17`): an
  // import of a name that is not there leaves the user's repo unbuildable.
  // A value the origin keeps private is copied instead (see this module's
  // doc); only what cannot be copied reaches the refusal.
  const declaration =
    originSource.getFunction(name) ?? originSource.getVariableDeclaration(name) ?? originSource.getClass(name)
  if (declaration) {
    return declaration.isExported()
      ? { specifier: relativeSpecifier(destinationFile, originSource.getFilePath()), style: 'named' }
      : UNEXPORTED
  }

  return undefined
}

