/**
 * projectTrash — removing a whole project, recoverably.
 *
 * ## Why the files move instead of being deleted
 *
 * `studio-workspace/<project>/` is the user's own repository, and this repo's
 * own agent rules describe it as "the user's real project data with no other
 * copy". A dashboard button wired to `rmSync(dir, { recursive: true })` would
 * therefore be the most destructive control in the product — one misclick from
 * unrecoverable, with no undo anywhere in the stack to reach for. So "delete"
 * MOVES the folder into `studio-workspace/.trash/<folder>-<timestamp>/`, and
 * nothing is erased.
 *
 * This is the posture `pageTrash.ts` already takes for a single page, one
 * level up: a trash is a PLACE the files go, not a flag on a record. The only
 * difference is where it lives. A trashed page hides inside its own project's
 * `.studio/` sidecar; a trashed project has no project left to hide inside, so
 * the workspace root holds it.
 *
 * ## Why there is no manifest here
 *
 * `pageTrash.ts` needs `manifest.json` because it moves a SCATTERED set of
 * files — the page plus the stylesheets only it imported — and restoring has
 * to put each one back at a nested path a flat copy cannot recover.
 *
 * A project is one directory moved whole. Its `.studio/meta.json` (display
 * name, frame defaults, boards) travels inside it, so the moved folder is
 * already self-describing and restoring it is `mv` back. A manifest here would
 * record only what the folder name already says, and would be a second thing
 * to keep in step.
 *
 * ## Why `.trash` has to be skipped by the launcher
 *
 * Every immediate subfolder of `studio-workspace/` IS a project
 * (`listStudioProjects`), so without an explicit skip the trash would list
 * itself as a project named `.trash` — and opening it would point Studio at a
 * directory whose children are deleted projects. `PROJECTS_TRASH_DIR_NAME` is
 * declared here, beside the code that creates the directory, and
 * `listStudioProjects` imports it rather than repeating the string.
 *
 * It is deliberately NOT added to `EXCLUDED_WORKSPACE_DIR_NAMES`: that set
 * names directories to skip INSIDE a project (`node_modules`, `dist`, …), and
 * this one is a sibling OF projects. Same word, different level.
 */
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory under `studio-workspace/` that holds deleted projects. */
export const PROJECTS_TRASH_DIR_NAME = '.trash'

/**
 * Why a directory could not be trashed. The route maps `not-found` to 404 and
 * `not-a-project` to 400 — a caller naming a path that was never a project has
 * a different bug from one naming a project that is already gone.
 */
export type ProjectTrashFailure = 'not-a-project' | 'not-found'

export class ProjectTrashError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: `erasableSyntaxOnly` is on, and a parameter property is syntax
  // that has to be compiled away rather than erased.
  readonly reason: ProjectTrashFailure

  constructor(reason: ProjectTrashFailure, message: string) {
    super(message)
    this.name = 'ProjectTrashError'
    this.reason = reason
  }
}

/**
 * How many same-millisecond collisions to try before giving up. Reaching this
 * means something is wrong other than a coincidence, and looping forever on a
 * delete path is worse than failing loudly.
 */
const MAX_TRASH_COLLISION_ATTEMPTS = 100

/**
 * A path inside the trash that nothing occupies yet.
 *
 * The timestamp is an ISO instant with `:` and `.` swapped for `-`: sortable,
 * readable, and legal on every filesystem. Colliding rather than overwriting
 * matters more here than anywhere else in the codebase — a silent overwrite
 * would destroy the earlier deletion, which is the one thing this module
 * exists to prevent.
 */
function availableTrashPath(trashRoot: string, folder: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = join(trashRoot, `${folder}-${stamp}`)
  if (!existsSync(base)) return base
  for (let attempt = 2; attempt <= MAX_TRASH_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find a free trash path for "${folder}".`)
}

/**
 * Moves one project into the workspace trash and returns where it landed.
 *
 * `requestedDir` is caller-supplied, so it is validated as a PATH before it is
 * validated as a project: the resolved directory's parent must be the projects
 * root itself. Comparing the parent — rather than testing a `startsWith`
 * prefix — rejects `..` traversal, a nested path like `<project>/pages`, and
 * the workspace root itself in a single check, and cannot be fooled by a
 * sibling root whose name merely begins with the same characters.
 */
export function trashStudioProject(projectsRoot: string, requestedDir: string): string {
  const root = resolve(projectsRoot)
  const target = resolve(requestedDir)

  if (dirname(target) !== root) {
    throw new ProjectTrashError(
      'not-a-project',
      'Only a project directly inside the workspace can be deleted.',
    )
  }
  const folder = basename(target)
  if (folder === PROJECTS_TRASH_DIR_NAME) {
    throw new ProjectTrashError('not-a-project', 'The trash is not a project.')
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new ProjectTrashError('not-found', 'Project not found.')
  }

  const trashRoot = join(root, PROJECTS_TRASH_DIR_NAME)
  mkdirSync(trashRoot, { recursive: true })
  const destination = availableTrashPath(trashRoot, folder)
  // Same filesystem by construction (the trash is inside the projects root),
  // so this is an atomic rename rather than a copy — a delete can never leave
  // a half-copied project behind.
  renameSync(target, destination)
  return destination
}
