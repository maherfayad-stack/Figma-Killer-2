/**
 * agentCheckpointDiff — a unified diff of two texts, for the Agent panel's
 * per-file "what did this turn change" view (AI-7).
 *
 * The git panel already renders a unified diff (`GitDiffView` over
 * `gitDiffLines.ts`), so a checkpoint's diff is produced in that exact format
 * and the panel reuses the same parser and rows. Git itself is not asked:
 * the two sides are a stored pre-image and a stored post-image, neither of
 * which is a git object, and spawning `git diff --no-index` on two temp files
 * per click is a subprocess to answer a question two strings can answer.
 *
 * Lines are compared exactly (not whitespace-folded, unlike `sourceLineMap.ts`,
 * whose job is re-finding a line, not showing a change). The script is Myers'
 * greedy shortest edit, O((N+M)·D); a change larger than
 * {@link MAX_DIFF_EDIT_DISTANCE} lines is not diffed — the caller reports it as
 * too large to show rather than spending seconds on a whole-file rewrite.
 */

/** Most added + removed lines a diff is computed for. A whole-screen rewrite of a 1,000-line file fits; a generated 50,000-line bundle does not. */
export const MAX_DIFF_EDIT_DISTANCE = 2_000
/** Unchanged lines shown around each change — git's default. */
const CONTEXT_LINES = 3

type Op = { readonly kind: 'equal' | 'delete' | 'insert'; readonly line: string }

/** Split into lines the way git counts them: a trailing newline does not start an empty last line. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The shortest edit script from `a` to `b`, or `null` past
 * {@link MAX_DIFF_EDIT_DISTANCE}. Each step saves only the diagonals it
 * reached (-d..d), so memory is O(D²), not O(D·(N+M)).
 */
function editScript(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_DIFF_EDIT_DISTANCE) return null
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }

  // Walk back from (n, m): step d's move started on the diagonals step d-1 reached.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1]!
    const at = (k: number): number => previous[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    const startX = down ? prevX : prevX + 1
    const startY = down ? prevY + 1 : prevY
    while (x > startX && y > startY) {
      ops.push({ kind: 'equal', line: a[x - 1]! })
      x--
      y--
    }
    if (down) ops.push({ kind: 'insert', line: b[prevY]! })
    else ops.push({ kind: 'delete', line: a[prevX]! })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'equal', line: a[x - 1]! })
    x--
    y--
  }
  return ops.reverse()
}

export interface LineDiffResult {
  /** Unified diff text (`--- a/…`, `+++ b/…`, `@@` hunks) — empty when the texts are equal. */
  readonly diff: string
  readonly added: number
  readonly removed: number
}

/**
 * The unified diff from `before` to `after`, headed as `path`. `before: null`
 * is a file the turn created (`--- /dev/null`). `null` when the change is past
 * {@link MAX_DIFF_EDIT_DISTANCE}.
 */
export function unifiedLineDiff(path: string, before: string | null, after: string): LineDiffResult | null {
  const a = splitLines(before ?? '')
  const b = splitLines(after)
  const ops = editScript(a, b)
  if (ops === null) return null
  const added = ops.filter((op) => op.kind === 'insert').length
  const removed = ops.filter((op) => op.kind === 'delete').length
  if (added === 0 && removed === 0) return { diff: '', added: 0, removed: 0 }

  // Hunks: every change plus CONTEXT_LINES of equal lines either side, merged
  // when two changes' context overlaps.
  const changeAt: number[] = []
  ops.forEach((op, index) => { if (op.kind !== 'equal') changeAt.push(index) })
  const ranges: Array<[number, number]> = []
  for (const index of changeAt) {
    const start = Math.max(0, index - CONTEXT_LINES)
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  // Line numbers at the start of each op, in both files.
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (op.kind !== 'insert') oldLine++
    if (op.kind !== 'delete') newLine++
  }

  const out: string[] = [before === null ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`]
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter((op) => op.kind !== 'insert').length
    const newCount = slice.filter((op) => op.kind !== 'delete').length
    // git's convention: a zero-length side names the line BEFORE the hunk.
    const oldStart = oldCount === 0 ? oldAt[start]! - 1 : oldAt[start]!
    const newStart = newCount === 0 ? newAt[start]! - 1 : newAt[start]!
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) out.push(`${op.kind === 'insert' ? '+' : op.kind === 'delete' ? '-' : ' '}${op.line}`)
  }
  return { diff: `${out.join('\n')}\n`, added, removed }
}
