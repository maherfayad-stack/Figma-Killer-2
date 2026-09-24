/**
 * atomicFileWrite — replace an EXISTING file's contents so that a crash, an
 * out-of-memory kill or a reader in the middle never sees a half-written file
 * (security review of #233, F5).
 *
 * `writeFileSync(path, text)` truncates first and writes second. Between the
 * two, the P1-D watcher, Vite's HMR or the canvas can read an empty or partial
 * module; a process that dies there leaves it that way. So the new text goes
 * to a sibling temp file first — created exclusively, flushed to disk, given
 * the old file's permission bits — and is then renamed over the target, which
 * the filesystem does in one step.
 *
 * ## Windows
 *
 * A rename over a file another process holds open without delete-sharing
 * fails with `EPERM`/`EACCES`/`EBUSY` — measured with a second Bun handle open
 * on the target, and routine with an antivirus scanner, an editor or Vite's
 * own watcher reading it. The rename is retried a few times over ~300 ms; if
 * the file is still held, the text is written into it in place — the old
 * behaviour, never a lost write — and the temp file is removed.
 *
 * ## What the rename changes, and how that is kept honest
 *
 * - A symlink is written THROUGH, not replaced: the temp file is made beside
 *   the link's real target and renamed over that.
 * - The permission bits are copied; on POSIX an executable stays executable.
 * - A hard-linked file would lose the link. Agent writers already refuse one
 *   (`hasOtherHardLinks`), so this never meets one from them.
 *
 * A writer creating a NEW file it must not race should still use an exclusive
 * create (`wx`): that is what makes a racing creator lose.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Error codes a rename over an open file reports on Windows. */
const HELD_FILE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 150]

/** Test seam: the rename, so a test can make it fail the way a held file does. */
export interface AtomicWriteDeps {
  readonly rename?: (from: string, to: string) => void
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isHeldFileError(err: unknown): boolean {
  return HELD_FILE_CODES.has((err as NodeJS.ErrnoException | undefined)?.code ?? '')
}

/**
 * Replace the contents of the file at `path` in one step. See the module doc.
 * A missing file is created the same way (a batch may create one); its parent
 * folder must exist.
 */
export function writeFileAtomic(path: string, content: string, deps: AtomicWriteDeps = {}): void {
  const rename = deps.rename ?? renameSync
  let target = path
  let mode = 0o666
  try {
    target = realpathSync.native(path)
    mode = statSync(target).mode & 0o7777
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.studio-tmp`)

  const fd = openSync(temp, 'wx', mode)
  try {
    writeSync(fd, content, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(temp, target)
        return
      } catch (err) {
        if (!isHeldFileError(err)) throw err
        if (attempt >= RENAME_RETRY_DELAYS_MS.length) break
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!)
      }
    }
    // Still held by another process: write in place, as before — never lose it.
    writeFileSync(target, content, 'utf8')
  } finally {
    try {
      unlinkSync(temp)
    } catch (_err) {
      // Renamed away (the normal case), or already gone: nothing left behind.
    }
  }
}
