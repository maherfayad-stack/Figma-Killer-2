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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  PrototypeLinkSchema,
  createPrototypeFile,
  parsePrototypeFile,
  prunePrototypeLinks,
  removePrototypeLink,
  serializePrototypeFile,
  upsertPrototypeLink,
  type PrototypeFile,
} from '@core/studio-prototype'

export function prototypeFilePath(dir: string): string {
  return join(dir, '.studio', 'prototype.json')
}

export function readPrototypeFile(dir: string): PrototypeFile {
  const file = prototypeFilePath(dir)
  return existsSync(file) ? parsePrototypeFile(readFileSync(file, 'utf8')) : createPrototypeFile()
}

export function writePrototypeFile(dir: string, file: PrototypeFile): void {
  const path = prototypeFilePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializePrototypeFile(file))
}

export const PrototypeOpSchema = Type.Union([
  Type.Object({ kind: Type.Literal('upsert'), link: PrototypeLinkSchema }),
  Type.Object({ kind: Type.Literal('remove'), linkId: Type.String() }),
  Type.Object({ kind: Type.Literal('prune'), pageIds: Type.Array(Type.String()) }),
])
export type PrototypeOp = Static<typeof PrototypeOpSchema>

export type PrototypeOpResult =
  | { ok: true; file: PrototypeFile; changed: boolean }
  | { ok: false; status: 400; error: string }

/**
 * Apply one operation. Pure with respect to the filesystem — the caller reads,
 * applies and writes, which is what makes this testable without a temp dir.
 *
 * `changed: false` is a SUCCESS: removing a link that is already gone, or a
 * prune with nothing to prune, writes no bytes rather than rewriting a
 * byte-identical file.
 */
export function applyPrototypeOp(file: PrototypeFile, op: PrototypeOp): PrototypeOpResult {
  switch (op.kind) {
    case 'upsert': {
      // Re-parse the single link so a hand-rolled request cannot store a
      // shape the reader would later have to repair — same posture as the
      // boards route re-parsing its whole payload.
      const parsed = parsePrototypeFile({ version: 1, links: [op.link] })
      const link = parsed.links[0]
      if (!link) return { ok: false, status: 400, error: 'Link is not a usable prototype link' }
      const next = upsertPrototypeLink(file, link)
      return { ok: true, file: next, changed: true }
    }

    case 'remove': {
      const next = removePrototypeLink(file, op.linkId)
      return { ok: true, file: next, changed: next !== file }
    }

    case 'prune': {
      if (op.pageIds.length === 0) {
        return { ok: false, status: 400, error: 'prune requires the list of pages that still exist' }
      }
      const next = prunePrototypeLinks(file, op.pageIds)
      return { ok: true, file: next, changed: next !== file }
    }
  }
}
