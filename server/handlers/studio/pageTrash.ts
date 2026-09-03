/**
 * pageTrash — the recoverable half of removing a page: move its files into
 * `.studio/trash/`, and put them back on request.
 *
 * ## Why a real directory
 *
 * In Studio the repository IS the document, so "trash" is not a flag on a
 * record — it is a place the files actually go. `.studio/` is already the
 * editor's own sidecar and is in `EXCLUDED_WORKSPACE_DIR_NAMES`, so a page
 * moved under it becomes invisible to EVERY reader at once: `discoverPageFiles`
 * stops finding it, the style compiler stops compiling it, and
 * `stillReferenced` stops counting the trashed copy as a reason to keep a
 * stylesheet alive. Nothing had to learn about trash for it to disappear
 * correctly, which is the whole argument for doing it this way rather than
 * with an ignore-list the next reader would forget to consult.
 *
 * ## Why a manifest
 *
 * The files are stored under `.studio/trash/<entryId>/<original relative
 * path>`, and `manifest.json` records where each entry came from. Restoring
 * has to put a file back exactly where it was — `pages/marketing/Landing.tsx`,
 * not `pages/Landing.tsx` — and a nested path cannot be recovered from a flat
 * copy. The manifest also carries the title and timestamp the Trash list
 * shows, so listing the trash never has to parse the trashed files.
 *
 * A missing or corrupt manifest degrades to an empty trash
 * (`parseJsonWithFallback`) rather than throwing: an unreadable sidecar must
 * never be able to stop a project from opening.
 *
 * ## What moves
 *
 * Exactly what `pageDelete.ts` would have removed — the same `pageFiles.ts`
 * helpers answer both. That is deliberate: a trash that moved a different set
 * than the delete removes would let you restore a page and find half of it
 * missing, with nothing to say why.
 *
 * Board frames are REMOVED on trash and re-placed on restore
 * (`autoPlaceBoardFrame`), not preserved: a frame pointing at a file under
 * `.studio/` renders as a permanently broken screen, and a restored page the
 * user cannot see is the same "a screen you cannot see is not a screen"
 * problem scaffolding already solved.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { autoPlaceBoardFrame, removeBoardFramesForPage } from './boardFrames'
import {
  importedStylesheets,
  pageRootDir,
  pruneEmptyDirs,
  resolvePageSourceFile,
  stillReferenced,
} from './pageFiles'

/** One trashed page: where its files are parked, and where each came from. */
const TrashEntrySchema = Type.Object({
  /** Directory name under `.studio/trash/` holding this entry's files. */
  id: Type.String(),
  /** The page id it had while it was live — restored pages get it back, since it derives from the same path. */
  pageId: Type.String(),
  /** Display title for the Trash list. */
  title: Type.String(),
  /** Project-relative paths this entry owns, in the order they were moved. The first is the page file itself. */
  files: Type.Array(Type.String()),
  /** ISO timestamp, for "when did I delete this". */
  deletedAt: Type.String(),
})
export type TrashEntry = Static<typeof TrashEntrySchema>

const TrashManifestSchema = Type.Object({
  version: Type.Literal(1),
  entries: Type.Array(TrashEntrySchema),
})
type TrashManifest = Static<typeof TrashManifestSchema>

const EMPTY_MANIFEST: TrashManifest = { version: 1, entries: [] }

function trashDir(dir: string): string {
  return join(dir, '.studio', 'trash')
}

function manifestPath(dir: string): string {
  return join(trashDir(dir), 'manifest.json')
}

function readManifest(dir: string): TrashManifest {
  const file = manifestPath(dir)
  if (!existsSync(file)) return EMPTY_MANIFEST
  try {
    return parseJsonWithFallback(readFileSync(file, 'utf8'), TrashManifestSchema, EMPTY_MANIFEST)
  } catch (_err) {
    // An unreadable sidecar is an empty trash, never a failure to open the
    // project — same posture `parseBoardsFile` takes on a corrupt boards.json.
    return EMPTY_MANIFEST
  }
}

function writeManifest(dir: string, manifest: TrashManifest): void {
  mkdirSync(trashDir(dir), { recursive: true })
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Move one file, creating the destination's parent. `rmSync` after `cpSync` so this works across devices. */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  rmSync(from)
}

/** Every page currently in the trash, newest first — what the explorer's Trash section lists. */
export function listTrashedPages(dir: string): TrashEntry[] {
  return [...readManifest(dir).entries].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

export type TrashPageResult =
  | { ok: true; entry: TrashEntry; removedFrames: number }
  | { ok: false; notFound: string }

/**
 * Move `pageId`'s files into the trash. The page vanishes from the board and
 * from every page list on the next reload, because nothing outside this module
 * looks inside `.studio/`.
 */
export function trashStudioPage(dir: string, pageId: string, title: string): TrashPageResult {
  const file = resolvePageSourceFile(dir, pageId)
  if (!file || !existsSync(file)) {
    return { ok: false, notFound: `No page with id "${pageId}" exists in this project.` }
  }

  // Read the imports BEFORE moving the page — afterwards there is nothing left
  // at that path to read them from.
  const stylesheets = importedStylesheets(dir, file)
  const id = crypto.randomUUID()
  const entryDir = join(trashDir(dir), id)

  const files = [relative(dir, file)]
  moveFile(file, join(entryDir, relative(dir, file)))

  for (const stylesheet of stylesheets) {
    // Asked AFTER the page file moved, so the page's own import no longer
    // counts as a reason to keep its stylesheet in place.
    if (stillReferenced(dir, stylesheet)) continue
    const rel = relative(dir, stylesheet)
    moveFile(stylesheet, join(entryDir, rel))
    files.push(rel)
  }

  pruneEmptyDirs(file, pageRootDir(dir))

  const entry: TrashEntry = { id, pageId, title, files, deletedAt: new Date().toISOString() }
  const manifest = readManifest(dir)
  writeManifest(dir, { version: 1, entries: [...manifest.entries, entry] })

  return { ok: true, entry, removedFrames: removeBoardFramesForPage(dir, pageId) }
}

export type RestoreTrashedPageResult =
  | { ok: true; entry: TrashEntry }
  | { ok: false; notFound: string }
  | { ok: false; conflict: string }

/**
 * Put a trashed entry's files back where they came from and re-place its board
 * frame.
 *
 * Refuses rather than overwriting when ANY of its paths is occupied again — a
 * new page scaffolded at the same name while this one sat in the trash is a
 * real file with real work in it, and silently clobbering it to satisfy an
 * undo would be the worst possible trade. Nothing is moved in that case: the
 * check runs over the whole file list before the first write, so a refused
 * restore leaves the trash exactly as it was.
 */
export function restoreTrashedPage(dir: string, entryId: string): RestoreTrashedPageResult {
  const manifest = readManifest(dir)
  const entry = manifest.entries.find((candidate) => candidate.id === entryId)
  if (!entry) return { ok: false, notFound: `Nothing in the trash with id "${entryId}".` }

  const occupied = entry.files.filter((rel) => existsSync(join(dir, rel)))
  if (occupied.length > 0) {
    return {
      ok: false,
      conflict:
        `"${entry.title}" cannot be restored — ${occupied.join(', ')} ${occupied.length === 1 ? 'exists' : 'exist'} ` +
        'in the project again. Rename or remove it first, then restore.',
    }
  }

  const entryDir = join(trashDir(dir), entry.id)
  for (const rel of entry.files) {
    const parked = join(entryDir, rel)
    if (!existsSync(parked)) continue // already gone from the trash on disk — restore what is there
    moveFile(parked, join(dir, rel))
  }
  rmSync(entryDir, { recursive: true, force: true })
  writeManifest(dir, { version: 1, entries: manifest.entries.filter((c) => c.id !== entry.id) })

  // A restored page the user cannot see is not restored — same reasoning
  // `createScaffoldedPage` applies to a new one.
  autoPlaceBoardFrame(dir, entry.pageId)
  return { ok: true, entry }
}

/**
 * Permanently remove one trashed entry, or — with no `entryId` — empty the
 * trash. Returns how many entries went, so the caller can report it.
 */
export function purgeTrash(dir: string, entryId?: string): number {
  const manifest = readManifest(dir)
  const going = entryId ? manifest.entries.filter((c) => c.id === entryId) : manifest.entries
  if (going.length === 0) return 0
  for (const entry of going) {
    rmSync(join(trashDir(dir), entry.id), { recursive: true, force: true })
  }
  const goingIds = new Set(going.map((entry) => entry.id))
  writeManifest(dir, { version: 1, entries: manifest.entries.filter((c) => !goingIds.has(c.id)) })
  return going.length
}
