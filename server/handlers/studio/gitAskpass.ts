/**
 * gitAskpass — how a stored GitHub token reaches `git` for exactly one
 * invocation, and how it stops existing afterwards.
 *
 * ## Why not an environment variable
 *
 * Because a subprocess's environment is inherited by everything it spawns, is
 * readable from `/proc/<pid>/environ` by the same user, and outlives the call
 * in any crash dump that captures it. `gitRunner.ts`'s env allowlist exists
 * precisely so a child sees no secret, and the token must not be the exception
 * that undoes it.
 *
 * ## Why not the URL
 *
 * `https://x-access-token:TOKEN@github.com/...` puts the token in **argv**,
 * which is world-readable in the process table, and git echoes remote URLs
 * into its own error messages — so a failed push would print the credential
 * into a log the user might paste into an issue.
 *
 * ## What this does instead
 *
 * Writes one short `sh` script to a fresh private temp directory, points
 * `GIT_ASKPASS` at it, and deletes the directory in a `finally`. Git calls the
 * program once per prompt with the prompt text as `argv[1]`
 * ("Username for 'https://github.com': " / "Password for '…': ") and reads the
 * answer off stdout. The script answers `x-access-token` for the username —
 * GitHub's documented username for token authentication — and the token for
 * anything else.
 *
 * Three details are load-bearing:
 *
 *   - **On POSIX the file is created 0600 (directory 0700), before anything is
 *     written into it.** `mkdtempSync` already creates a directory only this
 *     user can enter; the `mode` on `writeFileSync` closes the window where
 *     another local account could read the file between creation and chmod.
 *
 *     **On Windows none of that applies, and pretending otherwise would be a
 *     lie in a security comment.** Node maps `mode` onto the read-only
 *     attribute and nothing else — `statSync` on the script this function
 *     writes reports `666`, for both the file and the directory, however it
 *     was asked for. What keeps the token private there is the LOCATION:
 *     `os.tmpdir()` is `%TEMP%`, normally `C:\Users\<user>\AppData\Local\Temp`,
 *     whose ACL already admits only that account and administrators. That is
 *     an assumption about the host, not something this code enforces, and an
 *     operator who points `TMP`/`TEMP` at a shared directory (`C:\Temp`, a
 *     service account's configured temp) makes the script world-readable for
 *     the life of one git invocation. The exposure is bounded by `dispose()`,
 *     not by a mode bit.
 *   - **The token is embedded inside single quotes, and a token that could
 *     escape them is REFUSED** (`isEmbeddableGitToken`). GitHub's token
 *     formats are `[A-Za-z0-9_]` and this rejects everything else, so the
 *     quoting cannot be broken by a crafted value — that is a guard, not
 *     decoration, because the alternative is shell injection into a script
 *     this process wrote.
 *   - **A shebang, on every platform.** Git for Windows resolves a `#!`
 *     interpreter through its own bundled `sh` when it spawns the askpass
 *     program, which is why one script file works on all three platforms and
 *     a `.bat` twin is not needed.
 *
 * ## What this does NOT decide: which host gets the token
 *
 * An askpass program is handed a PROMPT, not a destination it can refuse —
 * git asks "Password for 'https://x-access-token@<whatever origin says>'" and
 * whatever the program prints goes to that host. So the script below answers
 * every password prompt of the invocation it was written for, github.com or
 * not. **Deciding whether a remote may see the token is the caller's job**,
 * and it happens before this function is ever called: `gitClone.ts` only ever
 * has a `parseGithubRemoteUrl`-allowlisted URL, and `pushCurrentBranch` reads
 * `origin`'s push URL and drops the credential unless that same allowlist
 * accepts it. Pass `credential` for an unchecked remote and you have handed
 * that remote a `repo`-scoped token.
 *
 * Nothing here logs. The script's contents, the path it was written to, and
 * the token are all absent from every message this module or its caller
 * produces.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** GitHub's documented username for token-over-HTTPS authentication. Any non-empty value works; this one is the honest label. */
export const GIT_TOKEN_USERNAME = 'x-access-token'

/**
 * A token Studio is willing to write into a shell script. Every GitHub token
 * format — `ghp_`, `gho_`, `ghs_`, `github_pat_`, and the legacy 40-hex
 * classic PAT — is `[A-Za-z0-9_]`, so this charset is not a restriction in
 * practice. A value outside it is refused rather than escaped: an escaping
 * bug here is remote code execution as the server user.
 */
export function isEmbeddableGitToken(token: string): boolean {
  return /^[A-Za-z0-9_]{8,255}$/.test(token)
}

/** A one-shot askpass script on disk. `dispose()` is idempotent and never throws. */
export interface AskpassScript {
  /** Absolute path to hand to `GIT_ASKPASS`. */
  path: string
  dispose(): void
}

/**
 * Writes the script and returns its path plus the cleanup. Throws when the
 * token is not embeddable — callers treat that as "this credential is
 * unusable", never as "run git without it silently".
 */
export function writeAskpassScript(token: string): AskpassScript {
  if (!isEmbeddableGitToken(token)) {
    throw new Error('The stored GitHub token is not in a format Studio can use. Sign in again.')
  }

  // 0700 by mkdtemp's own semantics on POSIX — no other local account can even
  // list it. On Windows the mode is not applied at all and privacy comes from
  // `%TEMP%`'s ACL instead; see the module doc, which says so rather than
  // letting these three calls imply a guarantee they do not make there.
  const dir = mkdtempSync(join(tmpdir(), 'studio-askpass-'))
  const path = join(dir, 'askpass.sh')

  // `case` on the prompt text is how every askpass helper distinguishes the
  // two questions; git passes the whole prompt as the single argument.
  const script =
    '#!/bin/sh\n' +
    'case "$1" in\n' +
    `  Username*) printf '%s' '${GIT_TOKEN_USERNAME}' ;;\n` +
    `  *) printf '%s' '${token}' ;;\n` +
    'esac\n'

  writeFileSync(path, script, { mode: 0o600 })
  // Executable for the owner only. Written as a second call because the
  // `mode` above is masked by the process umask on some hosts, and git must
  // be able to exec this file.
  chmodSync(path, 0o700)

  let disposed = false
  return {
    path,
    dispose() {
      if (disposed) return
      disposed = true
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        // A token outliving its call is worth knowing about, so this is
        // logged — but never rethrown into a git operation that has already
        // succeeded, and the log carries the OS error, not the script body.
        console.error('[studio/gitAskpass] could not remove the one-shot askpass script', err)
      }
    },
  }
}
