/**
 * Architecture Source-Scan — no literal NUL byte in a source or doc file
 *
 * A NUL written as a RAW byte inside a template literal is valid TypeScript
 * and runs identically to the six-character escape — which is exactly why it
 * is dangerous. The byte is invisible in every editor, and the tools this
 * repository's agents and its humans use to read the tree treat a file
 * containing one as binary:
 *
 *   - `ripgrep` (and therefore the `Grep` tool and every editor's "find in
 *     files") stops scanning at the first NUL and reports `binary file
 *     matches`. Every match AFTER the byte is silently dropped.
 *     `server/handlers/studio/gitSyncOperations.ts` carried one at byte
 *     offset 18122, which hid the last ~190 lines of the git-sync surface —
 *     including `readBranchCommitSubjects` and several `runGit` call sites —
 *     from any grep-driven review.
 *   - `git diff` applies the same heuristic to the first 8000 bytes, so a NUL
 *     near the top of a file turns every future review of it into
 *     `Binary files a/… and b/… differ`.
 *   - git also skips end-of-line normalisation for a file it believes is
 *     binary, so such a file silently acquires CRLF in the index on a Windows
 *     checkout (`src/ui/components/Toast/toastBus.ts` had exactly that, and
 *     the `.gitattributes` header explains what CRLF in the index breaks).
 *
 * A security review that greps for a guard and gets no hit concludes the
 * guard is absent. That is the failure mode this gate exists to make
 * impossible.
 *
 * The fix is always the same and never changes behaviour: write the escape
 * (backslash-u-0-0-0-0) instead of the byte. Note that most editors and
 * agent file-writing tools will turn that escape straight back into a raw
 * byte if you retype the line — the correction has to be made at byte level.
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')

/** Extensions whose files a human or an agent reads as text. Binary assets are not scanned. */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.md', '.css', '.json']

/**
 * Directories that are not repository source: dependencies, build output, the
 * user's own project repositories (`studio-workspace/` — never ours to
 * police, and `.gitattributes` marks it `-text` for that reason), and scratch
 * roots.
 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'studio-workspace',
  'uploads',
  '.tmp',
  '.claude',
])

/** `withFileTypes` avoids a `statSync` per entry — on Windows that alone is the difference between 280 ms and 90 ms. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }
  return out
}

describe('Architecture: no literal NUL byte in a source or doc file', () => {
  const files = walk(PROJECT_ROOT)

  test('the scan actually reaches the source tree', () => {
    // A gate that inspects zero files passes forever (F-0007). Pin both the
    // order of magnitude and one specific file that used to be an offender.
    expect(files.length).toBeGreaterThan(1000)
    expect(
      files.some((f) => relative(PROJECT_ROOT, f).split(sep).join('/') === 'server/handlers/studio/gitSyncOperations.ts'),
    ).toBe(true)
  })

  test('no scanned file contains a raw NUL byte — write the escape instead', async () => {
    // Read in parallel through `Bun.file`: ~4,400 files in ~130 ms, against
    // ~19 s for a serial `readFileSync` loop on Windows. A whole-tree scan has
    // to fit inside the architecture suite's per-test budget or it becomes a
    // flaky timeout that everyone learns to ignore.
    const contents = await Promise.all(files.map(async (file) => [file, await Bun.file(file).bytes()] as const))

    const offenders: string[] = []
    for (const [file, bytes] of contents) {
      const at = bytes.indexOf(0)
      if (at === -1) continue
      const line = new TextDecoder().decode(bytes.subarray(0, at)).split('\n').length
      offenders.push(`${relative(PROJECT_ROOT, file).split(sep).join('/')}:${String(line)} (byte offset ${String(at)})`)
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'These files contain a raw NUL byte, which makes ripgrep and git treat them as binary — every ' +
          'grep match after the byte is invisible. Replace the raw byte with the six-character escape, ' +
          'at byte level (retyping it in most editors re-inserts the raw byte):\n  ' +
          offenders.join('\n  '),
    ).toEqual([])
  })
})
