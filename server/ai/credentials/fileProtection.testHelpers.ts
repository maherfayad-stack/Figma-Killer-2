/**
 * fileProtection.testHelpers — "who can actually open this file?", answered in
 * the terms the running platform enforces. **Test-only**; nothing in the
 * product imports it, which is why it carries the `testHelpers` suffix rather
 * than sitting beside `privateTempDir.ts` as if it were part of the API.
 *
 * It exists because a test that asserts `statSync(path).mode === 0o600` on
 * Windows is asserting a guarantee the platform does not make: Node maps
 * `chmod` onto the single read-only attribute and reports `0o666`/`0o444`
 * back, while access is really decided by the NTFS DACL. `claudeCli.test.ts`
 * carried exactly that assertion and was red on this machine for that reason
 * (`standing-01`) — the fix is to read the DACL, not to skip the test.
 *
 * Synchronous on purpose: the one place that needs it reads the protection
 * from inside a spawn callback, before the driver's `finally` deletes the
 * file.
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface FileProtection {
  /** POSIX mode bits of the file. Meaningful on Linux/macOS; decorative on Windows. */
  fileMode: number
  /** POSIX mode bits of the directory holding it. Same caveat. */
  dirMode: number
  /**
   * One entry per access-control entry, `'<account>:<rights>'`, exactly as
   * `icacls` prints them — e.g. `'MACHINE\\Admin:(I)(F)'`. Empty on POSIX,
   * where the mode bits are the whole answer.
   */
  acl: string[]
}

export function readFileProtection(path: string): FileProtection {
  return {
    fileMode: statSync(path).mode & 0o777,
    dirMode: statSync(dirname(path)).mode & 0o777,
    acl: process.platform === 'win32' ? readWindowsAcl(path) : [],
  }
}

/**
 * `icacls <path>` prints the path followed by its first ACE on line one, then
 * one indented ACE per line, then a blank line and a summary. This keeps the
 * `<account>:<rights>` pairs and drops everything else, so a caller can assert
 * the exact set of principals with access.
 */
function readWindowsAcl(path: string): string[] {
  const result = Bun.spawnSync(['icacls', path])
  const text = new TextDecoder().decode(result.stdout)
  const withoutPath = text.startsWith(path) ? text.slice(path.length) : text

  return withoutPath
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Successfully processed'))
    .map((line) => line.replace(/\s+/g, ' '))
}
