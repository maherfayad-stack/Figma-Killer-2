/**
 * droppedFolderWalk — turning a folder dropped on the launcher into the file
 * list `uploadProjectArchive` already knows how to send.
 *
 * A `<input webkitdirectory>` pick hands the browser's own flattened file list
 * straight to the upload client. A DROP does not: `DataTransfer` exposes
 * entries, and a dropped directory arrives as a single `FileSystemDirectoryEntry`
 * that has to be walked one `readEntries()` page at a time. This module owns
 * that walk, and nothing else — the upload itself, the target-directory
 * derivation, and every server-side guard are unchanged.
 *
 * ## Two halves, on purpose
 *
 * `createDropDecider` is a pure, synchronous policy: given a relative path and
 * a size it says accept / skip / over-budget, keeping the running totals. It
 * exists apart from the walk so the rule that decides what a drop is allowed
 * to contain can be unit-tested without a browser, a `DataTransfer`, or a
 * filesystem — the same split `server/handlers/studio/archiveIngest.ts` makes
 * between `createArchiveEntryDecider` and the routes that drive it.
 *
 * ## Why this refuses instead of silently truncating
 *
 * The server's own decider SKIPS entries past a budget and reports a count,
 * which is right for an archive the user cannot inspect first. A drop is
 * different: the user is holding the folder, and a project that quietly
 * imported 5,000 of its 40,000 files would look successful and be broken. So
 * a drop over a cap is refused whole, with a message naming which cap and what
 * to do instead (zip it, or drop the app subdirectory).
 *
 * ## The skip list is the shared one
 *
 * `node_modules`, `.git`, `dist`, `.next`, `.turbo` and `.studio` come from
 * `EXCLUDED_WORKSPACE_DIR_NAMES` — the same set every workspace walk in the
 * product uses. Skipping them here rather than only server-side is what makes
 * dropping a real, installed repo feasible at all: `node_modules` is usually
 * 90%+ of the files, and the browser would otherwise read every one of them
 * into memory before the upload could start.
 */
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'

/**
 * Files one drop may carry. Well above a real React app (a large one is a few
 * thousand source files once dependencies and build output are excluded) and
 * far below the point where reading them all into memory stalls the tab.
 */
export const MAX_DROP_FILES = 8_000

/** Total uncompressed bytes one drop may carry — the browser holds all of it in memory before the upload starts. */
export const MAX_DROP_TOTAL_BYTES = 200 * 1024 * 1024 // 200 MB

/** Per-file cap. Matches the server's `WORKSPACE_MAX_FILE_BYTES`, so a file accepted here is not silently dropped later. */
export const MAX_DROP_FILE_BYTES = 5 * 1024 * 1024

/**
 * What the decider concluded about one candidate.
 *
 *   - `accept`      — send it.
 *   - `skip`        — excluded directory or an oversized single file; the
 *                     drop continues and the count is reported.
 *   - `over-budget` — a cap the whole drop shares was exceeded. The walk stops
 *                     and the drop is refused; `reason` is the user-facing
 *                     sentence.
 */
export type DropDecision =
  | { kind: 'accept' }
  | { kind: 'skip' }
  | { kind: 'over-budget'; reason: string }

export interface DropDecider {
  /** `relPath` is POSIX, relative to the dropped folder's own root (which the caller strips, exactly as the folder picker's client does). */
  decide(relPath: string, size: number): DropDecision
  /** Files accepted so far. */
  readonly acceptedCount: number
  /** Entries skipped by the per-file size cap. Excluded directories are not counted — nobody expects `node_modules` to be imported. */
  readonly skippedCount: number
}

/** True when any segment of a POSIX relative path names a directory every workspace walk excludes. */
export function isExcludedDropPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))
}

/** Bytes as a short human string — used in the refusal messages, which have to name a number the user recognises. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * The one policy every dropped file passes through. Stateful across a whole
 * drop (the walk sees one entry at a time and the totals are shared), pure
 * otherwise — no DOM, no network, no filesystem.
 */
export function createDropDecider(): DropDecider {
  let acceptedCount = 0
  let skippedCount = 0
  let totalBytes = 0

  return {
    decide(relPath, size) {
      if (isExcludedDropPath(relPath)) return { kind: 'skip' }

      if (size > MAX_DROP_FILE_BYTES) {
        // One huge asset should not cost the user the whole import — the
        // project still opens without it, and the summary says how many were
        // left behind.
        skippedCount += 1
        return { kind: 'skip' }
      }

      if (acceptedCount + 1 > MAX_DROP_FILES) {
        return {
          kind: 'over-budget',
          reason: `That folder has more than ${MAX_DROP_FILES.toLocaleString()} files. Drop the app's own directory instead, or zip it and use Import project.`,
        }
      }

      if (totalBytes + size > MAX_DROP_TOTAL_BYTES) {
        return {
          kind: 'over-budget',
          reason: `That folder is larger than ${formatBytes(MAX_DROP_TOTAL_BYTES)}. Drop the app's own directory instead, or zip it and use Import project.`,
        }
      }

      acceptedCount += 1
      totalBytes += size
      return { kind: 'accept' }
    },
    get acceptedCount() {
      return acceptedCount
    },
    get skippedCount() {
      return skippedCount
    },
  }
}

/** Thrown when a drop exceeds a whole-drop cap. Typed so the launcher can toast the reason instead of a generic failure. */
export class DropTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DropTooLargeError'
  }
}

/**
 * The subset of `FileSystemEntry` this walk uses. Declared here rather than
 * relying on the DOM lib's own `FileSystemEntry`/`FileSystemDirectoryReader`
 * types because those are only partially specified across TS DOM versions and
 * the reader's paging contract (an empty batch means "done") is the part that
 * actually matters — see `readAllEntries`.
 */
interface DroppedEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?(onSuccess: (file: File) => void, onError: (err: unknown) => void): void
  createReader?(): { readEntries(onSuccess: (entries: DroppedEntry[]) => void, onError: (err: unknown) => void): void }
}

/** One dropped folder, walked flat: the files to send plus what the policy left out. */
export interface DroppedFolder {
  /** The dropped folder's own name — becomes the project's display name, exactly as the folder picker's `rootName` does. */
  rootName: string
  /** Accepted files, each renamed to its path RELATIVE TO the dropped folder (the shape `uploadProjectArchive`'s `directory` kind expects). */
  files: File[]
  /** Files skipped by the per-file size cap. */
  skipped: number
}

/**
 * `readEntries` returns AT MOST 100 entries per call and signals exhaustion
 * with an empty batch — a directory read that stops at the first batch is the
 * classic drag-and-drop bug, and it silently imports the first 100 children of
 * every folder.
 */
function readAllEntries(entry: DroppedEntry): Promise<DroppedEntry[]> {
  const reader = entry.createReader?.()
  if (!reader) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const all: DroppedEntry[] = []
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        readBatch()
      }, reject)
    }
    readBatch()
  })
}

function readFile(entry: DroppedEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      reject(new Error(`Could not read "${entry.name}".`))
      return
    }
    entry.file(resolve, reject)
  })
}

/**
 * Walks one dropped directory entry into a flat list of files named by their
 * path relative to that directory.
 *
 * Renaming each `File` is what lets the existing upload client take this
 * unchanged: `uploadProjectArchive({ kind: 'directory' })` sends each file
 * under the name it is appended with, and the server writes it at exactly that
 * relative path (having already refused any name that is not a safe relative
 * path). So a drop and a folder pick produce byte-identical requests.
 *
 * Throws `DropTooLargeError` the moment a whole-drop cap is exceeded — the
 * walk stops there rather than reading the rest of the tree it is going to
 * refuse anyway.
 */
export async function walkDroppedDirectory(entry: DroppedEntry): Promise<DroppedFolder> {
  const decider = createDropDecider()
  const files: File[] = []

  const visit = async (current: DroppedEntry, prefix: string): Promise<void> => {
    for (const child of await readAllEntries(current)) {
      const relPath = prefix ? `${prefix}/${child.name}` : child.name
      if (child.isDirectory) {
        // Prune whole excluded directories before descending — the reason a
        // real installed repo is droppable at all.
        if (isExcludedDropPath(relPath)) continue
        await visit(child, relPath)
        continue
      }
      if (!child.isFile) continue

      const file = await readFile(child)
      const decision = decider.decide(relPath, file.size)
      if (decision.kind === 'over-budget') throw new DropTooLargeError(decision.reason)
      if (decision.kind === 'skip') continue
      files.push(new File([file], relPath, { type: file.type, lastModified: file.lastModified }))
    }
  }

  await visit(entry, '')
  return { rootName: entry.name, files, skipped: decider.skippedCount }
}

/**
 * What a drop actually was: one folder, one `.zip`, or nothing importable.
 *
 * Exactly one project per drop. Dropping several folders at once has no honest
 * answer — importing them as N projects is a surprising amount of work to
 * trigger by accident, and merging them into one would invent a directory
 * structure the user never had — so the launcher takes the first and says so.
 */
export type DroppedImport =
  | { kind: 'directory'; entry: DroppedEntry }
  | { kind: 'zip'; file: File }
  | { kind: 'none' }

/**
 * Classifies a drop's `DataTransfer`. Uses `webkitGetAsEntry()`, which is the
 * only way to tell a dropped FOLDER from a file: `DataTransfer.files` reports
 * a dropped directory as a zero-byte `File` with no type, indistinguishable
 * from a real empty file.
 */
export function classifyDrop(dataTransfer: DataTransfer): DroppedImport {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry() as DroppedEntry | null
    if (entry?.isDirectory) return { kind: 'directory', entry }
    const file = item.getAsFile()
    if (file && /\.zip$/i.test(file.name)) return { kind: 'zip', file }
  }
  return { kind: 'none' }
}

/** True when a drag is carrying files at all — the drop overlay must not appear for a text selection or an in-app drag. */
export function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes('Files')
}
