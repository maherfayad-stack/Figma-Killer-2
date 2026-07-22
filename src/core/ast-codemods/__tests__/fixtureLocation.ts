/**
 * Test-only helper: computes the (line, col) location — per this module's
 * convention (1-based line, 1-based column of the char right after `<`) —
 * of the Nth `<Tag` occurrence in a fixture source string.
 */
export interface FixtureLocation {
  line: number
  col: number
}

export function locateTag(source: string, tag: string, occurrence = 1): FixtureLocation {
  // Lookahead ensures `<Card` doesn't also match `<CardWrapper`.
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g')

  let match: RegExpExecArray | null
  let count = 0
  let openBracketIndex = -1
  while ((match = re.exec(source)) !== null) {
    count += 1
    if (count === occurrence) {
      openBracketIndex = match.index
      break
    }
  }

  if (openBracketIndex === -1) {
    throw new Error(`locateTag: could not find occurrence #${occurrence} of "<${tag}" in fixture source`)
  }

  const nameStart = openBracketIndex + 1 // char right after '<'
  const before = source.slice(0, nameStart)
  const lines = before.split('\n')
  const line = lines.length
  const col = lines[lines.length - 1].length + 1

  return { line, col }
}
