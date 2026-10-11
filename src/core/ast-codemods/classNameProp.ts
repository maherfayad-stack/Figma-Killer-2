/**
 * classNameProp — makes a component's ROOT element accept the `className` its
 * call site passes (G-2b: a class edit made to one instance travels as a
 * modifier class on the call site, so the root must put it on the element).
 *
 *     export function Card({ title }: { title: string }) {
 *       return <div className="card">{title}</div>
 *     }
 *
 * becomes
 *
 *     export function Card({ title, className }: { title: string; className?: string }) {
 *       return <div className={cn("card", className)}>{title}</div>
 *     }
 *
 * The join follows the file's own idiom: `cn(...)` (or `clsx`, `classNames`,
 * `classnames`) when one is in scope, a template otherwise. An optional prop is
 * `undefined` when nobody passes it, so a template guards it
 * (`${className || ''}`); a call to a join helper drops it by itself.
 *
 * What is NOT done, by name, because it would change what some other instance
 * renders or what the component means:
 *   - `unsupported-params` — an undestructured `props` parameter.
 *   - `unsupported-props-type` — the props type cannot take another property.
 *   - `class-prop-elsewhere` — the component already takes `className` and puts
 *     it on another element; a second use would double it.
 *   - `class-prop-conflict` — `className` already names something else in it.
 *   - `class-spread-root` — the root spreads an object of props, which would
 *     replace (or be replaced by) the root's own class.
 *   - `unsupported-class-expression` — the root's `className` is a shape that
 *     is not a class string.
 *
 * Everything here edits the in-memory source file; the caller saves it.
 */
import { Node, SyntaxKind, type JsxAttribute, type SourceFile } from 'ts-morph'
import { CLASS_NAME_JOIN_BUILTIN_NAMES, paramReadCount, type FunctionLike } from '@core/page-parser'
import { isWrappableClassExpression, joinerInScope } from './classNameWrap'
import { addOptionalPropToSignature } from './componentPropSignature'
import { buildParamBindings } from './detachComponent'
import { functionAtIndex, functionLikesOf, isTypedThroughVariable } from './exposeLiteralSites'
import { topLevelBindingNames } from './importReconcile'
import type { JsxOpeningLikeElement } from './locateJsxElement'

export type ClassNamePropRefusalReason =
  | 'unsupported-params'
  | 'unsupported-props-type'
  | 'class-prop-elsewhere'
  | 'class-prop-conflict'
  | 'class-spread-root'
  | 'unsupported-class-expression'

export type ClassNamePropResult =
  | { ok: true; /** The component already passed `className` to its root: nothing was edited. */ changed: boolean }
  | { ok: false; reason: ClassNamePropRefusalReason; message: string }

const PROP = 'className'

function refusal(reason: ClassNamePropRefusalReason, message: string): ClassNamePropResult {
  return { ok: false, reason, message }
}

/** The identifier `className` read as a VALUE anywhere in `scope` (not an attribute name, not a property key). */
function readsClassName(scope: Node, local: string): boolean {
  return scope.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
    if (id.getText() !== local) return false
    const parent = id.getParent()
    if (Node.isJsxAttribute(parent) && parent.getNameNode() === id) return false
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return false
    return true
  })
}

/** A string literal's text safe to place inside a template literal untouched. */
function templateSafe(value: string): boolean {
  return !/[`\\]|\$\{/.test(value)
}

/** The new initializer for the root's class attribute, or a refusal. `text` is the full `{...}` container. */
function mergedInitializer(attribute: JsxAttribute, sourceFile: SourceFile): { text: string } | { refusal: ClassNamePropResult } {
  const joiner = joinerInScope(sourceFile)
  const initializer = attribute.getInitializer()
  const expr = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined
  const staticText = initializer && Node.isStringLiteral(initializer) ? initializer : expr && (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) ? expr : undefined

  if (staticText) {
    const value = staticText.getLiteralValue()
    if (joiner) return { text: `{${joiner}(${staticText.getText()}, ${PROP})}` }
    if (templateSafe(value)) return { text: '{`' + value + ' ${' + PROP + " || ''}`}" }
    return { text: `{[${staticText.getText()}, ${PROP}].filter(Boolean).join(' ')}` }
  }
  if (!expr) {
    return { refusal: refusal('unsupported-class-expression', 'This element\'s className has no value Studio can join a class onto.') }
  }
  if (Node.isTemplateExpression(expr)) {
    if (joiner) return { text: `{${joiner}(${expr.getText()}, ${PROP})}` }
    return { text: '{' + expr.getText().slice(0, -1) + ' ${' + PROP + " || ''}`}" }
  }
  if (!isWrappableClassExpression(expr)) {
    return { refusal: refusal('unsupported-class-expression', `This element's className ("${expr.getText()}") is not a class string, so Studio did not join another class onto it.`) }
  }
  const callee = Node.isCallExpression(expr) ? expr.getExpression() : undefined
  if (Node.isCallExpression(expr) && callee && Node.isIdentifier(callee) && CLASS_NAME_JOIN_BUILTIN_NAMES.has(callee.getText())) {
    // `cn(a, b)` already drops a missing class: one more argument is the whole edit.
    return { text: `{${callee.getText()}(${[...expr.getArguments().map((arg) => arg.getText()), PROP].join(', ')})}` }
  }
  if (joiner) return { text: `{${joiner}(${expr.getText()}, ${PROP})}` }
  const guard = Node.isPropertyAccessExpression(expr) ? expr.getText() : `(${expr.getText()}) || ''`
  return { text: '{`${' + guard + '} ${' + PROP + " || ''}`}" }
}

/**
 * Makes `root` (the root element of `fn`) take `className` from its caller.
 * `root` must be a location in `sourceFile`, which holds `fn`.
 */
export function ensureRootTakesClassName(sourceFile: SourceFile, fn: FunctionLike, root: JsxOpeningLikeElement): ClassNamePropResult {
  const { params, hasUndestructuredParam } = buildParamBindings(fn)
  if (hasUndestructuredParam) {
    return refusal('unsupported-params', 'This component takes its props as one object, so Studio can\'t add a named className without rewriting every "props.x".')
  }
  const first = fn.getParameters()[0]
  const attribute = root.getAttribute('className')
  const spreadOnRoot = root.getAttributes().some((attr) => Node.isJsxSpreadAttribute(attr))

  const existing = [...params].find(([, binding]) => binding.attrName === PROP)
  if (existing) {
    const local = existing[0]
    const onRoot = attribute !== undefined && Node.isJsxAttribute(attribute) && readsClassName(attribute, local)
    if (onRoot) return { ok: true, changed: false }
    if (paramReadCount(fn, local) > 0) {
      return refusal('class-prop-elsewhere', 'This component already uses its className prop on another element, so passing a class to its root would apply it twice.')
    }
  } else {
    if (spreadOnRoot) {
      return refusal('class-spread-root', "This component spreads an object of props onto its root, so a className would replace the root's own class rather than join it.")
    }
    const used = readsClassName(fn, PROP) || topLevelBindingNames(sourceFile).has(PROP)
    if (used) return refusal('class-prop-conflict', '`className` already means something else in this component, so Studio did not add it as a prop.')
  }
  const local = existing?.[0] ?? PROP

  if (attribute !== undefined && !Node.isJsxAttribute(attribute)) {
    return refusal('class-spread-root', 'The root\'s className is a spread, which Studio cannot join a class onto.')
  }
  const merged = attribute === undefined ? { text: `{${local}}` } : mergedInitializer(attribute, sourceFile)
  if ('refusal' in merged) return merged.refusal
  const text = local === PROP ? merged.text : merged.text.replaceAll(PROP, local)

  if (!existing) {
    if (/\.tsx?$/.test(sourceFile.getFilePath()) && isTypedThroughVariable(fn) && !first?.getTypeNode()) {
      return refusal('unsupported-props-type', "This component's props are typed through its variable (like FC<Props>), which Studio can't add a property to safely.")
    }
  }

  // Edit the root's attribute first, then the signature: the signature edit
  // replaces text above the root and forgets every node below it.
  const fnIndex = functionLikesOf(sourceFile).indexOf(fn)
  if (attribute === undefined) root.addAttribute({ name: PROP, initializer: text })
  else attribute.setInitializer(text)
  if (!existing) {
    const outcome = addOptionalPropToSignature(sourceFile, functionAtIndex(sourceFile, fnIndex), { name: PROP, binding: PROP, type: 'string' })
    if (!outcome.ok) return refusal('unsupported-props-type', outcome.message)
  }
  return { ok: true, changed: true }
}
