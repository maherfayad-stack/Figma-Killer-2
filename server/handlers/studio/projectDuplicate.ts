/**
 * projectDuplicate — copying a whole project, honestly.
 *
 * ## What gets copied, and what deliberately does not
 *
 * A studio project is the user's own React repository, so "duplicate" is a
 * recursive `cpSync` of the folder — source, stylesheets, assets, the
 * `.studio/` sidecar (boards, frame defaults, trust tier, probe cache) and
 * all. Four directory names are skipped, the same set every other workspace
 * walk skips (`EXCLUDED_WORKSPACE_DIR_NAMES` plus `.git`):
 *
 *   - `node_modules` — the single reason this needs a filter at all. It is
 *     regenerable by definition and routinely 100× the size of everything
 *     else in the repo; copying it turns a sub-second action into a minute
 *     of I/O. The copy is `bun install` away from being identical.
 *   - `dist` / `.next` / `.turbo` — build output, same argument.
 *   - `.git` — a copied `.git` is not a fork, it is a second working copy of
 *     someone else's history pointing at their remote. Push from it and you
 *     push to the original's origin. The duplicate starts with no history,
 *     which is the honest state for a folder nobody has committed yet.
 *
 * ## Why the display name is decided before the folder
 *
 * `.studio/meta.json`'s `displayName` is what the launcher sorts and renders;
 * the folder slug is a stable identifier assigned once (`projectRoutes.ts`'s
 * rename route exists precisely because those two are not the same string).
 * So the duplicate picks a free DISPLAY name first — `Acme copy`, then
 * `Acme copy 2`, … — and slugifies that. Deriving the display name from a
 * de-duplicated folder name instead would show the user `acme-copy-2` as a
 * project title.
 *
 * ## Containment
 *
 * Same posture as `./projectTrash.ts`, and for the same reason: `requestedDir`
 * is caller-supplied. The resolved directory's PARENT must be the projects
 * root itself, which rejects `..` traversal, a nested path like
 * `<project>/pages`, and the workspace root in one check, and cannot be fooled
 * by a sibling root whose name merely shares a prefix.
 */
import { cpSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import {
  listStudioProjects,
  safeProjectFolderName,
  studioProjectSummary,
  type StudioProjectSummary,
} from '../studioProjects'
import { generateStudioProjectGuide } from './projectGuide'
import { mergeStudioMeta } from './studioMeta'
import { PROJECTS_TRASH_DIR_NAME } from './projectTrash'

/**
 * Why a project could not be duplicated. The route maps `not-found` to 404,
 * `not-a-project` to 400, and `name-taken` to 409 — three different bugs on
 * the caller's side, and the last one is recoverable by typing another name.
 */
export type ProjectDuplicateFailure = 'not-a-project' | 'not-found' | 'name-taken'

export class ProjectDuplicateError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: `erasableSyntaxOnly` is on, and a parameter property is syntax
  // that has to be compiled away rather than erased.
  readonly reason: ProjectDuplicateFailure

  constructor(reason: ProjectDuplicateFailure, message: string) {
    super(message)
    this.name = 'ProjectDuplicateError'
    this.reason = reason
  }
}

/**
 * Directory names never copied into the duplicate. `.git` is added to the
 * shared exclusion set here rather than there because that set governs which
 * directories a PARSE walks, and `.studio` is in it for that reason — but
 * `.studio` is exactly the sidecar a duplicate must carry, so this module
 * cannot reuse the set wholesale.
 */
const UNCOPIED_DIR_NAMES: ReadonlySet<string> = new Set(
  [...EXCLUDED_WORKSPACE_DIR_NAMES, '.git'].filter((name) => name !== '.studio'),
)

/** How many `<name> copy N` candidates to try before giving up. Reaching this is not a real case. */
const MAX_NAME_ATTEMPTS = 1000

/**
 * The first display name of the form `<base> copy`, `<base> copy 2`, … that no
 * existing project already uses AND whose slug is not already a folder on
 * disk. Both checks matter: two projects can share a slug prefix without
 * sharing a display name, and the reverse.
 */
function availableCopyName(projectsRoot: string, base: string): { displayName: string; folder: string } {
  const taken = new Set(listStudioProjects(projectsRoot).map((project) => project.name))
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const displayName = attempt === 1 ? `${base} copy` : `${base} copy ${attempt}`
    const folder = safeProjectFolderName(displayName)
    if (folder && !taken.has(displayName) && !existsSync(join(projectsRoot, folder))) {
      return { displayName, folder }
    }
  }
  throw new ProjectDuplicateError('name-taken', `Could not find a free name based on "${base}".`)
}

/**
 * Copies one project beside itself and returns the new project's summary.
 *
 * `requestedName`, when given, is the duplicate's display name verbatim — no
 * " copy" suffix, because the user just typed what they wanted it called. It
 * is rejected (409) when another project already answers to it, or when it
 * slugifies to nothing.
 */
export function duplicateStudioProject(
  projectsRoot: string,
  requestedDir: string,
  requestedName?: string,
): StudioProjectSummary {
  const root = resolve(projectsRoot)
  const source = resolve(requestedDir)

  if (dirname(source) !== root) {
    throw new ProjectDuplicateError(
      'not-a-project',
      'Only a project directly inside the workspace can be duplicated.',
    )
  }
  if (basename(source) === PROJECTS_TRASH_DIR_NAME) {
    throw new ProjectDuplicateError('not-a-project', 'The trash is not a project.')
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new ProjectDuplicateError('not-found', 'Project not found.')
  }

  const trimmed = requestedName?.trim()
  let displayName: string
  let folder: string
  if (trimmed) {
    displayName = trimmed
    folder = safeProjectFolderName(displayName)
    if (!folder) {
      throw new ProjectDuplicateError('name-taken', 'Project name must contain at least one letter or digit.')
    }
    if (existsSync(join(root, folder)) || listStudioProjects(root).some((p) => p.name === displayName)) {
      throw new ProjectDuplicateError('name-taken', `A project named "${displayName}" already exists.`)
    }
  } else {
    const auto = availableCopyName(root, studioProjectSummary(source).name)
    displayName = auto.displayName
    folder = auto.folder
  }

  const destination = join(root, folder)
  cpSync(source, destination, {
    recursive: true,
    // Never follow a symlink out of the source tree — the same rule
    // `listWorkspaceFiles` applies, for the same reason.
    dereference: false,
    filter: (src) => !UNCOPIED_DIR_NAMES.has(basename(src)),
  })

  // The copy currently answers to the ORIGINAL's display name (its
  // `.studio/meta.json` came along verbatim), which would put two identically
  // named projects in the launcher. Merge rather than write: everything else
  // in that file — boards, frame defaults, trust tier, the probe cache — is
  // still true of the copy and must survive.
  //
  // `lastOpenedAt` is the one field that is NOT true of the copy: nobody has
  // opened this project, and it should say so until someone does.
  // `writeStudioMeta` drops undefined values on `JSON.stringify`, so this
  // removes the key rather than writing a null.
  mergeStudioMeta(destination, { displayName, lastOpenedAt: undefined })
  // `CLAUDE.md` + the design-system references, regenerated rather than
  // trusted from the copy: the guide the source carried names the source's
  // paths and its own project, and a stale guide is what the agent reads
  // first. Same call, same reason, as the create route.
  generateStudioProjectGuide(destination)

  return studioProjectSummary(destination)
}
