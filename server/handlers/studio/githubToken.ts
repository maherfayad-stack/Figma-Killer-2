/**
 * githubToken — the one place Studio answers "does this user have a GitHub
 * credential, and what is it".
 *
 * **MERGE POINT.** This file is owned by work order **G2** (sign in to
 * GitHub), which stores a per-user token encrypted in the additive
 * `git_credentials` migration and implements this lookup against it. This copy
 * exists so the work orders that *consume* a token — G4's fetch/pull over
 * HTTPS and G5's pull-request call — can be written, reviewed and tested
 * against the real signature before G2 lands. It returns `null`, which is the
 * honest answer for a server where nobody has signed in.
 *
 * When G2 lands, its implementation replaces this body wholesale. Callers do
 * not change: every one of them already treats `null` as "no credential —
 * fall back to the user's own credential helper, or tell them to sign in",
 * because that is the state this stub always produces.
 *
 * Two rules hold in both versions and must survive the merge:
 *
 *   - **A token is never read from the environment.** It belongs to a user,
 *     arrives with their request, and is scoped to them. `gitRunner.ts`'s env
 *     allowlist deliberately contains no token variable.
 *   - **A token is never logged, never echoed in an error, and never written
 *     into the project's git config.** It reaches git only through the
 *     one-shot askpass `runGit`'s `credential` option provisions.
 */

/**
 * The GitHub token this user has connected, or `null` when they have not
 * connected one. Never throws — "no credential" is an ordinary answer, not a
 * failure, and every caller has a sensible path for it.
 */
export async function getGithubTokenForUser(userId: string): Promise<string | null> {
  void userId
  return null
}
