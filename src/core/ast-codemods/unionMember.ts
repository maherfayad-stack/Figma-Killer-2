/**
 * unionMember — add a member to, or take one out of, a string-literal union
 * (`type Variant = 'primary' | 'ghost'`, or the same union written inline in a
 * props type), as a byte-exact splice of the file's own text.
 *
 * The AST only LOCATES. The caller names the literal that already defines one
 * member (the variant read model's `members[].origin`), this module finds the
 * union that literal sits in, and the edit is written in that union's own
 * spelling:
 *
 *   - **add** inserts after the LAST string-literal member, using the same
 *     separator the last two members already have (` | `, a newline and a
 *     leading `|`, or a trailing `|`) and the same quote. A multi-line union
 *     keeps a comment that trails its last line where it was.
 *   - **remove** deletes the member and exactly one separator, plus the
 *     comment that trailed it on a multi-line union.
 *
 * Both verify before they edit: the text at the given position must be a
 * string-literal type with the expected value that is a direct member of a
 * union. A position that fails that (the file changed since it was read, the
 * literal is not in a union) refuses by name; nothing is guessed.
 *
 * Parse, never execute: the union is read as syntax. A union written as
 * `keyof typeof X`, a mapped type, or an imported package type has no literal
 * to point at and is never reached.
 */
import { Node, Project, type SourceFile, type UnionTypeNode } from 'ts-morph'
import { VARIANT_NAME_PATTERN } from '@core/component-variants'
import { introducesSyntaxErrors } from './syntaxRegression'
import { offsetOfLineColumn, type TextSplice } from '@core/utils/textSplice'

export type UnionMemberRefusalReason = 'invalid-variant-name' | 'variant-exists' | 'stale-source' | 'not-a-union' | 'last-member'

export interface UnionMemberRefusal {
  reason: UnionMemberRefusalReason
  message: string
}

export type UnionMemberEdit = { ok: true; splice: TextSplice } | { ok: false; refusal: UnionMemberRefusal }

/** Where an existing member's literal starts (1-based, the variant read model's `origin`), and what it says. */
export interface UnionMemberLocation {
  line: number
  column: number
  /** The member's value — checked against the text at the position. */
  name: string
}

function refuse(reason: UnionMemberRefusalReason, message: string): { ok: false; refusal: UnionMemberRefusal } {
  return { ok: false, refusal: { reason, message } }
}

function parseScratch(fileName: string, source: string): SourceFile {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return scratch.createSourceFile(fileName.replace(/^.*[\\/]/, '') || 'union.tsx', source)
}

interface LocatedUnion {
  union: UnionTypeNode
  literal: Node
  members: Node[]
}

function locateUnion(sourceFile: SourceFile, source: string, at: UnionMemberLocation): LocatedUnion | UnionMemberRefusal {
  const stale: UnionMemberRefusal = {
    reason: 'stale-source',
    message: `'${at.name}' is no longer where the board read it. Reload the project and try again.`,
  }
  const offset = offsetOfLineColumn(source, at.line, at.column)
  if (offset === null) return stale
  const node = sourceFile.getDescendantAtPos(offset)
  const literal = node?.getParent()
  if (!node || !literal || !Node.isLiteralTypeNode(literal) || literal.getStart() !== offset) return stale
  const value = literal.getLiteral()
  if (!Node.isStringLiteral(value) || value.getLiteralText() !== at.name) return stale
  const union = literal.getParent()
  if (!union || !Node.isUnionTypeNode(union)) {
    return { reason: 'not-a-union', message: `'${at.name}' is not one member of a union type, so a member cannot be added or removed. Edit the type in the code.` }
  }
  return { union, literal, members: union.getTypeNodes() }
}

/** The value of a string-literal type member, or `undefined` for any other member. */
function stringMemberValue(node: Node): string | undefined {
  if (!Node.isLiteralTypeNode(node)) return undefined
  const literal = node.getLiteral()
  return Node.isStringLiteral(literal) ? literal.getLiteralText() : undefined
}

function isStringLiteralMember(node: Node): boolean {
  return stringMemberValue(node) !== undefined
}

/** The end of the line `offset` is on (the offset of its `\n`, or the text length). */
function lineEndOf(source: string, offset: number): number {
  const next = source.indexOf('\n', offset)
  return next === -1 ? source.length : next
}

const TRAILING_COMMENT = /^[ \t]*(\/\/.*)?$/

/**
 * The splice that appends `name` to the union `existing` belongs to. `fileName`
 * decides the grammar (`.ts` vs `.tsx`); `source` is the LF-normalised text the
 * position was read against.
 */
export function addUnionMember(fileName: string, source: string, existing: UnionMemberLocation, name: string): UnionMemberEdit {
  if (!VARIANT_NAME_PATTERN.test(name)) {
    return refuse('invalid-variant-name', `"${name}" is not a usable variant name. Start with a letter, then use letters, digits, "-" or "_".`)
  }
  const sourceFile = parseScratch(fileName, source)
  const located = locateUnion(sourceFile, source, existing)
  if ('reason' in located) return { ok: false, refusal: located }

  const literals = located.members.filter(isStringLiteralMember)
  if (literals.some((member) => stringMemberValue(member) === name)) {
    return refuse('variant-exists', `"${name}" is already a member of this type. Pick a different name.`)
  }
  const last = literals.at(-1)
  const beforeLast = literals.at(-2)
  if (!last || !beforeLast) return refuse('not-a-union', 'A union with a single literal member cannot be extended without guessing its layout. Edit the type in the code.')

  const quote = source.charAt(last.getStart())
  const separator = source.slice(beforeLast.getEnd(), last.getStart())
  let insertAt = last.getEnd()
  if (separator.includes('\n')) {
    const lineEnd = lineEndOf(source, insertAt)
    if (TRAILING_COMMENT.test(source.slice(insertAt, lineEnd))) insertAt = lineEnd
  }
  const splice: TextSplice = { offset: insertAt, deleteLength: 0, insert: `${separator}${quote}${name}${quote}` }
  return verified(fileName, source, splice)
}

/** The splice that removes the member `existing` names, and one separator. */
export function removeUnionMember(fileName: string, source: string, existing: UnionMemberLocation): UnionMemberEdit {
  const sourceFile = parseScratch(fileName, source)
  const located = locateUnion(sourceFile, source, existing)
  if ('reason' in located) return { ok: false, refusal: located }
  const { literal, members } = located
  const index = members.findIndex((member) => member === literal)
  if (members.filter(isStringLiteralMember).length <= 1) {
    return refuse('last-member', 'A variant property needs at least one value, so the last one cannot be removed. Add another value first.')
  }

  let splice: TextSplice
  if (index > 0) {
    const previous = members[index - 1]!
    let end = literal.getEnd()
    if (source.slice(previous.getEnd(), literal.getStart()).includes('\n')) {
      const lineEnd = lineEndOf(source, end)
      if (TRAILING_COMMENT.test(source.slice(end, lineEnd))) end = lineEnd
    }
    splice = { offset: previous.getEnd(), deleteLength: end - previous.getEnd(), insert: '' }
  } else {
    const next = members[1]!
    splice = { offset: literal.getStart(), deleteLength: next.getStart() - literal.getStart(), insert: '' }
  }
  return verified(fileName, source, splice)
}

function verified(fileName: string, source: string, splice: TextSplice): UnionMemberEdit {
  const candidate = source.slice(0, splice.offset) + splice.insert + source.slice(splice.offset + splice.deleteLength)
  if (introducesSyntaxErrors(fileName, source, candidate)) {
    return refuse('not-a-union', 'Writing that change would leave this type unparseable. Make this change in the code.')
  }
  return { ok: true, splice }
}
