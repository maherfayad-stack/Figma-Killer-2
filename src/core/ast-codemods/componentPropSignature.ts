/**
 * componentPropSignature — adding one OPTIONAL prop to an existing
 * component's signature: the binding in its destructured first parameter, and
 * the property on whichever type surface that parameter uses. The one
 * implementation behind `addSlotPropToComponent` (a new slot, E2.2) and
 * `exposeLiteralAsProp` (an instance override, P5-C DET-7).
 *
 * Optional, always: N existing call sites already render the component
 * without passing it, and a REQUIRED prop would stop every one of them
 * compiling.
 *
 * The binding goes in front of a `...rest` element (a rest element must be
 * last — appending after it wrote a file that does not parse), and keeps every
 * existing element's own text verbatim.
 *
 * The type surface:
 *   - an inline type literal (`{ title }: { title: string }`) or a same-file
 *     `interface` / object `type` alias it references gains `name?: T`;
 *   - an untyped parameter gains nothing (a JS file, or TS that infers from a
 *     default) — "honest for JS": no guessed type;
 *   - a component with NO parameter gets a fresh destructured one, typed by a
 *     new `<Name>Props` interface in a TypeScript file;
 *   - anything else (a type from another file, an intersection, a generic)
 *     refuses: the caller reports `unsupported-props-type`.
 */
import { Node, type InterfaceDeclaration, type ParameterDeclaration, type SourceFile, type TypeLiteralNode } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'

export interface OptionalProp {
  /** The prop's name — its key in the props object. */
  name: string
  /** The destructured binding, verbatim: `name`, or `name = 'default'`. */
  binding: string
  /** The TypeScript type written for it: `ReactNode`, `string`, … */
  type: string
  /** A type-only import the type needs (`ReactNode` from `react`) — added only when a type is actually written. */
  typeImport?: { name: string; module: string }
}

export type SignatureEditOutcome = { ok: true } | { ok: false; message: string }

function ensureTypeImport(sourceFile: SourceFile, typeImport: OptionalProp['typeImport']): void {
  if (!typeImport) return
  const already = sourceFile
    .getImportDeclarations()
    .some((d) => d.getModuleSpecifierValue() === typeImport.module && d.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === typeImport.name))
  if (already) return
  sourceFile.addImportDeclaration({ moduleSpecifier: typeImport.module, namedImports: [typeImport.name], isTypeOnly: true })
}

function pascalCaseFromFileBase(base: string): string {
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** `fn`'s own name when it has one (`FunctionDeclaration`), else the file base — an arrow function assigned to a `const` carries no name of its own to recover. */
function deriveComponentTypeName(sourceFile: SourceFile, fn: FunctionLike): string {
  const named = Node.hasName(fn) ? fn.getName() : undefined
  const base = named ?? pascalCaseFromFileBase(sourceFile.getBaseNameWithoutExtension())
  return `${base}Props`
}

function addFreshParameter(sourceFile: SourceFile, fn: FunctionLike, prop: OptionalProp): SignatureEditOutcome {
  if (!/\.tsx?$/.test(sourceFile.getFilePath())) {
    fn.addParameter({ name: `{ ${prop.binding} }` })
    return { ok: true }
  }
  const typeName = deriveComponentTypeName(sourceFile, fn)
  ensureTypeImport(sourceFile, prop.typeImport)
  sourceFile.addInterface({ isExported: true, name: typeName, properties: [{ name: prop.name, type: prop.type, hasQuestionToken: true }] })
  fn.addParameter({ name: `{ ${prop.binding} }`, type: typeName })
  return { ok: true }
}

/**
 * `name?: T` on an object type. A body written on ONE line stays on one line
 * (`{ title: string; heading?: string }`) — ts-morph's `addProperty` would
 * break it across lines; a multi-line body gets `addProperty`'s own layout.
 */
function addMember(sourceFile: SourceFile, shape: TypeLiteralNode | InterfaceDeclaration, member: { name: string; type: string }): void {
  const members = shape.getMembers()
  const body = Node.isInterfaceDeclaration(shape) ? sourceFile.getFullText().slice(members[0]?.getStart() ?? shape.getEnd(), shape.getEnd()) : shape.getText()
  const oneLine = !/[\r\n]/.test(body)
  if (!oneLine) {
    shape.addProperty({ name: member.name, type: member.type, hasQuestionToken: true })
    return
  }
  const text = `${member.name}?: ${member.type}`
  // Rewrite the shape's own text only: every node outside it stays valid for
  // the caller (a whole-file `insertText` would forget them all).
  const own = shape.getText()
  const at = (offset: number) => offset - shape.getStart()
  const last = members.at(-1)
  if (!last) {
    const close = own.lastIndexOf('}')
    shape.replaceWithText(`${own.slice(0, close)} ${text} ${own.slice(close)}`)
    return
  }
  const lastText = last.getText()
  const addition = lastText.endsWith(';') || lastText.endsWith(',') ? ` ${text}${lastText.slice(-1)}` : `; ${text}`
  const split = at(last.getEnd())
  shape.replaceWithText(own.slice(0, split) + addition + own.slice(split))
}

function addToExistingParameter(sourceFile: SourceFile, first: ParameterDeclaration, prop: OptionalProp): SignatureEditOutcome {
  const pattern = first.getNameNode()
  if (Node.isObjectBindingPattern(pattern)) {
    const elements = pattern.getElements().map((element) => ({ text: element.getText(), rest: element.getDotDotDotToken() !== undefined }))
    const rest = elements.findIndex((element) => element.rest)
    const texts = elements.map((element) => element.text)
    texts.splice(rest < 0 ? texts.length : rest, 0, prop.binding)
    pattern.replaceWithText(`{ ${texts.join(', ')} }`)
  }

  const typeNode = first.getTypeNode()
  if (!typeNode) return { ok: true }

  const member = { name: prop.name, type: prop.type }
  if (Node.isTypeLiteral(typeNode)) {
    ensureTypeImport(sourceFile, prop.typeImport)
    addMember(sourceFile, typeNode, member)
    return { ok: true }
  }
  if (Node.isTypeReference(typeNode)) {
    const typeName = typeNode.getTypeName().getText()
    const iface = sourceFile.getInterface(typeName)
    const alias = sourceFile.getTypeAlias(typeName)
    const aliasType = alias?.getTypeNode()
    if (iface) {
      ensureTypeImport(sourceFile, prop.typeImport)
      addMember(sourceFile, iface, member)
      return { ok: true }
    }
    if (aliasType && Node.isTypeLiteral(aliasType)) {
      ensureTypeImport(sourceFile, prop.typeImport)
      addMember(sourceFile, aliasType, member)
      return { ok: true }
    }
    return { ok: false, message: `Could not find "${typeName}"'s own declaration in this file to add a "${prop.name}" property to.` }
  }
  return { ok: false, message: "This component's props type is not a plain object shape Studio can add a property to." }
}

/**
 * Adds `prop` to `fn`'s signature — a fresh parameter when it has none, or a
 * new binding (and type property) on its existing destructured one. The
 * caller has already refused an undestructured `props` parameter.
 */
export function addOptionalPropToSignature(sourceFile: SourceFile, fn: FunctionLike, prop: OptionalProp): SignatureEditOutcome {
  const first = fn.getParameters()[0]
  if (!first) return addFreshParameter(sourceFile, fn, prop)
  return addToExistingParameter(sourceFile, first, prop)
}
