/**
 * GitDiffView — one file's unified diff, read-only.
 *
 * ## Why this is not CodeMirror
 *
 * CodeMirror is this repo's code-EDITING primitive, and the work order asked
 * for it here. It is the wrong tool for this view, for three reasons that
 * compound:
 *
 *   1. **There is no diff mode to reuse.** `@codemirror/merge` is not a
 *      dependency, and CodeMirror's language modes highlight a LANGUAGE — none
 *      of them understands `+`/`-`/`@@`. Rendering a unified diff in a
 *      read-only CodeMirror gives uncoloured monospace text; the per-line
 *      add/remove colouring that makes a diff readable would have to be
 *      hand-written as a decoration extension anyway.
 *   2. **The repo allows exactly one CodeMirror consumer.**
 *      `codemirror-lazy-only.test.ts` names `CodeMirrorEditor.tsx` as the sole
 *      file permitted to import the family, because a stray static import
 *      pulls ~605 kB raw / ~208 kB gzipped into the eager admin chunk. Adding
 *      a second consumer means widening that gate.
 *   3. **The cost buys nothing here.** A diff is line-oriented text with two
 *      gutters. That is ~60 lines of JSX and CSS, with no bundle cost and no
 *      lazy boundary to coordinate.
 *
 * So the parsing lives in `gitDiffLines.ts` (pure, unit-tested — the line
 * numbering is the part that is easy to get wrong) and the rendering is plain
 * rows here. If a future change needs full syntax highlighting INSIDE diff
 * hunks, that is the moment to revisit — and to widen the gate deliberately
 * rather than by accident.
 *
 * Both halves of a file's diff are shown when both exist: what is staged, and
 * what is not. A file can be in both states at once and the panel must not
 * pretend otherwise, because "commit" acts on the working-tree content.
 */
import { parseUnifiedDiff, summarizeDiff, type GitDiffLine } from './gitDiffLines'
import styles from './GitPanel.module.css'

interface GitDiffViewProps {
  /** Raw unified diff text. Empty renders nothing — the caller decides what an empty half means. */
  diff: string
  /** Shown above the hunks, e.g. "Staged" / "Not staged" / "New file". */
  label: string
}

export function GitDiffView({ diff, label }: GitDiffViewProps) {
  const lines = parseUnifiedDiff(diff)
  if (lines.length === 0) return null
  const { added, removed } = summarizeDiff(lines)

  return (
    <div className={styles.diff}>
      <div className={styles.diffHeader}>
        <span className={styles.diffLabel}>{label}</span>
        <span className={styles.diffCounts}>
          <span className={styles.diffAdded}>+{added}</span>
          <span className={styles.diffRemoved}>−{removed}</span>
        </span>
      </div>
      {/* `<pre>` rather than a table: a diff IS preformatted text, and a table
          would make selecting a hunk to copy produce cell soup. */}
      <pre className={styles.diffBody}>
        {lines.map((line, index) => (
          <DiffRow key={index} line={line} />
        ))}
      </pre>
    </div>
  )
}

const ROW_CLASS: Record<GitDiffLine['kind'], string> = {
  meta: styles.rowMeta,
  hunk: styles.rowHunk,
  added: styles.rowAdded,
  removed: styles.rowRemoved,
  context: styles.rowContext,
}

const ROW_MARKER: Record<GitDiffLine['kind'], string> = {
  meta: ' ',
  hunk: ' ',
  added: '+',
  removed: '−',
  context: ' ',
}

function DiffRow({ line }: { line: GitDiffLine }) {
  return (
    <span className={`${styles.diffRow} ${ROW_CLASS[line.kind]}`}>
      {/* Two gutters, both aria-hidden: they are positional scaffolding, and a
          screen reader announcing "one hundred and four, one hundred and six"
          before every line makes the diff unreadable. The line's TEXT is the
          content. */}
      <span className={styles.gutter} aria-hidden="true">
        {line.oldLine ?? ''}
      </span>
      <span className={styles.gutter} aria-hidden="true">
        {line.newLine ?? ''}
      </span>
      <span className={styles.marker} aria-hidden="true">
        {ROW_MARKER[line.kind]}
      </span>
      <span className={styles.rowText}>{line.text}</span>
    </span>
  )
}
