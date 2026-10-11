/**
 * prototypeStore — the server side of `<dir>/.studio/prototype.json`.
 *
 * WHY OPERATIONS, NOT WHOLE-FILE WRITES
 * ─────────────────────────────────────
 * `/admin/api/studio/boards` POSTs the entire `BoardsFile` and lets the last
 * writer win. That is fine there: board geometry has exactly one writer, the
 * person dragging.
 *
 * Prototype links look single-writer too, and today they are. They will not
 * stay that way: Phase 6 has Studio deriving links from the user's real
 * navigation code, and an agent authoring a flow is an obvious next tool. Under
 * whole-file semantics, the browser holding a stale `PrototypeFile` in its
 * store silently erases anything written between its last read and its next
 * save. Op-shaped writes are barely more code than the boards route and remove
 * the entire class, so this follows `commentsStore` rather than the boards
 * route it otherwise resembles.
 *
 * (Read-modify-write within one process, not a transaction — same caveat
 * `commentsStore` documents. Bun serves these on one thread and an op is a few
 * microseconds of array work, so the window is not reachable in practice.)
 *
 * WHY `prune` CARRIES ITS OWN PAGE LIST
 * ─────────────────────────────────────
 * Deleting a page is the one edit that orphans a link without touching the
 * link's own source. The server cannot enumerate pages without parsing the
 * user's project, which is exactly the work this route exists to avoid, so the
 * caller — which just deleted the page and already holds the page tree — states
 * which pages still exist. A `prune` naming NO pages is refused rather than
 * obeyed: it is indistinguishable from a caller that failed to load its pages,
 * and obeying it would wipe every flow in the project.
 *
 * WHY AN OP TOUCHES ONLY THE LINKS IT NAMES
 * ─────────────────────────────────────────
 * The file is hand-editable and lives in the user's git repo, so a write for one
 * link must not rewrite the others. `parsePrototypeFile` REPAIRS on read (a
 * legacy `"trigger": "click"` becomes `{ kind: "click" }`, a field it does not
 * know is dropped), so serializing the parsed file back out re-formatted every
 * link in the file - a 46-line diff for one new connector, and an undo that
 * could not restore the bytes it had changed. Ops therefore run on the file's
 * RAW links: the named link is added, replaced or removed, every other entry
 * (including one the reader would repair or drop) is written back exactly as it
 * was read. Removing the link an upsert appended restores the file byte for
 * byte.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  PrototypeLinkSchema,
  parsePrototypeFile,
  prunePrototypeLinks,
  type PrototypeFile,
  type PrototypeLink,
} from '@core/studio-prototype'
import { readStudioStoreText, studioStorePath, writeStudioStoreFile } from './studioStore'

const PROTOTYPE_FILE = 'prototype.json'

/** Absolute path of `.studio/prototype.json` - for a caller that must NAME it (the shell's input stamp); reading and writing go through `studioStore.ts`. */
export function prototypeFilePath(dir: string): string {
  return studioStorePath(dir, PROTOTYPE_FILE)
}

/** The file as the editor reads it: links repaired and validated. */
export function readPrototypeFile(dir: string): PrototypeFile {
  return parsePrototypeFile(readStudioStoreText(dir, PROTOTYPE_FILE) ?? '')
}

/** The file's bytes, or `null` when there is none (or it is reached through a link). */
export function readPrototypeText(dir: string): string | null {
  return readStudioStoreText(dir, PROTOTYPE_FILE)
}

export function writePrototypeText(dir: string, text: string): void {
  writeStudioStoreFile(dir, PROTOTYPE_FILE, text)
}

export const PrototypeOpSchema = Type.Union([
  Type.Object({ kind: Type.Literal('upsert'), link: PrototypeLinkSchema }),
  Type.Object({ kind: Type.Literal('remove'), linkId: Type.String() }),
  Type.Object({ kind: Type.Literal('prune'), pageIds: Type.Array(Type.String()) }),
])
export type PrototypeOp = Static<typeof PrototypeOpSchema>

export type PrototypeOpResult =
  | { ok: true; file: PrototypeFile; text: string; changed: boolean }
  | { ok: false; status: 400; error: string }

type RawObject = Record<string, unknown>

function isRawObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored document and its raw `links`; an absent, unparseable or link-less file is an empty document. */
function readRawDocument(stored: string | null): { document: RawObject; links: unknown[] } {
  if (stored !== null) {
    try {
      const parsed: unknown = JSON.parse(stored)
      if (isRawObject(parsed) && Array.isArray(parsed.links)) return { document: parsed, links: parsed.links }
    } catch {
      // An unreadable file is treated as empty, exactly as the reader does; the write replaces it.
    }
  }
  return { document: { version: 1 }, links: [] }
}

const rawId = (entry: unknown): string | undefined => (isRawObject(entry) && typeof entry.id === 'string' ? entry.id : undefined)

/**
 * The link as it goes into the file. An existing entry keeps the `origin` it
 * carried (a field the editor does not model but a person or an older build
 * wrote), placed right after `id` where it was.
 */
function storedLink(link: PrototypeLink, existing: unknown): RawObject {
  const { id, ...rest } = link
  const origin = isRawObject(existing) ? existing.origin : undefined
  return origin === undefined ? { id, ...rest } : { id, origin, ...rest }
}

/**
 * Apply one operation to the stored text. Pure with respect to the filesystem -
 * the caller reads, applies and writes, which is what makes this testable
 * without a temp dir.
 *
 * `changed: false` is a SUCCESS: removing a link that is already gone, or a
 * prune with nothing to prune, writes no bytes rather than rewriting a
 * byte-identical file.
 */
export function applyPrototypeOp(stored: string | null, op: PrototypeOp): PrototypeOpResult {
  const { document, links } = readRawDocument(stored)
  const finish = (next: unknown[]): PrototypeOpResult => {
    const changed = JSON.stringify(next) !== JSON.stringify(links)
    const text = changed || stored === null ? `${JSON.stringify({ ...document, links: next }, null, 2)}
` : stored
    return { ok: true, file: parsePrototypeFile(text), text, changed }
  }

  switch (op.kind) {
    case 'upsert': {
      // Re-parse the single link so a hand-rolled request cannot store a
      // shape the reader would later have to repair - same posture as the
      // boards route re-parsing its whole payload.
      const link = parsePrototypeFile({ version: 1, links: [op.link] }).links[0]
      if (!link) return { ok: false, status: 400, error: 'Link is not a usable prototype link' }
      const index = links.findIndex((entry) => rawId(entry) === link.id)
      if (index === -1) return finish([...links, storedLink(link, undefined)])
      return finish(links.map((entry, i) => (i === index ? storedLink(link, entry) : entry)))
    }

    case 'remove':
      return finish(links.filter((entry) => rawId(entry) !== op.linkId))

    case 'prune': {
      if (op.pageIds.length === 0) {
        return { ok: false, status: 400, error: 'prune requires the list of pages that still exist' }
      }
      const readable = parsePrototypeFile({ version: 1, links })
      const surviving = new Set(prunePrototypeLinks(readable, op.pageIds).links.map((link) => link.id))
      const readableIds = new Set(readable.links.map((link) => link.id))
      // An entry the reader cannot make sense of is not this op's to delete.
      return finish(links.filter((entry) => !readableIds.has(rawId(entry) ?? '') || surviving.has(rawId(entry) ?? '')))
    }
  }
}
