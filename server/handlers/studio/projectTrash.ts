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
 * That is why `parseTrashEntryName` exists: the entry name IS the record.
 * `<slug>-<iso stamp>[-<n>]` is written by `availableTrashPath` and read back
 * by the listing, so the two live in this one file and cannot drift apart.
 *
 * ## The three verbs, and which of them can destroy something
 *
 * `listTrashedProjects` / `restoreTrashedProject` / `purgeTrashedProject` are
 * the launcher's Trash panel. Restore is `trashStudioProject` run backwards —
 * the same `renameSync`, the same filesystem, no copy — and it REFUSES rather
 * than merges when a live project already occupies the slug it wants back:
 * a restore that silently overwrote a project the user has since re-created
 * would destroy exactly what this module exists to protect.
 *
 * Purge is the only call in the feature that erases anything, and it is the
 * reason the trash is not a UI-only convention: a user who deletes a project
 * to free disk space has to be able to finish the job somewhere, and doing it
 * here — behind `studio.write`, addressed by an entry name that must resolve
 * to a direct child of `.trash/` — is safer than sending them to `rm -rf`.
 *
 * Every one of the three re-runs the same parent-comparison containment check
 * `trashStudioProject` uses, against the trash root rather than the projects
 * root. It is repeated per function rather than hoisted into a "validated
 * path" type because each verb's failure mode differs (404 vs 400 vs 409) and
 * a shared helper that returned a path would hide which one applied.
 *
 * ## Why `.trash` has to be skipped by the launcher
 *
 * Every immediate subfolder of `studio-workspace/` IS a project
 * (`listStudioProjects`), so without an explicit skip the trash would list
 * itself as a project named `.trash` — and opening it would point Studio at a
 * directory whose children are deleted projects. `PROJECTS_TRASH_DIR_NAME`
 * lives in `./projectDirGuard.ts` — the module that owns "which paths are
 * projects" — and every consumer, this one included, imports it from there
 * rather than repeating the string.
 *
 * It is deliberately NOT added to `EXCLUDED_WORKSPACE_DIR_NAMES`: that set
 * names directories to skip INSIDE a project (`node_modules`, `dist`, …), and
 * this one is a sibling OF projects. Same word, different level.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PROJECTS_TRASH_DIR_NAME, resolveWorkspaceProjectDir, type ProjectDirRejection } from './projectDirGuard'
import { readStudioMeta } from './studioMeta'

/**
 * Why a trash operation could not be performed. The routes map `not-found` to
 * 404, `slug-taken` to 409 and everything else to 400 — a caller naming a path
 * that was never a project has a different bug from one naming a project that
 * is already gone, and a restore blocked by a live project of the same name is
 * neither: it is a state the user can fix by renaming, and the message says so.
 */
export type ProjectTrashFailure = ProjectDirRejection | 'not-in-trash' | 'slug-taken'

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
 * validated as a project — by `resolveWorkspaceProjectDir`, the single
 * containment rule this route shares with `/duplicate` and `/thumbnail`. See
 * `./projectDirGuard.ts` for why the check compares the resolved PARENT
 * rather than testing a prefix.
 */
export function trashStudioProject(projectsRoot: string, requestedDir: string): string {
  const root = resolve(projectsRoot)
  const resolved = resolveWorkspaceProjectDir(root, requestedDir, 'deleted')
  if (!resolved.ok) throw new ProjectTrashError(resolved.reason, resolved.message)

  const folder = basename(resolved.dir)
  const trashRoot = join(root, PROJECTS_TRASH_DIR_NAME)
  mkdirSync(trashRoot, { recursive: true })
  const destination = availableTrashPath(trashRoot, folder)
  // Same filesystem by construction (the trash is inside the projects root),
  // so this is an atomic rename rather than a copy — a delete can never leave
  // a half-copied project behind.
  renameSync(resolved.dir, destination)
  return destination
}

// ---------------------------------------------------------------------------
// Reading the trash back — the launcher's Trash panel
// ---------------------------------------------------------------------------

/**
 * The stamp `availableTrashPath` appends, read backwards: an ISO instant with
 * `:`/`.` swapped for `-`, optionally followed by `-<n>` from a same-
 * millisecond collision. Anchored at the end so a project whose own slug
 * contains hyphens and digits (`acme-2`) still splits at the right place.
 */
const TRASH_STAMP_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?$/

/** One entry in the workspace trash, as the launcher's Trash panel lists it. */
export interface TrashedProject {
  /** The folder name inside `.trash/` — the id every trash route addresses. Never a path. */
  entry: string
  /** Display name from the trashed project's own `.studio/meta.json`, else the slug it will restore to. */
  name: string
  /** The folder name `restoreTrashedProject` will move it back to. */
  slug: string
  /** When it was deleted (epoch ms), decoded from the entry name — not the folder's mtime, which a restore-then-delete would move. */
  trashedAt: number
  /** Bytes on disk, summed over every file in the tree (`node_modules` included — this number answers "how much would purging free?"). */
  sizeBytes: number
  /** True when the walk hit `TRASH_SIZE_WALK_LIMIT` and `sizeBytes` is therefore a floor, not a total. */
  sizeCapped: boolean
}

/**
 * `<slug>-<stamp>` -> its two halves, or `null` for a directory that does not
 * carry a stamp at all (something a human dropped into `.trash/` by hand).
 * Pure — this is the whole "manifest", so it is unit-tested directly.
 */
export function parseTrashEntryName(entry: string): { slug: string; trashedAt: number } | null {
  const match = TRASH_STAMP_RE.exec(entry)
  if (!match) return null
  const slug = entry.slice(0, match.index)
  if (slug.length === 0) return null
  // Undo the `:`/`.` substitution: `2026-09-07T12-34-56-789Z` came from
  // `2026-09-07T12:34:56.789Z`, and only those three separators moved.
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  const trashedAt = Date.parse(iso)
  return Number.isNaN(trashedAt) ? null : { slug, trashedAt }
}

/**
 * How many directory entries a size walk visits before giving up. A trashed
 * project may still carry its `node_modules`, which is exactly the case where
 * the size number is most worth showing and most expensive to compute; this
 * bound keeps opening the Trash panel cheap and the listing reports
 * `sizeCapped` so the UI can say "at least" rather than lie.
 */
const TRASH_SIZE_WALK_LIMIT = 20_000

/** Total bytes of every file under `dir`, and whether the walk was cut short. Never throws — an unreadable entry contributes nothing. */
function treeSize(dir: string): { bytes: number; capped: boolean } {
  let bytes = 0
  let visited = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > TRASH_SIZE_WALK_LIMIT) return { bytes, capped: true }
      const full = join(current, entry.name)
      // Never follow symlinks: a link into the user's home directory would
      // otherwise be summed as if the trash held those bytes.
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          bytes += statSync(full).size
        } catch {
          // A file that vanished between readdir and stat contributes nothing.
        }
      }
    }
  }
  return { bytes, capped: false }
}

/**
 * Every project currently in the trash, newest deletion first.
 *
 * A missing trash directory is not an error — it simply means nothing has ever
 * been deleted. Entries whose names carry no stamp are skipped rather than
 * listed with a guessed slug: this listing drives Restore, and restoring to a
 * name nobody recorded is how a hand-dropped folder would end up overwriting a
 * live project.
 */
export function listTrashedProjects(projectsRoot: string): TrashedProject[] {
  const trashRoot = join(resolve(projectsRoot), PROJECTS_TRASH_DIR_NAME)
  if (!existsSync(trashRoot)) return []

  const listed: TrashedProject[] = []
  for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = parseTrashEntryName(entry.name)
    if (!parsed) continue
    const dir = join(trashRoot, entry.name)
    const size = treeSize(dir)
    listed.push({
      entry: entry.name,
      name: readStudioMeta(dir).displayName ?? parsed.slug,
      slug: parsed.slug,
      trashedAt: parsed.trashedAt,
      sizeBytes: size.bytes,
      sizeCapped: size.capped,
    })
  }
  return listed.sort((a, b) => b.trashedAt - a.trashedAt)
}

/**
 * Resolves a caller-supplied trash entry NAME to its directory, applying the
 * same parent-comparison containment check `trashStudioProject` applies to a
 * project: the resolved path's parent must be the trash root itself. That
 * rejects `..` traversal, a nested path, and the trash root itself in one
 * check, and cannot be fooled by a sibling directory whose name merely begins
 * with the same characters.
 */
function resolveTrashEntry(projectsRoot: string, entry: string): string {
  const trashRoot = join(resolve(projectsRoot), PROJECTS_TRASH_DIR_NAME)
  const target = resolve(trashRoot, entry)
  if (dirname(target) !== trashRoot) {
    throw new ProjectTrashError('not-in-trash', 'Only an entry directly inside the workspace trash can be addressed.')
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new ProjectTrashError('not-found', 'That project is no longer in the trash.')
  }
  return target
}

/**
 * Moves a trashed project back into the workspace and returns its restored
 * directory — `trashStudioProject` run backwards, the same `renameSync` on the
 * same filesystem.
 *
 * Refuses when a live project already occupies the slug. Merging or
 * auto-renaming were both considered and both destroy information: a merge
 * would overwrite files in a project the user has been working in, and an
 * auto-rename would quietly produce a second project whose folder no longer
 * matches the one the user deleted. The user is told which name is in the way
 * and can rename either side first.
 */
export function restoreTrashedProject(projectsRoot: string, entry: string): string {
  const root = resolve(projectsRoot)
  const source = resolveTrashEntry(root, entry)
  const parsed = parseTrashEntryName(basename(source))
  if (!parsed) {
    throw new ProjectTrashError('not-in-trash', 'That trash entry does not record which project it came from.')
  }

  const destination = join(root, parsed.slug)
  if (existsSync(destination)) {
    throw new ProjectTrashError(
      'slug-taken',
      `A project already lives in "${parsed.slug}". Rename it, then restore this one.`,
    )
  }
  renameSync(source, destination)
  return destination
}

/**
 * Erases one trashed project permanently. The only call in this feature that
 * deletes anything — gated on `studio.write` at the route, and addressed by an
 * entry name that `resolveTrashEntry` has already proven to be a direct child
 * of the trash root, so `rmSync` can never be pointed at a live project or at
 * anything outside `studio-workspace/`.
 */
export function purgeTrashedProject(projectsRoot: string, entry: string): void {
  rmSync(resolveTrashEntry(resolve(projectsRoot), entry), { recursive: true, force: true })
}
