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
 *  - **Component scope, state** (`const [open, setOpen] = useState(false)`,
 *    `useReducer`, `useRef(init)`) - the STATEMENT is copied to the top of the
 *    destination component under fresh names: the element gets its own copy of
 *    the state (OD-17, G-1b; `transplantStateCarry.ts`). A custom hook's result
 *    refuses by name, and so does a destination a hook cannot be written into.
 *  - **Component scope, a value handed in** - a `.map` row's item and index, or
 *    a prop with a default - becomes `const name = <literal>` at the destination,
 *    read off the source text (G-1c; `transplantPropBake.ts`).
 *  - **Component scope, anything else the component owns** - a prop nothing
 *    gives a value to, a `let`. Refuses `captured-scope` and names it.
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
import { classifyOwned, stateStatementText, type OwnedBinding, type StateHook } from './transplantStateCarry'
import { bakedStatementText, isDataValue, propDefaultOf, resolveRowBindings, type BakedSource, type RowRef } from './transplantPropBake'
import {
  declarationText,
  declaresIdentically,
  findLocalBinding,
  findModuleDeclaration,
  isComponentName,
  isModuleTypeName,
  namesInUse,
  type CarriableDeclaration,
} from './transplantScopeCarry'

/** One thing copied to the destination, for the notice the gesture shows. */
export interface CarriedDeclaration {
  /** The name it had in the origin. */
  name: string
  /** The name it has at the destination - different only after a clash. */
  as: string
  scope: 'body' | 'module'
  /** True when the destination already declared the identical thing, so nothing was written. */
  reused: boolean
  /**
   * `copy` - a plain constant or handler, the same bytes. `state` - a
   * `useState`/`useReducer`/`useRef` the destination now owns its own copy of
   * (G-1b). `value` - a row's item/index or a prop's default written down as a
   * literal constant (G-1c).
   */
  how: 'copy' | 'state' | 'value'
}

export interface CarryDestination {
  source: SourceFile
  file: string
  /** The destination component's body - where hooks and body-level declarations are written. Absent when it has none. */
  body?: Block
  /** The indent body-level declarations are written at (continuation lines; the first line sits at a statement start). */
  bodyIndent: string
  /** Why a state hook cannot be written into the destination component, when it cannot (`stateHookRefusal`). */
  hooksRefusal?: string
}

/** What the origin hands the carry beyond the markup itself (G-1c). Both are opt-in: absent, the value refuses by name. */
export interface CarryOrigin {
  /** The `.map` row the element is a copy of. */
  row?: RowRef
  /** Read a destructured prop's own default as its value. Only honest for an element written in the page's own file. */
  propDefaults?: boolean
}

export interface CarryRefusal {
  reason: 'captured-scope' | 'unexported-binding' | 'stale-source'
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
      /** True when `bodyStatements` holds a state hook - which must be written above any early return (`hookInsertionAnchor`). */
      hasState: boolean
      carried: CarriedDeclaration[]
    }
  | { ok: false; refusal: CarryRefusal }

type Pending =
  | {
      kind: 'declaration'
      name: string
      node: CarriableDeclaration
      /** Reads nothing but imports and globals - so an identical declaration already at the destination means the same thing. */
      leaf: boolean
    }
  /** A state statement: `used` are the slots the element (or a copied handler) reads. Never deduped - each copy is its own state. */
  | { kind: 'state'; state: StateHook; used: Set<string> }
  | { kind: 'value'; name: string; source: BakedSource; leaf: boolean }

type StatePending = Extract<Pending, { kind: 'state' }>

const OWNED_DESCRIPTION: Record<OwnedBinding['kind'], string> = {
  state: 'state',
  'hook-result': 'a hook result',
  prop: 'a prop',
  row: 'a list row',
  variable: 'a variable the component owns',
}

export function resolveCarriedBindings(
  subtree: Node,
  originSource: SourceFile,
  originText: string,
  destination: CarryDestination,
  origin: CarryOrigin = {},
): CarriedBindings {
  const { source: destinationSource, file: destinationFile, body: destinationBody } = destination
  const originComponent = enclosingFunctionComponent(subtree)
  const canCarryHooks = destinationBody !== undefined

  const requirements = new Map<string, ImportRequirement>()
  const hookGroups = new Map<CallExpression, HookCarryGroup>()
  /** name -> what it is, for the refusal sentence. */
  const captured = new Map<string, string>()
  const unexported: string[] = []
  const bodyDeclarations: Pending[] = []
  const moduleDeclarations: Pending[] = []
  const visited = new Set<string>()
  const stateStatements = new Map<Node, StatePending>()
  let staleRow: string | undefined

  // The row's item and index, resolved once and only when something reads them.
  let rowSources: Map<string, BakedSource> | undefined
  function rowSource(name: string): BakedSource | undefined {
    if (!origin.row) return undefined
    if (!rowSources) {
      const row = resolveRowBindings(subtree, originComponent, origin.row)
      if (!row.ok) staleRow = row.message
      rowSources = row.ok ? row.sources : new Map()
    }
    return rowSources.get(name)
  }

  /** A prop's own default, when it is data. A function default is behaviour: it is named, not copied. */
  function propDefault(name: string): BakedSource | 'function' | undefined {
    const initializer = origin.propDefaults && originComponent ? propDefaultOf(originComponent, name) : undefined
    if (!initializer) return undefined
    return isDataValue(initializer) ? { kind: 'node', node: initializer } : 'function'
  }

  function describeOwned(owned: OwnedBinding): string {
    return owned.kind === 'hook-result' ? `the result of ${owned.hook}()` : OWNED_DESCRIPTION[owned.kind]
  }

  /** Walks `root`'s free names; returns whether it reads only imports and globals. */
  function visit(root: Node, ownName: string | undefined): boolean {
    let leaf = true
    for (const variable of analyzeFreeVariables(root, originSource)) {
      const { name } = variable
      if (name === ownName) continue

      const kind = bindingKindAt(root, name, originSource)
      if (kind === 'none') {
        // A type the origin declares (`type Action = ...`) has no runtime to
        // share and nothing to import from a route file: it is copied, like a
        // constant. An enum or namespace has a runtime and no copy that means
        // the same thing. Anything else is declared nowhere in the file - a
        // global (`HTMLInputElement`, `setTimeout`) the destination sees too.
        if (isModuleTypeName(originSource, name)) {
          carryModuleDeclaration(name, false)
          leaf = false
        } else if (originSource.getEnum(name) ?? originSource.getModule(name)) {
          captured.set(name, 'an enum or namespace its file declares')
        }
        continue
      }
      if (kind === 'module') {
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
          captured.set(name, 'a hook result')
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
      if (local?.kind === 'declaration' && carryBodyDeclaration(name, local.statement)) {
        leaf = false
        continue
      }

      const owned: OwnedBinding = originComponent ? classifyOwned(originComponent, name, root) : { kind: 'variable' }
      if (owned.kind === 'state') {
        carryState(owned.state, name)
        leaf = false
        continue
      }
      const baked = owned.kind === 'row' ? rowSource(name) : owned.kind === 'prop' ? propDefault(name) : undefined
      if (baked && baked !== 'function') {
        carryValue(name, baked)
        leaf = false
        continue
      }
      captured.set(name, baked === 'function' ? 'a function prop' : describeOwned(owned))
    }
    return leaf
  }

  function carryBodyDeclaration(name: string, statement: CarriableDeclaration): boolean {
    const key = `body:${name}`
    if (visited.has(key)) return true
    visited.add(key)
    const leaf = visit(statement, name)
    bodyDeclarations.push({ kind: 'declaration', name, node: statement, leaf })
    return true
  }

  function carryModuleDeclaration(name: string, usedAsTag: boolean): boolean {
    const key = `module:${name}`
    if (visited.has(key)) return true
    const statement = findModuleDeclaration(originSource, name)
    // A component is never copied (two copies are two components); a type merely looks like one.
    if (!statement || usedAsTag || (isComponentName(name) && !isModuleTypeName(originSource, name))) return false
    visited.add(key)
    const leaf = visit(statement, name)
    moduleDeclarations.push({ kind: 'declaration', name, node: statement, leaf })
    return true
  }

  function carryState(state: StateHook, name: string): void {
    const existing = stateStatements.get(state.statement)
    if (existing) {
      existing.used.add(name)
      return
    }
    const pending: StatePending = { kind: 'state', state, used: new Set([name]) }
    stateStatements.set(state.statement, pending)
    visit(state.statement, undefined) // its initializer's own reads, carried first
    bodyDeclarations.push(pending)
  }

  function carryValue(name: string, source: BakedSource): void {
    const key = `value:${name}`
    if (visited.has(key)) return
    visited.add(key)
    const leaf = source.kind === 'node' ? visit(source.node, name) : true
    bodyDeclarations.push({ kind: 'value', name, source, leaf })
  }

  visit(subtree, undefined)

  if (staleRow !== undefined) {
    return { ok: false, refusal: { reason: 'stale-source', message: staleRow } }
  }
  if (captured.size > 0) {
    const names = [...captured].map(([name, what]) => `"${name}" (${what})`).join(', ')
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message:
          `It reads ${names}, which belong to the component it is written in and cannot follow it to another file. Keep it inside its own frame.`,
      },
    }
  }
  if (unexported.length > 0) {
    const name = unexported[0]!
    return {
      ok: false,
      refusal: {
        reason: 'unexported-binding',
        message: `It uses "${name}", which its file keeps private, so the other file cannot import it. Export "${name}" from its own file, then drag again.`,
      },
    }
  }
  const states = [...stateStatements.values()]
  if (states.length > 0 && (!destinationBody || destination.hooksRefusal)) {
    const names = states.flatMap((entry) => [...entry.used]).map((name) => `"${name}"`).join(', ')
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message:
          destinationBody && destination.hooksRefusal
            ? destination.hooksRefusal
            : `It uses the state ${names}, which needs a component to live in, and the place it is going to has none. Drop it into a component.`,
      },
    }
  }
  if (bodyDeclarations.length > 0 && !destinationBody) {
    const names = bodyDeclarations.map((declaration) => `"${pendingName(declaration)}"`).join(', ')
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message: `It reads ${names}, which need a component body, and the place it is going to has none. Drop it into a component that has a body.`,
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
          message: `This element reads \`${name}\` from ${group.hook.label}(), and the destination calls ${group.hook.label}() in a shape with no "${name}" to reuse. Give the destination a matching binding, then drag again.`,
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
  const takeName = (name: string): string => {
    const as = freshName(name, (candidate) => used.has(candidate))
    used.add(as)
    if (as !== name) renames.set(name, as)
    return as
  }
  const copy = (pending: Pending, scope: 'body' | 'module'): void => {
    const container = scope === 'module' ? destinationSource : destinationBody!
    const indent = scope === 'module' ? '' : destination.bodyIndent
    const out = scope === 'module' ? moduleStatements : bodyStatements
    if (pending.kind === 'state') {
      // Its own state, always: even an identical `useState(false)` the
      // destination already has is a DIFFERENT state, and reusing it would tie
      // the element to a value that was never its own.
      const slots = pending.state.slots.filter((slot) => pending.used.has(slot))
      const names = slots.map((slot) => ({ slot, as: takeName(slot) }))
      out.push(stateStatementText(pending.state, pending.used, originText, renames, indent))
      for (const { slot, as } of names) carried.push({ name: slot, as, scope, reused: false, how: 'state' })
      return
    }
    const render = (as: string): string =>
      pending.kind === 'value'
        ? bakedStatementText(pending.source, as, originText, renames, indent)
        : declarationText(pending.node, originText, renames, indent)
    const plain = render(pending.name)
    const how = pending.kind === 'value' ? 'value' : 'copy'
    if (pending.leaf && declaresIdentically(container, pending.name, plain)) {
      carried.push({ name: pending.name, as: pending.name, scope, reused: true, how })
      return
    }
    const as = takeName(pending.name)
    out.push(as === pending.name ? plain : render(as))
    carried.push({ name: pending.name, as, scope, reused: false, how })
  }
  for (const pending of moduleDeclarations) copy(pending, 'module')
  for (const pending of bodyDeclarations) copy(pending, 'body')

  return {
    ok: true,
    requirements: bindings.required,
    renames,
    hookEdits,
    hookStatements,
    bodyStatements,
    moduleStatements,
    hasState: states.length > 0,
    carried,
  }
}

function pendingName(pending: Pending): string {
  return pending.kind === 'state' ? [...pending.used].join(', ') : pending.name
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

