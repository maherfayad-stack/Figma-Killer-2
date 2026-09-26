/**
 * assetLedger — the record of every image file STUDIO wrote into a project,
 * and the question "which of those does nothing reference any more?"
 * (P5-B3, IMG-11; audit 07 §A.9).
 *
 * ## Why a ledger exists at all
 *
 * Undo of an image drop deletes the `<img>` and leaves `public/hero.png` on
 * disk, on purpose: redo needs it, a deduped file may be referenced from
 * elsewhere, and deleting a user's file as a side effect of ⌘Z is the wrong
 * risk. So orphans accumulate — and nothing may ever delete them on its own.
 * The ledger is what makes an EXPLICIT clean-up safe: it can only ever offer a
 * file Studio itself created, never one the user (or their repository) put
 * there.
 *
 * ## What it holds
 *
 * `.studio/assets.json` — Studio's own state, on disk beside `boards.json`,
 * never in the database: `{ relPath, sha256, landedAt }` per file, appended by
 * `landAssetBytes` whenever it CREATES a file (a dedupe onto an existing file
 * records nothing: that file may be the user's). The hash is what the prune
 * checks before deleting, so a file the user has since overwritten with their
 * own content is theirs again and is kept.
 *
 * ## "Unused"
 *
 * A ledger file whose BASE NAME appears in no text file of the project — the
 * workspace walk (`listWorkspaceFiles`: never a symlink, never
 * `node_modules`/`.git`/build output) plus Studio's own loose canvas layers
 * (`.studio/canvas/*.tsx`, which reference `public/` images and live outside
 * that walk). A static text scan: nothing is parsed, nothing runs. It errs
 * one way only — a name that merely appears in a comment counts as used — and
 * when the scan cannot finish inside its budget it says so, and the prune
 * refuses rather than deleting on a partial answer.
 *
 * Every read here is of the ledger's OWN path spelled exactly (a `.studio`
 * that is a link is refused); every path the ledger names is re-validated by
 * the prune before anything is touched (`assetPrune.ts`).
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkspaceFiles, realWorkspaceRel, resolveWorkspaceReadPath } from '@core/page-parser'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { writeFileAtomic } from './atomicFileWrite'
import { canvasLayerFilePath, listCanvasLayerIds } from './canvasLayerFiles'

/** Workspace-relative path of the ledger. */
export const ASSET_LEDGER_REL = '.studio/assets.json'

/** Beyond this many entries the oldest are forgotten — which only ever makes a file un-prunable, never deleted. */
export const MAX_ASSET_LEDGER_ENTRIES = 5000

const AssetLedgerEntrySchema = Type.Object({
  relPath: Type.String(),
  sha256: Type.String(),
  landedAt: Type.String(),
})
export type AssetLedgerEntry = Static<typeof AssetLedgerEntrySchema>

const AssetLedgerSchema = Type.Object({
  version: Type.Literal(1),
  entries: Type.Array(AssetLedgerEntrySchema),
})
type AssetLedger = Static<typeof AssetLedgerSchema>

const EMPTY_LEDGER: AssetLedger = { version: 1, entries: [] }

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The ledger's absolute path, or `null` when writing or reading it would go
 * anywhere other than exactly `<dir>/.studio/assets.json` (a `.studio` that
 * is a link, a case variant, an escape).
 */
function ledgerPath(dir: string): string | null {
  const file = join(dir, ...ASSET_LEDGER_REL.split('/'))
  return realWorkspaceRel(dir, file) === ASSET_LEDGER_REL ? file : null
}

export function readAssetLedger(dir: string): AssetLedgerEntry[] {
  const file = ledgerPath(dir)
  if (!file || !existsSync(file)) return []
  try {
    if (!lstatSync(file).isFile()) return []
    return parseJsonWithFallback(readFileSync(file, 'utf8'), AssetLedgerSchema, EMPTY_LEDGER).entries
  } catch (err) {
    console.error('[studio:asset-ledger] could not read the ledger', err)
    return []
  }
}

export function writeAssetLedger(dir: string, entries: readonly AssetLedgerEntry[]): void {
  const file = ledgerPath(dir)
  if (!file) throw new Error('The asset ledger path is not writable.')
  mkdirSync(join(dir, '.studio'), { recursive: true })
  const ledger: AssetLedger = { version: 1, entries: entries.slice(-MAX_ASSET_LEDGER_ENTRIES) }
  writeFileAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`)
}

/**
 * Record a file Studio just CREATED. Never throws: a ledger that cannot be
 * written costs the user the ability to prune this one file, and must never
 * cost them the landing itself.
 */
export function recordLandedAsset(dir: string, relPath: string, bytes: Uint8Array, now: Date = new Date()): void {
  try {
    const entries = readAssetLedger(dir).filter((entry) => entry.relPath !== relPath)
    entries.push({ relPath, sha256: sha256Hex(bytes), landedAt: now.toISOString() })
    writeAssetLedger(dir, entries)
  } catch (err) {
    console.error('[studio:asset-ledger] could not record a landed asset', err)
  }
}

/** Extensions whose bytes are never text that could name an image — skipped by the reference scan. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a',
  'zip', 'gz', 'tgz', 'br', 'pdf', 'wasm', 'exe', 'dll', 'so', 'dylib', 'bin', 'lockb',
])

/** A single text file larger than this is still scanned — but counts against the budget below. */
export const MAX_REFERENCE_SCAN_BYTES = 128 * 1024 * 1024

export interface UnusedAssetsReport {
  /** Ledger files that exist, are unchanged since Studio wrote them, and whose name no text file contains. */
  unused: { relPath: string; bytes: number }[]
  /** True when the scan ran out of budget; nothing may be pruned on a partial answer. */
  incomplete: boolean
}

/** What a ledger entry may name: an image, by the landing pipeline's own extensions. */
const LEDGER_IMAGE_PATH = /\.(?:png|jpg|gif|webp|avif|svg)$/i

/**
 * Whether the file at `relPath` still holds exactly what Studio wrote there —
 * an image path, a regular file (never a link), inside the project on its
 * real path and outside every excluded directory, whose bytes still hash to
 * what was recorded. `null` when it does not; its size when it does.
 *
 * Every condition is re-checked because the ledger is a FILE in the project:
 * a repository can arrive carrying a hand-written `.studio/assets.json` that
 * names `src/App.tsx` with that file's own hash. The image-extension rule is
 * what keeps such an entry from ever being offered for deletion.
 */
export function unchangedLedgerFile(dir: string, entry: AssetLedgerEntry): number | null {
  if (!LEDGER_IMAGE_PATH.test(entry.relPath)) return null
  const resolved = resolveWorkspaceReadPath(dir, entry.relPath)
  if (!resolved || resolved.rel !== entry.relPath) return null
  try {
    const stat = lstatSync(resolved.abs)
    if (!stat.isFile()) return null
    return sha256Hex(readFileSync(resolved.abs)) === entry.sha256 ? stat.size : null
  } catch {
    return null
  }
}

/** Every text file's contents the reference scan reads, or `null` when they exceed the budget. */
function readReferenceTexts(dir: string): string[] | null {
  const texts: string[] = []
  let budget = MAX_REFERENCE_SCAN_BYTES
  const read = (abs: string): boolean => {
    try {
      const stat = lstatSync(abs)
      if (!stat.isFile()) return true
      budget -= stat.size
      if (budget < 0) return false
      texts.push(readFileSync(abs, 'utf8'))
    } catch {
      // Unreadable between the walk and the read: nothing it could say.
    }
    return true
  }
  for (const rel of listWorkspaceFiles(dir)) {
    const dot = rel.lastIndexOf('.')
    if (dot !== -1 && BINARY_EXTENSIONS.has(rel.slice(dot + 1).toLowerCase())) continue
    if (!read(join(dir, ...rel.split('/')))) return null
  }
  for (const id of listCanvasLayerIds(dir)) {
    const file = canvasLayerFilePath(dir, id)
    if (file && !read(file)) return null
  }
  return texts
}

/** The ledger's files nothing references any more. See the module doc for "unused". */
export function findUnusedLedgerAssets(dir: string): UnusedAssetsReport {
  const candidates: { relPath: string; bytes: number }[] = []
  for (const entry of readAssetLedger(dir)) {
    const bytes = unchangedLedgerFile(dir, entry)
    if (bytes !== null) candidates.push({ relPath: entry.relPath, bytes })
  }
  if (candidates.length === 0) return { unused: [], incomplete: false }

  const texts = readReferenceTexts(dir)
  if (texts === null) return { unused: [], incomplete: true }
  const unused = candidates.filter(({ relPath }) => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1)
    return !texts.some((text) => text.includes(name))
  })
  return { unused, incomplete: false }
}
