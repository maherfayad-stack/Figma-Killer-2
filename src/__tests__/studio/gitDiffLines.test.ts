/**
 * gitDiffLines — the unified-diff parser behind the Git panel's diff view.
 *
 * The fixtures are real `git diff` output. The thing worth testing here is the
 * line NUMBERING: two counters advanced conditionally and reset per hunk, which
 * is exactly the kind of arithmetic that looks right and is off by one.
 */
import { describe, expect, it } from 'bun:test'
import { parseUnifiedDiff, summarizeDiff } from '@site/panels/GitPanel/gitDiffLines'

const MODIFIED = `diff --git a/pages/Home.tsx b/pages/Home.tsx
index 1234567..89abcde 100644
--- a/pages/Home.tsx
+++ b/pages/Home.tsx
@@ -1,5 +1,6 @@
 export default function Home() {
-  return null
+  return <main>hello</main>
+  // added a second line
 }

`

const NEW_FILE = `diff --git a/pages/About.tsx b/pages/About.tsx
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/pages/About.tsx
@@ -0,0 +1,2 @@
+export default function About() {
+}
`

describe('parseUnifiedDiff', () => {
  it('tags the file header as meta and never numbers it', () => {
    const lines = parseUnifiedDiff(MODIFIED)
    const header = lines.slice(0, 4)
    expect(header.every((l) => l.kind === 'meta')).toBe(true)
    expect(header.every((l) => l.oldLine === null && l.newLine === null)).toBe(true)
    expect(header[0]!.text).toBe('diff --git a/pages/Home.tsx b/pages/Home.tsx')
  })

  it('reads `---`/`+++` as header, not as a removed/added line', () => {
    // The single easiest way to get a diff renderer wrong: `---` starts with
    // `-`, and `+++` with `+`.
    const lines = parseUnifiedDiff(MODIFIED)
    expect(lines.find((l) => l.text === '--- a/pages/Home.tsx')!.kind).toBe('meta')
    expect(lines.find((l) => l.text === '+++ b/pages/Home.tsx')!.kind).toBe('meta')
  })

  it('numbers context, removed and added lines from the hunk header', () => {
    const lines = parseUnifiedDiff(MODIFIED).filter((l) => l.kind !== 'meta' && l.kind !== 'hunk')
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['context', 1, 1, 'export default function Home() {'],
      ['removed', 2, null, '  return null'],
      ['added', null, 2, '  return <main>hello</main>'],
      ['added', null, 3, '  // added a second line'],
      ['context', 3, 4, '}'],
    ])
  })

  it('strips the leading marker so the renderer owns it', () => {
    const added = parseUnifiedDiff(MODIFIED).find((l) => l.kind === 'added')!
    expect(added.text.startsWith('+')).toBe(false)
  })

  it('reads a new-file diff against /dev/null', () => {
    const lines = parseUnifiedDiff(NEW_FILE)
    expect(lines.find((l) => l.text === 'new file mode 100644')!.kind).toBe('meta')
    const content = lines.filter((l) => l.kind === 'added')
    expect(content.map((l) => l.newLine)).toEqual([1, 2])
  })

  it('resets both counters at every hunk header', () => {
    const twoHunks = `--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-one
+ONE
@@ -50,1 +60,1 @@
-fifty
+sixty
`
    const changed = parseUnifiedDiff(twoHunks).filter((l) => l.kind === 'added' || l.kind === 'removed')
    expect(changed.map((l) => l.oldLine ?? l.newLine)).toEqual([1, 1, 50, 60])
  })

  it('tags git\'s no-newline marker as meta rather than as removed content', () => {
    const lines = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n')
    const marker = lines.find((l) => l.text.startsWith('\\'))!
    expect(marker.kind).toBe('meta')
    // It must not advance a counter, or every line after it is off by one.
    expect(lines.find((l) => l.kind === 'added')!.newLine).toBe(1)
  })

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('summarizeDiff', () => {
  it('counts only real content lines', () => {
    expect(summarizeDiff(parseUnifiedDiff(MODIFIED))).toEqual({ added: 2, removed: 1 })
    expect(summarizeDiff(parseUnifiedDiff(NEW_FILE))).toEqual({ added: 2, removed: 0 })
  })
})
