/**
 * importUpload — `POST /admin/api/studio/import-upload`, the second fetch
 * strategy over `archiveIngest.ts`'s shared engine (the first is
 * `studioGithubImport.ts`'s GitHub zipball fetch). Lands a project on disk
 * from something the browser already has in hand, no GitHub URL required:
 *
 *   - `kind: 'zip'` — one uploaded `.zip` file, unpacked with `fflate`
 *     exactly like the GitHub path, except we don't know in advance whether
 *     the archive wraps its content in one root folder the way a GitHub
 *     zipball always does (`detectSharedZipRoot` decides per-archive instead
 *     of assuming either way).
 *   - `kind: 'directory'` — N separate `File`s from an
 *     `<input webkitdirectory>` folder picker. The CLIENT strips the picked
 *     folder's own name off each file's `webkitRelativePath` before
 *     uploading (sending the folder's name separately as `rootName`), so
 *     this route passes `stripRootFolder: false` — there is nothing left to
 *     strip. That keeps the "does this entry name have a root folder to
 *     strip" decision out of the shared engine, per `archiveIngest.ts`'s
 *     "parameterize, don't branch" rule.
 *
 * The request body is `multipart/form-data`:
 *   - `kind`    — `'zip' | 'directory'`
 *   - `rootName` (optional) — a human-friendly project name; slugified
 *     server-side into the target folder (`deriveUploadTargetDir`), same
 *     pattern `POST /admin/api/studio/create` already uses for its `name`
 *     field. There is deliberately NO `dir`/target field: the write target
 *     is always derived from this slug, confined under
 *     `studio-workspace/<slug>` the same way `runGithubImport` confines its
 *     target to `studio-workspace/<owner>-<repo>` — never a caller-supplied
 *     path (see `archiveIngest.ts`'s module doc for why that matters).
 *   - `file`    — one entry for `kind: 'zip'`; one-or-more for `kind: 'directory'`.
 *
 * Response mirrors `POST /admin/api/studio/import-github`:
 * `{ ok, dir, files, skipped }`.
 */
import { join } from 'node:path'
import { unzipSync, type Unzipped } from 'fflate'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse } from '../../http'
import {
  ArchiveIngestError,
  MAX_ARCHIVE_BYTES,
  createArchiveEntryDecider,
  readFormDataWithLimit,
  writeArchiveToWorkspace,
} from './archiveIngest'
import { nextProjectName, projectsRootDir, safeProjectFolderName, writeProjectMeta } from '../studioProjects'

const ImportUploadFieldsSchema = Type.Object({
  kind: Type.Union([Type.Literal('zip'), Type.Literal('directory')]),
  rootName: Type.Optional(Type.String()),
})

/**
 * Every entry name in a zip shares one top-level segment (GitHub's own
 * "Download ZIP" produces exactly this shape, e.g. `repo-branch/…` — a very
 * common thing to re-upload here), or `null` when they don't (an archive
 * whose content sits at the top level already, or that mixes multiple
 * top-level dirs). Used to decide `stripRootFolder` for an uploaded zip
 * without guessing — `resolveZipEntryRelPath` never assumes a root folder is
 * present unless the caller says so.
 *
 * Requires at least TWO entries before considering a shared segment a
 * "wrapper folder" — a single-entry archive like `pages/Home.tsx` is
 * genuinely ambiguous (is `pages` a synthetic wrapper, or a real directory
 * the project needs?), and stripping it would silently destroy real
 * structure. With two or more entries agreeing on the same top segment, a
 * synthetic wrapper is overwhelmingly the more likely explanation.
 */
export function detectSharedZipRoot(entryNames: ReadonlyArray<string>): string | null {
  if (entryNames.length < 2) return null
  let root: string | null = null
  for (const name of entryNames) {
    const firstSlash = name.indexOf('/')
    if (firstSlash === -1) return null // an entry sits at the top level — no shared root
    const segment = name.slice(0, firstSlash)
    if (segment.length === 0) return null
    if (root === null) root = segment
    else if (root !== segment) return null
  }
  return root
}

/** Lists every entry name in a zip WITHOUT inflating any of them — `filter` always returns `false`, so `unzipSync` only ever parses headers. */
function listZipEntryNames(zipBytes: Uint8Array): string[] {
  const names: string[] = []
  unzipSync(zipBytes, {
    filter(file) {
      names.push(file.name)
      return false
    },
  })
  return names
}

/**
 * Target folder for an upload import: a human-friendly `rootName` (or an
 * auto-generated "Untitled …" when omitted/empty), slugified into a
 * filesystem-safe folder confined under `projectsRoot` — the same
 * `safeProjectFolderName` used by `POST /admin/api/studio/create`. Never
 * accepts a raw path from the caller.
 */
function deriveUploadTargetDir(rootName: string | undefined, projectsRoot: string): { dir: string; displayName: string } {
  const trimmed = rootName?.trim()
  const displayName = trimmed && trimmed.length > 0 ? trimmed : nextProjectName(projectsRoot)
  const folder = safeProjectFolderName(displayName) || safeProjectFolderName(nextProjectName(projectsRoot))
  return { dir: join(projectsRoot, folder), displayName }
}

async function ingestZipUpload(file: File, targetDir: string) {
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const sharedRoot = detectSharedZipRoot(listZipEntryNames(zipBytes))
  const decider = createArchiveEntryDecider({ stripRootFolder: sharedRoot !== null })

  let zip: Unzipped
  try {
    zip = unzipSync(zipBytes, {
      filter(entry) {
        return decider.decide(entry.name, entry.originalSize)
      },
    })
  } catch (err) {
    throw new ArchiveIngestError(
      `The uploaded file could not be read as a zip: ${err instanceof Error ? err.message : String(err)}`,
      400,
    )
  }

  if (decider.accepted.size === 0) {
    throw new ArchiveIngestError('No importable files were found in the uploaded archive.', 422)
  }

  return writeArchiveToWorkspace(targetDir, decider.accepted, (name) => zip[name], decider.skipped)
}

async function ingestDirectoryUpload(files: File[], targetDir: string) {
  const decider = createArchiveEntryDecider({ stripRootFolder: false })
  const byName = new Map<string, File>()
  for (const file of files) {
    if (decider.decide(file.name, file.size)) byName.set(file.name, file)
  }

  if (decider.accepted.size === 0) {
    throw new ArchiveIngestError('No importable files were found in the uploaded folder.', 422)
  }

  return writeArchiveToWorkspace(
    targetDir,
    decider.accepted,
    async (name) => {
      const file = byName.get(name)
      // Every accepted name came from `byName` in the loop above, so this is
      // an invariant, not a real runtime possibility — guarded defensively.
      if (!file) throw new ArchiveIngestError(`Missing uploaded file for "${name}".`, 400)
      return new Uint8Array(await file.arrayBuffer())
    },
    decider.skipped,
  )
}

export interface ImportUploadDeps {
  /**
   * Overrides the default `studio-workspace/` root new projects land in —
   * test-only (mirrors `GithubImportOptions.dir` in `studioGithubImport.ts`),
   * never sourced from the wire. Keeps tests from ever writing into this
   * repo's real `studio-workspace/`.
   */
  projectsRoot?: string
}

// `_url` is unused (this route only branches on `pathname`) but kept in the
// signature so this sub-router matches the shape `tryServeStudio` already
// composes (`req, url, pathname`) — see `server/handlers/studio.ts`.
export async function tryServeStudioIngest(
  req: Request,
  _url: URL,
  pathname: string,
  deps: ImportUploadDeps = {},
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/import-upload' || req.method !== 'POST') return null

  try {
    const form = await readFormDataWithLimit(req, MAX_ARCHIVE_BYTES)

    const kindRaw = form.get('kind')
    const rootNameRaw = form.get('rootName')
    const parsedFields = safeParseValue(ImportUploadFieldsSchema, {
      kind: typeof kindRaw === 'string' ? kindRaw : undefined,
      rootName: typeof rootNameRaw === 'string' ? rootNameRaw : undefined,
    })
    if (!parsedFields.ok) return badRequest('invalid import-upload body')

    const files = form.getAll('file').filter((entry): entry is File => entry instanceof File)
    if (files.length === 0) return badRequest('no files were uploaded')

    const projectsRoot = deps.projectsRoot ?? projectsRootDir()
    const { dir, displayName } = deriveUploadTargetDir(parsedFields.value.rootName, projectsRoot)

    let result: Awaited<ReturnType<typeof ingestDirectoryUpload>>
    if (parsedFields.value.kind === 'zip') {
      if (files.length !== 1) return badRequest('a zip upload must contain exactly one file')
      result = await ingestZipUpload(files[0], dir)
    } else {
      result = await ingestDirectoryUpload(files, dir)
    }

    // Safe to write unconditionally: a successful ingest means the target had
    // no pre-existing `.studio/` dir (writeArchiveToWorkspace refuses one),
    // so this always creates a fresh meta.json rather than clobbering a prior
    // one — same reasoning as the GitHub import route.
    writeProjectMeta(dir, { displayName })
    return jsonResponse({ ok: true, ...result })
  } catch (err) {
    console.error('[studio]', err)
    if (err instanceof ArchiveIngestError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
