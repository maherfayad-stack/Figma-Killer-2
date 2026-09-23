/**
 * sourceLineMap — where did line L of an earlier text of a file go in the text
 * on disk now? The line-diff half of re-finding an edit's target after the
 * file changed under the board (P1-D, WB-1's re-locate half;
 * `studioEditRelocate.ts` is the policy that uses it).
 *
 * A line diff has more than one right answer whenever lines repeat. Delete one
 * of two identical `<li>A</li>` lines and no diff can say which one went; the
 * surviving line is "the first one, moved up" or "the second one, where it
 * was", equally. So this does not answer with ONE diff's opinion. It computes
 * the two extreme optimal alignments — every line matched as EARLY as an
 * optimal diff allows, and every line matched as LATE — and reports where the
 * line lands under each:
 *
 *   - both agree → one position;
 *   - they disagree → both positions, and the caller's identity check decides
 *     (only one of them may hold the element the edit expected);
 *   - either says the line is GONE → `null`: some honest reading of the change
 *     deleted it, and a line that may have been deleted is not re-found.
 *
 * Lines are compared with surrounding whitespace ignored, and the column is
 * carried across a change of indentation, so the commonest outside edit of
 * all — wrapping a block in a new element, which re-indents everything inside
 * it — does not lose every element it touched.
 *
 * The two extremes are Myers' shortest-edit-script walk run forwards (each
 * common run is followed as far as it goes, so lines match as early as they
 * can) and run over the reversed texts (as late as they can). Cost is
 * O((N+M)·D) for D changed lines, so a handful of inserted lines in a
 * thousand-line file is a few thousand steps. A change larger than
 * {@link MAX_EDIT_DISTANCE} lines is not guessed at: the answer is `null`, and
 * the edit refuses as it did before re-location existed.
 */

/** Most lines added plus removed that a re-location will align — a rewrite larger than this is not "the same file, shifted". */
export const MAX_EDIT_DISTANCE = 1_000

export interface MappedPosition {
  line: number
  col: number
}

/** What a line is compared by: its content, not its indentation. */
function lineKey(line: string): string {
  return line.trim()
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * For each line of `a`, the line of `b` it is matched with (`-1`: none) in the
 * shortest edit script Myers' greedy forward walk finds — or `null` when that
 * script is longer than {@link MAX_EDIT_DISTANCE}.
 */
function forwardMatches(a: readonly string[], b: readonly string[]): Int32Array | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // `trace[d]` holds diagonals -d..d as they stood after step d: what the walk
  // back needs to know which move each step made.
  const trace: Int32Array[] = []
  let steps = -1
  for (let d = 0; d <= max && steps < 0; d++) {
    if (d > MAX_EDIT_DISTANCE) return null
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        steps = d
        break
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }

  const match = new Int32Array(n).fill(-1)
  let x = n
  let y = m
  for (let d = steps; d > 0; d--) {
    const previous = trace[d - 1]!
    const at = (k: number) => previous[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    const startX = down ? prevX : prevX + 1
    const startY = down ? prevY + 1 : prevY
    while (x > startX && y > startY) {
      x--
      y--
      match[x] = y
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    match[x] = y
  }
  return match
}

/**
 * Where `line:col` (1-based) of `before` is in `after` — see this module's
 * doc for why this can be two positions, and why `null` is an answer.
 * Both texts must use `\n` line endings.
 */
export function mapPositionThroughLineDiff(before: string, after: string, line: number, col: number): MappedPosition[] | null {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const i = line - 1
  if (i < 0 || i >= beforeLines.length) return null
  const a = beforeLines.map(lineKey)
  const b = afterLines.map(lineKey)
  const forward = forwardMatches(a, b)
  const backward = forwardMatches([...a].reverse(), [...b].reverse())
  if (!forward || !backward) return null
  const early = forward[i]!
  const reversedLate = backward[a.length - 1 - i]!
  const late = reversedLate < 0 ? -1 : b.length - 1 - reversedLate
  if (early < 0 || late < 0) return null
  const indentBefore = indentOf(beforeLines[i]!)
  const at = (j: number): MappedPosition => ({
    line: j + 1,
    // Same content, maybe re-indented: the element keeps its offset from the
    // first non-blank character.
    col: col > indentBefore ? col - indentBefore + indentOf(afterLines[j]!) : col,
  })
  return early === late ? [at(early)] : [at(early), at(late)]
}
