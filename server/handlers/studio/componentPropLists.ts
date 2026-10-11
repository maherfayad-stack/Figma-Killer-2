/**
 * componentPropLists - the two facts `componentSpecExtract.ts` reads about a
 * component's LIST props: which declared types are lists, and which number
 * prop is "the current entry" of one.
 */
import { SyntaxKind, type TypeNode } from 'ts-morph'
import { INDEX_PROP_NAME_RE, pickIndexedCollection } from '@core/utils/collectionIndexNames'
import type { PropSpec } from './packageManifestSchema'

/** `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>` - a list the call site passes whole. */
export function isArrayTypeNode(node: TypeNode): boolean {
  if (node.getKind() === SyntaxKind.ArrayType) return true
  if (node.getKind() === SyntaxKind.TypeOperator) {
    const operand = node.asKindOrThrow(SyntaxKind.TypeOperator).getTypeNode()
    return operand.getKind() === SyntaxKind.ArrayType
  }
  if (node.getKind() === SyntaxKind.TypeReference) {
    const typeName = node.asKindOrThrow(SyntaxKind.TypeReference).getTypeName().getText()
    return typeName === 'Array' || typeName === 'ReadonlyArray'
  }
  return false
}

/**
 * A number named like a selection, next to ONE list the component takes, is an
 * index into that list: the panel then offers the list's own entries to choose
 * from instead of a bare number (`collectionIndex`, the same kind the built-in
 * design system's manifest records). See `collectionIndexNames.ts` for the rule.
 */
export function markCollectionIndexes(props: PropSpec[]): PropSpec[] {
  const target = pickIndexedCollection(props.filter((prop) => prop.kind.kind === 'collection').map((prop) => prop.name))
  if (target === undefined) return props
  return props.map((prop) =>
    prop.kind.kind === 'number' && INDEX_PROP_NAME_RE.test(prop.name) ? { ...prop, kind: { kind: 'collectionIndex', collection: target } } : prop,
  )
}
