/**
 * gitDiffLines — a unified diff as typed, numbered lines.
 *
 * Pure string work, deliberately separate from the component that renders it:
 * the tricky part of showing a diff is the line NUMBERING (two counters, both
 * advanced conditionally, reset at every hunk header), and that is much easier
 * to be sure about with a unit test than with a screenshot.
 *
 * The parser is intentionally forgiving. A unified diff is not a formal
 * grammar this side of git's own implementation, and a panel that renders
 * nothing because one line looked unfamiliar is worse than one that shows that
 * line as plain context. Anything it does not recognize becomes `context`.
 *
 * `\ No newline at end of file` is git's own marker, not content — it advances
 * neither counter and is tagged `meta` so it can be rendered muted.
 */

export type GitDiffLineKind =
  /** `diff --git`, `index`, `---`, `+++`, `new file mode`, … — the file header. */
  | 'meta'
  /** `@@ -a,b +c,d @@` — resets both line counters. */
  | 'hunk'
  | 'added'
  | 'removed'
  | 'context'

export interface GitDiffLine {
  kind: GitDiffLineKind
  /** The line's text WITHOUT its leading `+`/`-`/space marker, so the renderer owns presentation of the marker. */
  text: string
  /** Line number in the OLD file, or `null` for an added line / a header. */
  oldLine: number | null
  /** Line number in the NEW file, or `null` for a removed line / a header. */
  newLine: number | null
}

/** `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@[ optional section heading]` */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Prefixes that are part of git's file header rather than content. `---`/`+++` are checked BEFORE `-`/`+` for exactly this reason. */
const META_PREFIXES = ['diff --git ', 'index ', 'new file mode', 'deleted file mode', 'old mode', 'new mode', 'similarity index', 'rename from', 'rename to', 'copy from', 'copy to', 'Binary files ', 'GIT binary patch']

export function parseUnifiedDiff(diff: string): GitDiffLine[] {
  if (!diff) return []

  const lines: GitDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const raw of diff.split('\n')) {
    const hunk = HUNK_HEADER_RE.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null })
      continue
    }

    if (!inHunk) {
      // Everything before the first hunk is header. A trailing empty string
      // from the final newline is not worth rendering.
      if (raw === '' && lines.length === 0) continue
      if (raw.startsWith('--- ') || raw.startsWith('+++ ') || META_PREFIXES.some((p) => raw.startsWith(p))) {
        lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
        continue
      }
      if (raw === '') continue
      lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
      continue
    }

    if (raw.startsWith('\\')) {
      // `\ No newline at end of file` — a marker, not a line of either file.
      lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'added', text: raw.slice(1), oldLine: null, newLine })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', text: raw.slice(1), oldLine, newLine: null })
      oldLine += 1
      continue
    }
    if (raw === '') {
      // git's own trailing newline after the last hunk line. Dropping it keeps
      // every diff from ending in a phantom blank row.
      continue
    }
    lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldLine, newLine })
    oldLine += 1
    newLine += 1
  }

  return lines
}

/** Added/removed line counts, for the one-line summary above a diff. Header and hunk lines never count. */
export function summarizeDiff(lines: readonly GitDiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}
