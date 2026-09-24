import { describe, expect, it } from 'bun:test'
import { parseUnifiedDiff } from '../../../src/admin/pages/site/panels/GitPanel/gitDiffLines'
import { MAX_DIFF_EDIT_DISTANCE, unifiedLineDiff } from './agentCheckpointDiff'

describe('unifiedLineDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedLineDiff('a.ts', 'x\ny\n', 'x\ny\n')).toEqual({ diff: '', added: 0, removed: 0 })
  })

  it('writes git-shaped hunks the git panel parser reads back with the right line numbers', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before.replace('line 5\n', 'line five\n').replace('line 18\n', 'line 18\nline 18b\n')
    const result = unifiedLineDiff('pages/Home.tsx', before, after)!
    expect(result.added).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.diff.startsWith('--- a/pages/Home.tsx\n+++ b/pages/Home.tsx\n@@ -2,7 +2,7 @@\n')).toBe(true)
    const lines = parseUnifiedDiff(result.diff)
    expect(lines.find((l) => l.kind === 'removed')).toMatchObject({ text: 'line 5', oldLine: 5 })
    expect(lines.find((l) => l.kind === 'added')).toMatchObject({ text: 'line five', newLine: 5 })
    expect(lines.filter((l) => l.kind === 'hunk')).toHaveLength(2)
    expect(lines.find((l) => l.text === 'line 18b')).toMatchObject({ kind: 'added', newLine: 19 })
  })

  it('heads a created file with /dev/null', () => {
    const result = unifiedLineDiff('New.tsx', null, 'a\nb\n')!
    expect(result.diff).toBe('--- /dev/null\n+++ b/New.tsx\n@@ -0,0 +1,2 @@\n+a\n+b\n')
  })

  it('declines a change past the edit-distance cap instead of spending seconds on it', () => {
    const before = Array.from({ length: MAX_DIFF_EDIT_DISTANCE }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: MAX_DIFF_EDIT_DISTANCE }, (_, i) => `b${i}`).join('\n')
    expect(unifiedLineDiff('big.ts', before, after)).toBeNull()
  })
})
