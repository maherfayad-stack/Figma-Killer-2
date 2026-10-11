/**
 * objectEntry — clone one entry of an object literal under a new key, or take
 * one out, as a byte-exact splice. The write behind a variant whose styling is
 * a lookup object (`const toneClass = { info: '…', warn: '…' }`) or a `cva`/`tv`
 * `variants.<group>` map.
 *
 * The AST only locates. The caller names an entry by where it starts (the
 * variant read model's `entries[].range`); the copy is the entry's own bytes
 * from the end of its key onward, so a multi-line value (a `cva` class array)
 * keeps its layout, and the new entry goes right after the original in the
 * object's own layout: the same indent when the entries sit one per line, one
 * space when they share a line, a comma only where the object needs one.
 *
 * Refusals are by name and never partial: a computed key, a shorthand entry
 * (`{ primary }` has no value text to copy) or a position that no longer holds
 * the entry all return a refusal and no splice.
 */
import { Node, Project, type PropertyAssignment, type SourceFile } from 'ts-morph'
import { introducesSyntaxErrors } from './syntaxRegression'
import { indentOfLineAt, offsetOfLineColumn, type TextSplice } from '@core/utils/textSplice'

export type ObjectEntryRefusalReason = 'stale-source' | 'unsupported-entry' | 'last-member'

export interface ObjectEntryRefusal {
  reason: ObjectEntryRefusalReason
  message: string
}

/** Where an entry starts (1-based) and the member it is keyed by. */
export interface ObjectEntryLocation {
  line: number
  column: number
  member: string
}

export type CloneObjectEntryResult =
  | { ok: true; splice: TextSplice; existed: false }
  /** The object already has an entry under the new key; nothing to copy and nothing to overwrite. */
  | { ok: true; splice: null; existed: true }
  | { ok: false; refusal: ObjectEntryRefusal }

export type RemoveObjectEntryResult = { ok: true; splice: TextSplice } | { ok: false; refusal: ObjectEntryRefusal }

function refuse(reason: ObjectEntryRefusalReason, message: string): { ok: false; refusal: ObjectEntryRefusal } {
  return { ok: false, refusal: { reason, message } }
}

function parseScratch(fileName: string, source: string): SourceFile {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return scratch.createSourceFile(fileName.replace(/^.*[\\/]/, '') || 'entry.tsx', source)
}

function keyText(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText()
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText()
  return undefined
}

function locateEntry(sourceFile: SourceFile, source: string, at: ObjectEntryLocation): PropertyAssignment | ObjectEntryRefusal {
  const stale: ObjectEntryRefusal = { reason: 'stale-source', message: `The '${at.member}' entry is no longer where the board read it. Reload the project and try again.` }
  const offset = offsetOfLineColumn(source, at.line, at.column)
  if (offset === null) return stale
  for (let node: Node | undefined = sourceFile.getDescendantAtPos(offset); node; node = node.getParent()) {
    if (Node.isPropertyAssignment(node) && node.getStart() === offset) {
      return keyText(node.getNameNode()) === at.member && Node.isObjectLiteralExpression(node.getParent()) ? node : stale
    }
    if (node.getStart() < offset) break
  }
  return { reason: 'unsupported-entry', message: `The '${at.member}' entry is not a plain \`key: value\` entry (a shorthand or computed key). Edit it in the code.` }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const TRAILING_COMMENT = /^[ \t]*(\/\/.*)?$/

function lineEndOf(source: string, offset: number): number {
  const next = source.indexOf('\n', offset)
  return next === -1 ? source.length : next
}

function isFirstOnItsLine(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return source.slice(lineStart, offset).trim() === ''
}

/** The offset just after the comma that follows `end` (skipping whitespace), or `null` when the next token is not a comma. */
function commaEndAfter(source: string, end: number): number | null {
  const match = /^\s*,/.exec(source.slice(end))
  return match ? end + match[0].length : null
}

/** The splice that adds `newMember` as a copy of the entry `from` names, right after it. */
export function cloneObjectEntry(fileName: string, source: string, from: ObjectEntryLocation, newMember: string): CloneObjectEntryResult {
  const sourceFile = parseScratch(fileName, source)
  const entry = locateEntry(sourceFile, source, from)
  if ('reason' in entry) return { ok: false, refusal: entry }
  const object = entry.getParent()
  if (!Node.isObjectLiteralExpression(object)) return refuse('stale-source', 'The entry is no longer inside an object literal. Reload the project and try again.')
  if (object.getProperties().some((property) => Node.isPropertyAssignment(property) && keyText(property.getNameNode()) === newMember)) {
    return { ok: true, splice: null, existed: true }
  }

  const nameNode = entry.getNameNode()
  const initializer = entry.getInitializer()
  const quoteOf = (node: Node | undefined): string => {
    const first = node ? source.charAt(node.getStart()) : ''
    return first === '"' || first === "'" ? first : "'"
  }
  let key = newMember
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    const quote = source.charAt(nameNode.getStart())
    key = `${quote}${newMember}${quote}`
  } else if (!IDENTIFIER.test(newMember)) {
    const quote = quoteOf(initializer)
    key = `${quote}${newMember}${quote}`
  }
  const copy = key + source.slice(nameNode.getEnd(), entry.getEnd())

  const multiline = isFirstOnItsLine(source, entry.getStart())
  const separator = multiline ? `\n${indentOfLineAt(source, entry.getStart())}` : ' '
  const commaEnd = commaEndAfter(source, entry.getEnd())
  let splice: TextSplice
  if (commaEnd === null) {
    splice = { offset: entry.getEnd(), deleteLength: 0, insert: `,${separator}${copy}` }
  } else {
    let at = commaEnd
    if (multiline) {
      const lineEnd = lineEndOf(source, at)
      if (TRAILING_COMMENT.test(source.slice(at, lineEnd))) at = lineEnd
    }
    splice = { offset: at, deleteLength: 0, insert: `${separator}${copy},` }
  }
  return verified(fileName, source, splice, { ok: true, splice, existed: false })
}

/** The splice that removes the entry `at` names, with its comma (and its line, when it sat alone on one). */
export function removeObjectEntry(fileName: string, source: string, at: ObjectEntryLocation): RemoveObjectEntryResult {
  const sourceFile = parseScratch(fileName, source)
  const entry = locateEntry(sourceFile, source, at)
  if ('reason' in entry) return { ok: false, refusal: entry }
  const object = entry.getParent()
  if (!Node.isObjectLiteralExpression(object)) return refuse('stale-source', 'The entry is no longer inside an object literal. Reload the project and try again.')
  const properties = object.getProperties()
  const index = properties.findIndex((property) => property === entry)
  if (properties.length <= 1) return refuse('last-member', 'The last entry of this object cannot be removed. Delete the whole object in the code.')

  const commaEnd = commaEndAfter(source, entry.getEnd())
  const tail = commaEnd ?? entry.getEnd()
  let splice: TextSplice
  if (isFirstOnItsLine(source, entry.getStart()) && TRAILING_COMMENT.test(source.slice(tail, lineEndOf(source, tail)))) {
    const lineStart = source.lastIndexOf('\n', entry.getStart() - 1) + 1
    const end = Math.min(lineEndOf(source, tail) + 1, source.length)
    splice = { offset: lineStart, deleteLength: end - lineStart, insert: '' }
  } else if (index < properties.length - 1) {
    splice = { offset: entry.getStart(), deleteLength: properties[index + 1]!.getStart() - entry.getStart(), insert: '' }
  } else {
    const previous = properties[index - 1]!
    splice = { offset: previous.getEnd(), deleteLength: tail - previous.getEnd(), insert: '' }
  }
  return verified(fileName, source, splice, { ok: true, splice })
}

function verified<T extends { ok: true }>(fileName: string, source: string, splice: TextSplice, result: T): T | { ok: false; refusal: ObjectEntryRefusal } {
  const candidate = source.slice(0, splice.offset) + splice.insert + source.slice(splice.offset + splice.deleteLength)
  if (introducesSyntaxErrors(fileName, source, candidate)) {
    return refuse('unsupported-entry', 'Writing that change would leave this object unparseable. Make this change in the code.')
  }
  return result
}
