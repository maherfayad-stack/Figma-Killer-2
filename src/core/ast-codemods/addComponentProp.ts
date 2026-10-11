/**
 * addComponentProp — add ONE optional prop with a default to an existing local
 * component: a boolean, a text, or a variant (a string-literal union). Figma's
 * "Add property", written into the component's own signature.
 *
 *     export function Badge({ label }: { label: string })
 * becomes
 *     export function Badge({ label, solid = false }: { label: string; solid?: boolean })
 *
 * Optional and defaulted, always: N existing call sites already render the
 * component without passing the prop, and the default is what they render
 * today. Nothing is written at any call site, and the prop is not yet read by
 * the markup — consuming it is the author's next step (or the next Add
 * variant), exactly as adding a prop to a function signature is in code.
 *
 * The signature edit is `componentPropSignature.ts`'s (shared with Add slot):
 * the binding goes in front of a `...rest`, the type lands on the inline type
 * literal or the same-file interface/alias the parameter names, an untyped
 * parameter (a JS file) gains the binding alone, and a component with no
 * parameter gets a fresh typed one. Anything else — an undestructured `props`,
 * a props type from another file — refuses by name.
 *
 * Text in, text out: the caller reads the file, hands the LF text here and
 * writes what comes back. Parse, never execute.
 */
import { Project, type SourceFile } from 'ts-morph'
import { VARIANT_NAME_PATTERN } from '@core/component-variants'
import { findComponentDeclaration, findNamedComponentDeclaration, getFunctionLikeNode } from '@core/page-parser'
import { addOptionalPropToSignature, type OptionalProp } from './componentPropSignature'
import { buildParamBindings } from './detachComponent'
import { introducesSyntaxErrors } from './syntaxRegression'

export type NewComponentProp =
  | { kind: 'boolean'; name: string; defaultValue: boolean }
  | { kind: 'text'; name: string; defaultValue: string }
  | { kind: 'variant'; name: string; members: readonly string[] }

export type AddComponentPropRefusalReason =
  | 'invalid-prop-name'
  | 'prop-exists'
  | 'not-found'
  | 'unsupported-params'
  | 'unsupported-props-type'
  | 'invalid-variant-name'
  | 'invalid-default'

export interface AddComponentPropRefusal {
  reason: AddComponentPropRefusalReason
  message: string
}

export type AddComponentPropResult = { ok: true; source: string } | { ok: false; refusal: AddComponentPropRefusal }

const PROP_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** `key`/`ref` are React's own; the rest are words a destructuring cannot bind. */
const RESERVED_PROP_NAMES: ReadonlySet<string> = new Set(
  (
    'key ref children class default new delete function var let const return if else for while do switch case ' +
    'break continue this null true false typeof void with yield await enum export import super try catch throw ' +
    'in instanceof debugger extends finally'
  ).split(' '),
)

function refuse(reason: AddComponentPropRefusalReason, message: string): { ok: false; refusal: AddComponentPropRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/** The quote the file already writes string literals with (its first import's), else a single quote. */
function quoteOf(sourceFile: SourceFile): string {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const first = declaration.getModuleSpecifier().getText().charAt(0)
    if (first === '"' || first === "'") return first
  }
  return "'"
}

function literal(value: string, quote: string): string {
  return `${quote}${value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`).replace(/\r?\n/g, '\\n')}${quote}`
}

function describe(prop: NewComponentProp, quote: string): OptionalProp | AddComponentPropRefusal {
  if (prop.kind === 'boolean') return { name: prop.name, binding: `${prop.name} = ${prop.defaultValue}`, type: 'boolean' }
  if (prop.kind === 'text') {
    if (prop.defaultValue.length > 200) return { reason: 'invalid-default', message: 'The default text is too long to write into a signature. Use a shorter default.' }
    return { name: prop.name, binding: `${prop.name} = ${literal(prop.defaultValue, quote)}`, type: 'string' }
  }
  const members = [...new Set(prop.members)]
  if (members.length < 2) return { reason: 'invalid-variant-name', message: 'A variant property needs at least two values. Add a second value.' }
  const bad = members.find((member) => !VARIANT_NAME_PATTERN.test(member))
  if (bad !== undefined) {
    return { reason: 'invalid-variant-name', message: `"${bad}" is not a usable variant name. Start with a letter, then use letters, digits, "-" or "_".` }
  }
  return {
    name: prop.name,
    binding: `${prop.name} = ${literal(members[0]!, quote)}`,
    type: members.map((member) => literal(member, quote)).join(' | '),
  }
}

/** `exportName` is `'default'` or a named export (`LocalComponentSpec.exportName`). */
export function addComponentProp(fileName: string, source: string, exportName: string, prop: NewComponentProp): AddComponentPropResult {
  if (!PROP_NAME.test(prop.name) || RESERVED_PROP_NAMES.has(prop.name)) {
    return refuse('invalid-prop-name', `"${prop.name}" cannot be used as a prop name. Use a plain identifier that is not a reserved word.`)
  }
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = scratch.createSourceFile(fileName.replace(/^.*[\\/]/, '') || 'component.tsx', source)

  const declaration = exportName === 'default' ? findComponentDeclaration(sourceFile) : findNamedComponentDeclaration(sourceFile, exportName, true)
  const fn = declaration ? getFunctionLikeNode(declaration) : undefined
  if (!fn) return refuse('not-found', `The component "${exportName}" is no longer in this file. Reload the project and try again.`)

  const { childrenParam, params, hasUndestructuredParam } = buildParamBindings(fn)
  if (hasUndestructuredParam) {
    return refuse('unsupported-params', `"${exportName}" takes an undestructured props parameter, so a named prop cannot be added. Destructure its props in the code first.`)
  }
  const taken = new Set([...params.values()].map((binding) => binding.attrName).concat([...params.keys()]))
  if (childrenParam) taken.add('children')
  if (taken.has(prop.name)) return refuse('prop-exists', `"${exportName}" already has a "${prop.name}" prop. Pick another name.`)

  const optional = describe(prop, quoteOf(sourceFile))
  if ('reason' in optional) return { ok: false, refusal: optional }
  const outcome = addOptionalPropToSignature(sourceFile, fn, optional)
  if (!outcome.ok) return refuse('unsupported-props-type', outcome.message)

  const next = sourceFile.getFullText()
  if (introducesSyntaxErrors(fileName, source, next)) {
    return refuse('unsupported-props-type', 'Writing that prop would leave the component unparseable. Make this change in the code.')
  }
  return { ok: true, source: next }
}
