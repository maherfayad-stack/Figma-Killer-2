/**
 * transplantCarry — how a binding a cross-file transplant carries changes
 * SPELLING at the destination, split out of `transplantJsxElement.ts` to keep
 * that module under the repo's module-size ceiling (`module-size-budgets.test.ts`).
 * `resolveCarriedBindings` (the caller, in `transplantJsxElement.ts`) owns
 * everything ABOUT the decision — which free names travel, whether a hook is
 * movable at all, the import-aliasing plan — and calls into this module for
 * the two mechanics that decision needs:
 *
 *  - **`materializeHookGroup`** — re-establishing ONE context-hook call at
 *    the destination. A captured free variable bound by a movable
 *    context-reader hook (`const { t } = useLanguage()`, DET-3's shape — see
 *    `detachHooks.ts`) travels across a cross-file move by re-establishing
 *    the CALL at the destination rather than refusing `captured-scope`:
 *    reused when the destination component already makes an identical call,
 *    otherwise written as its first statement.
 *  - **`applySubtreeRenames`** / **`moduleDerivedAlias`** — once a name
 *    can't travel unchanged (a hook-bound local resolved to whatever the
 *    destination's call gives it, or an import aliased away from a
 *    collision), every occurrence inside the moved subtree is re-pointed to
 *    its new spelling; the alias itself prefers a name derived from the
 *    carried module (`sheetStyles` beats `styles2` for two CSS modules both
 *    locally called `styles`).
 */
import { Node, SyntaxKind, type Block, type ObjectBindingPattern, type SourceFile } from 'ts-morph'
import { applyTextEdits, type TextEdit } from './jsxChildRange'
import { lineIndentAt } from './jsxChildPlacement'
import type { ComponentHook } from './detachHooks'
import { freeVariableReferenceRanges } from './subtreeFreeVariables'
import * as path from 'node:path'
import type { ImportRequirement } from './jsxImportEdits'

/**
 * One distinct hook call the moved subtree needs re-established at the
 * destination, and which captured names read from it (`undefined` key means
 * "the whole value", not one field of it).
 */
export interface HookCarryGroup {
  hook: ComponentHook
  names: Map<string, string | undefined>
}

export interface MaterializedHookGroup {
  /** Free-variable name -> the text it now reads instead of its own bare name. */
  reads: Map<string, string>
  edits: TextEdit[]
  /** The new `const … = hook(…)` statement `edits` writes; absent when an existing call was reused. */
  statement?: string
}

/** How an already-written top-level `const` reads, when it calls the same hook this group needs. */
type ExistingHookBinding =
  | { kind: 'whole'; local: string }
  | { kind: 'keys'; keys: Map<string, string>; pattern: ObjectBindingPattern }

/** An existing top-level `const <pattern> = calleeLocal(sameArgs)` in the destination's own component body, when there is one. */
function findExistingHookCall(body: Block, calleeLocal: string, argsText: string): ExistingHookBinding | undefined {
  for (const statement of body.getStatements()) {
    if (!Node.isVariableStatement(statement)) continue
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer()
      if (!init || !Node.isCallExpression(init)) continue
      const callee = init.getExpression()
      if (!Node.isIdentifier(callee) || callee.getText() !== calleeLocal) continue
      if (init.getArguments().map((a) => a.getText()).join(', ') !== argsText) continue
      const nameNode = decl.getNameNode()
      if (Node.isIdentifier(nameNode)) return { kind: 'whole', local: nameNode.getText() }
      if (
        Node.isObjectBindingPattern(nameNode) &&
        nameNode.getElements().every((e) => !e.getDotDotDotToken() && !e.getInitializer() && Node.isIdentifier(e.getNameNode()))
      ) {
        const keys = new Map<string, string>()
        for (const element of nameNode.getElements()) {
          const property = element.getPropertyNameNode()
          keys.set(property ? property.getText() : element.getName(), element.getName())
        }
        return { kind: 'keys', keys, pattern: nameNode }
      }
    }
  }
  return undefined
}

function spellKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

/** The first name in `used` (a source file's own identifiers) that `preferred` doesn't already mean — `preferred` itself when it's free. */
function freshLocalName(preferred: string, used: ReadonlySet<string>): string {
  if (!used.has(preferred)) return preferred
  for (let n = 2; ; n += 1) {
    const candidate = `${preferred}${n}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Re-establishes ONE hook call at the destination — reusing an identical
 * existing call if the destination's own component already makes one,
 * otherwise writing a new top-level `const` as the component's first
 * statement — and reports how each captured name now reads.
 */
export function materializeHookGroup(
  destinationSource: SourceFile,
  destinationBody: Block,
  calleeLocal: string,
  group: HookCarryGroup,
): MaterializedHookGroup {
  const argsText = group.hook.call.getArguments().map((a) => a.getText()).join(', ')
  const existing = findExistingHookCall(destinationBody, calleeLocal, argsText)
  const used = new Set(destinationSource.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()))

  if (existing) {
    const reads = new Map<string, string>()
    const edits: TextEdit[] = []
    for (const [name, key] of group.names) {
      if (existing.kind === 'whole') {
        if (key === undefined) reads.set(name, existing.local)
        else reads.set(name, /^[A-Za-z_$][\w$]*$/.test(key) ? `${existing.local}.${key}` : `${existing.local}[${JSON.stringify(key)}]`)
        continue
      }
      if (key === undefined) continue // a whole-value read against a destructuring call has no field to reuse — falls through unresolved, caught by the caller
      let local = existing.keys.get(key)
      if (local === undefined) {
        local = freshLocalName(key, used)
        used.add(local)
        existing.keys.set(key, local)
        const elements = existing.pattern.getElements()
        const last = elements.at(-1)
        const element = local === key ? local : `${spellKey(key)}: ${local}`
        edits.push(
          last
            ? { start: last.getEnd(), end: last.getEnd(), text: `, ${element}` }
            : { start: existing.pattern.getStart() + 1, end: existing.pattern.getStart() + 1, text: ` ${element} ` },
        )
      }
      reads.set(name, local)
    }
    return { reads, edits }
  }

  const reads = new Map<string, string>()
  let pattern: string
  if (group.hook.binding.kind === 'whole') {
    const [[name]] = group.names
    const local = freshLocalName(group.hook.binding.local, used)
    reads.set(name, local)
    pattern = local
  } else {
    const parts: string[] = []
    for (const key of group.hook.binding.keys) {
      const capturedName = [...group.names.entries()].find(([, k]) => k === key.key)?.[0]
      if (!capturedName) continue
      const local = freshLocalName(key.local, used)
      used.add(local)
      reads.set(capturedName, local)
      parts.push(local === key.key ? local : `${spellKey(key.key)}: ${local}`)
    }
    pattern = `{ ${parts.join(', ')} }`
  }

  const fullText = destinationSource.getFullText()
  const first = destinationBody.getStatements()[0]
  const insertAt = first ? first.getStart() : destinationBody.getEnd() - 1
  const indent = first
    ? lineIndentAt(fullText, first.getStart())
    : `${lineIndentAt(fullText, destinationBody.getStart())}  `
  const statement = `const ${pattern} = ${calleeLocal}(${argsText})`
  const text = first ? `${statement}\n${indent}` : `${indent}${statement}\n`
  return { reads, edits: [{ start: insertAt, end: insertAt, text }], statement }
}

/**
 * `renames` re-points every occurrence of a name the subtree can no longer
 * carry unchanged — a hook-bound local resolved to whatever the destination's
 * re-established call gives it, or an import aliased away from a collision
 * (`planImportBindings`) — onto its new spelling. Everything else in the
 * subtree's own bytes is untouched, exactly as `transplantJsxElement.ts`'s
 * own doc describes for the un-renamed case.
 */
export function applySubtreeRenames(text: string, elementStart: number, root: Node, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return text
  const edits: TextEdit[] = []
  for (const [name, replacement] of renames) {
    for (const range of freeVariableReferenceRanges(root, name)) {
      edits.push({ start: range.start - elementStart, end: range.end - elementStart, text: replacement })
    }
  }
  return edits.length > 0 ? applyTextEdits(text, edits) : text
}

/**
 * A local name derived from the module a default/namespace import comes
 * from — tried before the plain `${name}2`, `${name}3`… sequence
 * `planImportBindings` otherwise reaches for. Two CSS modules both locally
 * called `styles` read a lot better as `sheetStyles` than `styles2`; falls
 * through to the numbered sequence when the specifier's basename isn't a
 * usable identifier fragment.
 */
export function moduleDerivedAlias(name: string, requirement: ImportRequirement): string | undefined {
  if (requirement.style !== 'default' && requirement.style !== 'namespace') return undefined
  const base = path
    .basename(requirement.specifier)
    .replace(/\.[^./]+$/, '')
    .replace(/\.module$/i, '')
  if (!/^[A-Za-z_$][\w$]*$/.test(base)) return undefined
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}
