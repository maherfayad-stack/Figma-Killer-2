/**
 * privateTempDir — a temp directory only the current OS user can open, on
 * every platform Studio runs on.
 *
 * ## Why this is not just `mkdtempSync` + `chmodSync(0o700)`
 *
 * `chmod` is a POSIX mode-bit call. On Windows it is very nearly a no-op:
 * Node maps it onto the single FILE_ATTRIBUTE_READONLY bit, and `statSync`
 * reports `0o666`/`0o444` back regardless of what was asked for. Access on
 * NTFS is decided by the DACL, which `chmod` never touches. So a module that
 * writes a plaintext bearer token into `mkdtempSync(...)` and calls
 * `chmodSync(dir, 0o700)` is protected on Linux and macOS and protected on
 * Windows only by whatever `%TEMP%` happens to inherit — which is the user's
 * profile ACL on a default install, and is NOT that on a machine whose TEMP
 * has been redirected to a shared volume, which several corporate images do.
 * `sec-11` already found this exact overstatement in `gitAskpass.ts` and
 * corrected the DOCS; this module corrects the PRODUCT instead, because the
 * file in question (`claudeCliMcpConfigFile.ts`) holds a live connector
 * bearer token and, once a registered MCP server is approved, a third-party
 * personal access token in the clear.
 *
 * So: POSIX gets the mode bits, Windows gets a real DACL, and both are
 * applied to the DIRECTORY **before** anything is written inside it. On NTFS
 * a newly created file inherits its parent's inheritable ACEs at creation
 * time, so restricting the directory first means the secret file never exists
 * with a wider ACL, not even for an instant — the same create-time reasoning
 * `claudeCliMcpConfigFile.ts` already applies to `writeFileSync`'s `mode`.
 *
 * ## The Windows call, exactly
 *
 *     icacls <dir> /inheritance:r /grant:r "<username>:(OI)(CI)(F)"
 *
 * `/inheritance:r` drops the ACEs inherited from `%TEMP%` (by default
 * `SYSTEM`, `BUILTIN\Administrators` and the user); `/grant:r` then replaces
 * any grant for the named account with exactly one. The resulting DACL is a
 * single ACE, and a file created inside inherits exactly that one. argv
 * array, no shell, and through `runCappedSubprocess` so it inherits the
 * bounded runner's timeout and output caps like every other subprocess in
 * this tree.
 *
 * ## Fail-soft, and why that is not a hole
 *
 * A failed restriction logs and returns `false` rather than throwing. The
 * directory is still inside `os.tmpdir()`, which on a default Windows install
 * is already user-private — this call is defence in depth over that, not a
 * replacement for it, and refusing to run an agent turn because `icacls` was
 * missing would trade a real feature for a hypothetical. The caller gets the
 * boolean so a test can assert the protection really was applied on the
 * platform it is running on.
 */
import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { minimalSubprocessEnv, runCappedSubprocess, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'

/** Owner-only on a directory. Real on POSIX; decorative on Windows, where the DACL below is what holds. */
export const PRIVATE_DIR_MODE = 0o700
/** Owner-only on a file. Same caveat — pass it as `writeFileSync`'s create-time `mode`, never as a later `chmodSync`. */
export const PRIVATE_FILE_MODE = 0o600

/** `icacls` is a Windows system tool and finishes in milliseconds on an empty directory; this ceiling only exists so a wedged call cannot hold a turn open. */
const ICACLS_TIMEOUT_MS = 10_000
/** `icacls` prints one short line per processed path. Anything beyond this is not output we would read. */
const ICACLS_MAX_OUTPUT_BYTES = 16 * 1024

export interface PrivateTempDirOptions {
  /** Test seam — defaults to `Bun.spawn`, through `runCappedSubprocess`. */
  spawn?: SubprocessSpawnFn
}

/**
 * Creates `os.tmpdir()/<prefix>XXXXXX` and restricts it to the current OS
 * user before returning, so the caller can write a secret into it with no
 * window where anyone else could read it.
 *
 * Returns the directory and whether the restriction was actually applied —
 * `false` means the platform call failed and the directory is protected only
 * by whatever `os.tmpdir()` itself grants (see the module doc).
 */
export async function createPrivateTempDir(
  prefix: string,
  options: PrivateTempDirOptions = {},
): Promise<{ dir: string; restricted: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const restricted = await restrictDirectoryToCurrentUser(dir, options)
  return { dir, restricted }
}

/**
 * Restricts an EXISTING directory to the current OS user. Split out from
 * {@link createPrivateTempDir} only so the act has a name in a stack trace
 * and so a test can drive it against a directory it made itself.
 */
export async function restrictDirectoryToCurrentUser(
  dir: string,
  options: PrivateTempDirOptions = {},
): Promise<boolean> {
  if (process.platform === 'win32') return restrictWithIcacls(dir, options)

  try {
    chmodSync(dir, PRIVATE_DIR_MODE)
    return true
  } catch (err) {
    console.error('[ai/privateTempDir] could not restrict the directory mode — continuing:', err)
    return false
  }
}

/**
 * The account name to hand `icacls`. The bare username is what resolves on a
 * standalone machine and on a domain-joined one alike (`icacls` checks the
 * local SAM first, then the domain), which is why it is not qualified with
 * `USERDOMAIN` — a stale or wrong `USERDOMAIN` in the environment would make
 * an otherwise-fine call fail, and the environment is not the authority on
 * who this process is running as. `os.userInfo()` is.
 */
function currentUserAccountName(): string | null {
  try {
    const name = userInfo().username.trim()
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

async function restrictWithIcacls(dir: string, options: PrivateTempDirOptions): Promise<boolean> {
  const account = currentUserAccountName()
  if (!account) {
    console.error('[ai/privateTempDir] could not read the current user name — the directory keeps its inherited ACL')
    return false
  }

  try {
    const result = await runCappedSubprocess(
      ['icacls', dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)(F)`],
      {
        cwd: tmpdir(),
        env: minimalSubprocessEnv(),
        timeoutMs: ICACLS_TIMEOUT_MS,
        maxStdoutBytes: ICACLS_MAX_OUTPUT_BYTES,
        maxStderrBytes: ICACLS_MAX_OUTPUT_BYTES,
        ...(options.spawn ? { spawn: options.spawn } : {}),
      },
    )
    if (result.exitCode !== 0) {
      // `icacls` prints the path it processed, never the contents — but the
      // directory name is a temp path on this machine, so only the exit code
      // is logged, matching what every other refusal here reveals.
      console.error(`[ai/privateTempDir] icacls exited ${String(result.exitCode)} — the directory keeps its inherited ACL`)
      return false
    }
    return true
  } catch (err) {
    console.error('[ai/privateTempDir] icacls could not be run — the directory keeps its inherited ACL:', err)
    return false
  }
}
