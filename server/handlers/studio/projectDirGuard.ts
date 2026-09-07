/**
 * projectDirGuard — the one rule for "is this caller-supplied path a project
 * this server may act on?".
 *
 * Three routes ask that question about a `dir` that arrived over HTTP —
 * `POST /delete` (`./projectTrash.ts`), `POST /duplicate`
 * (`./projectDuplicate.ts`) and `GET /thumbnail`
 * (`./projectThumbnailRoute.ts`) — and the first two each carried their own
 * copy of the same four lines. A containment check is precisely the kind of
 * rule that must not exist in three places: a future correction applied to one
 * copy leaves the others exploitable, and nothing about the code says so.
 *
 * The check itself is unchanged from the one `projectTrash.ts` introduced:
 * the resolved directory's PARENT must be the projects root itself. Comparing
 * the parent — rather than testing a `startsWith` prefix — rejects `..`
 * traversal, a nested path like `<project>/pages`, and the workspace root
 * itself in a single check, and cannot be fooled by a sibling root whose name
 * merely begins with the same characters.
 *
 * `PROJECTS_TRASH_DIR_NAME` lives here rather than beside the code that
 * CREATES the directory, because its meaning is this module's subject: it
 * names the one immediate subfolder of `studio-workspace/` that is NOT a
 * project. Every consumer — the launcher listing's skip, the trash's refusal
 * to trash itself, the duplicate's, this guard's — is asking that question,
 * not asking where deleted projects go.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/** Directory under `studio-workspace/` that holds deleted projects. Not a project — see the module doc. */
export const PROJECTS_TRASH_DIR_NAME = '.trash'

/**
 * Why a path was refused. Callers map these to their own status codes:
 * `not-a-project` is a caller bug (a path that was never a project), while
 * `not-found` is a project that is no longer there — genuinely different
 * situations that deserve different answers.
 */
export type ProjectDirRejection = 'not-a-project' | 'not-found'

export type WorkspaceProjectDirResult =
  | { ok: true; dir: string }
  | { ok: false; reason: ProjectDirRejection; message: string }

/**
 * Resolves `requestedDir` to a real project directly inside `projectsRoot`,
 * or explains why it is not one.
 *
 * `verb` completes the refusal sentence ("…can be `deleted`.") so each caller
 * keeps saying what IT was asked to do while sharing the rule that decides.
 */
export function resolveWorkspaceProjectDir(
  projectsRoot: string,
  requestedDir: string,
  verb: string,
): WorkspaceProjectDirResult {
  const root = resolve(projectsRoot)
  const target = resolve(requestedDir)

  if (dirname(target) !== root) {
    return {
      ok: false,
      reason: 'not-a-project',
      message: `Only a project directly inside the workspace can be ${verb}.`,
    }
  }
  if (basename(target) === PROJECTS_TRASH_DIR_NAME) {
    return { ok: false, reason: 'not-a-project', message: 'The trash is not a project.' }
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, reason: 'not-found', message: 'Project not found.' }
  }
  return { ok: true, dir: target }
}
