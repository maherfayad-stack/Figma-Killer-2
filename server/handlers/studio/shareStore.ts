/**
 * shareStore — `<dir>/.studio/shares.json` and the snapshot directories it
 * indexes.
 *
 * A share is four facts: an unguessable token, which board it photographed,
 * when it was created, and whether it has been revoked. They live on disk
 * beside the project, not in the database, for the reason CLAUDE.md states
 * plainly — Studio state belongs on disk. A project you copy, zip, or `git
 * clone` carries its shares with it, and deleting the project deletes them.
 *
 * ## Why the registry is consulted on every request
 *
 * The snapshot itself is a directory of PNGs; serving it as static hosting
 * would be faster and would also make revocation a lie. So nothing is ever
 * served from a snapshot directory without first reading `shares.json` and
 * confirming the record is present and un-revoked. Revocation is therefore
 * immediate by construction: it is a file write, and the very next request
 * reads it.
 *
 * ## Why revoked records are kept
 *
 * Deleting the record would make a revoked link indistinguishable from a
 * token that never existed — for the VIEWER that is correct and deliberate
 * (both get the same bare 404), but for the OWNER it means the dialog quietly
 * forgets a link somebody may still be holding. So the record stays with a
 * `revokedAt` stamp and the snapshot files are deleted; the dialog can say
 * "revoked 3 days ago" and the bytes are gone either way.
 *
 * ## Finding a project from a token
 *
 * The public route has only a token — it does not know, and must not be told,
 * which project it belongs to. So a lookup scans the projects on disk for the
 * token. The token→directory mapping is memoised because it can never change
 * for a given token (a share is minted into exactly one project and never
 * moves); the RECORD is re-read on every request, so the memo can never keep
 * a revoked share alive.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { isShareTokenShape, type ShareSummary } from '@core/studio-share'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { projectsRootDir } from '../studioProjects'
import { isRealpathContainedAllowingMissing } from './workspacePackageResolve'

/**
 * The persisted record. A superset of the wire `ShareSummary` only in that it
 * is the same shape — kept as its own schema because this one is validated
 * against a FILE (hand-editable, possibly written by an older build), where
 * the wire type is validated against a response this process just produced.
 */
const ShareRecordSchema = Type.Object({
  token: Type.String(),
  boardId: Type.String(),
  boardName: Type.String(),
  createdAt: Type.String(),
  snapshotAt: Type.String(),
  revokedAt: Type.Optional(Type.String()),
  frameCount: Type.Number(),
})

export type ShareRecord = Static<typeof ShareRecordSchema>

const SharesFileSchema = Type.Object({
  version: Type.Literal(1),
  shares: Type.Array(ShareRecordSchema),
})

export type SharesFile = Static<typeof SharesFileSchema>

function emptySharesFile(): SharesFile {
  return { version: 1, shares: [] }
}

export function sharesFilePath(dir: string): string {
  return join(dir, '.studio', 'shares.json')
}

/** The parent of every snapshot directory for a project. */
export function sharesRootDir(dir: string): string {
  return join(dir, '.studio', 'shares')
}

/**
 * Where one share's snapshot lives. Refuses a token that is not exactly the
 * minted shape — the token is a path segment here, so this is the gate that
 * makes traversal unreachable rather than merely detected. Callers that then
 * touch the filesystem ALSO containment-check the resolved real path
 * (`resolveShareFile` below), because a symlink planted inside `.studio/`
 * would survive a purely lexical check.
 */
export function shareSnapshotDir(dir: string, token: string): string | null {
  if (!isShareTokenShape(token)) return null
  return join(sharesRootDir(dir), token)
}

/**
 * A file inside one share's snapshot, or `null` when the token, the file
 * name, or the resolved real path is not acceptable. `fileName` must already
 * have been shape-checked by the caller (`isShareImageFileName`, or the
 * literal `board.json`); this function's job is the containment half.
 */
export function resolveShareFile(dir: string, token: string, fileName: string): string | null {
  const snapshotDir = shareSnapshotDir(dir, token)
  if (!snapshotDir) return null
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return null
  const target = join(snapshotDir, fileName)
  // Belt and braces: the lexical checks above already make `..` impossible,
  // but a symlink inside the snapshot directory would not be lexical.
  if (!isRealpathContainedAllowingMissing(target, snapshotDir)) return null
  if (target !== snapshotDir && !target.startsWith(snapshotDir + sep)) return null
  return target
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read a project's shares. A missing, unparseable, or malformed file yields
 * an EMPTY registry rather than throwing: `shares.json` is a sidecar, and a
 * corrupted one must not take the board down with it. The consequence is that
 * every share in a corrupted file stops resolving, which is the safe
 * direction to fail in.
 */
export function readSharesFile(dir: string): SharesFile {
  const file = sharesFilePath(dir)
  if (!existsSync(file)) return emptySharesFile()
  return parseJsonWithFallback(readFileSync(file, 'utf8'), SharesFileSchema, emptySharesFile())
}

export function writeSharesFile(dir: string, file: SharesFile): void {
  const path = sharesFilePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * 32 bytes (256 bits) from the CSPRNG, base64url-encoded — 43 characters
 * after the `shr_` prefix. The token IS the credential: there is no second
 * factor, no session, and no rate limit in front of a share link, so the only
 * thing standing between a stranger and someone's board is that the space is
 * not searchable. 256 bits is not a round number chosen for looks; it is the
 * same width `captureToken.ts` mints for a five-minute grant, and a share
 * lives until it is revoked.
 */
export function mintShareToken(): string {
  return `shr_${randomBytes(32).toString('base64url')}`
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, which
 * would itself be a length oracle. Comparing SHA-256 digests sidesteps that:
 * both sides are always 32 bytes, so the comparison is constant-time over
 * inputs of any length and leaks nothing about how much of the token matched.
 */
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

/** The record for `token` in this project, matched in constant time, or `null`. */
export function findShareRecord(dir: string, token: string): ShareRecord | null {
  if (!isShareTokenShape(token)) return null
  let found: ShareRecord | null = null
  for (const record of readSharesFile(dir).shares) {
    // No early exit: scanning the whole list keeps the work independent of
    // WHERE a matching token sits, which is the other half of not leaking
    // timing information.
    if (tokensMatch(record.token, token)) found = record
  }
  return found
}

// ---------------------------------------------------------------------------
// Cross-project lookup
// ---------------------------------------------------------------------------

/**
 * Memo of token → project directory. Safe to cache forever within a process:
 * a share is minted into one project and never moves, so this mapping is
 * immutable for the token's whole life. Status (revoked / still present) is
 * NOT cached — `resolveActiveShare` re-reads the registry every time.
 */
const projectDirByToken = new Map<string, string>()

/** Test seam: forget the memo so a fixture can reuse a directory path. */
export function clearShareLookupMemo(): void {
  projectDirByToken.clear()
}

export interface ResolvedShare {
  dir: string
  record: ShareRecord
}

/**
 * The live share for a token presented by an anonymous visitor, or `null` for
 * every failure mode there is — malformed token, no such share, revoked
 * share, project deleted. The caller renders ONE 404 for all of them: telling
 * a stranger which of those happened is telling them whether a token ever
 * existed.
 */
export function resolveActiveShare(token: string): ResolvedShare | null {
  if (!isShareTokenShape(token)) return null

  const memoised = projectDirByToken.get(token)
  if (memoised) {
    const record = findShareRecord(memoised, token)
    if (record && !record.revokedAt) return { dir: memoised, record }
    // The project moved, the file was rewritten, or the share was revoked.
    // Drop the memo and fall through to a fresh scan — a revoked share will
    // simply not be found again, at the cost of one scan.
    projectDirByToken.delete(token)
  }

  for (const projectDir of candidateProjectDirs()) {
    const record = findShareRecord(projectDir, token)
    if (!record) continue
    projectDirByToken.set(token, projectDir)
    return record.revokedAt ? null : { dir: projectDir, record }
  }
  return null
}

/**
 * Every project directory that could hold a `shares.json`.
 *
 * Deliberately NOT `listStudioProjects` — that walks each project's pages
 * directory to compute a page count, which is real work for a question this
 * scan never asks. A scan runs on the first request for each token (and on
 * every request carrying a token that does not exist, which is what a probe
 * looks like), so it must stay a single `readdir` plus one small file read
 * per project.
 */
function candidateProjectDirs(): string[] {
  const root = projectsRootDir()
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_WORKSPACE_DIR_NAMES.has(entry.name))
    .map((entry) => join(root, entry.name))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function toShareSummary(record: ShareRecord): ShareSummary {
  return {
    token: record.token,
    boardId: record.boardId,
    boardName: record.boardName,
    createdAt: record.createdAt,
    snapshotAt: record.snapshotAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    frameCount: record.frameCount,
  }
}

/** Every share this project has ever minted, newest first, revoked ones included. */
export function listShareSummaries(dir: string): ShareSummary[] {
  return readSharesFile(dir)
    .shares.map(toShareSummary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Insert or replace one record, preserving the order of the others. */
export function upsertShareRecord(dir: string, record: ShareRecord): void {
  const file = readSharesFile(dir)
  const index = file.shares.findIndex((s) => s.token === record.token)
  const shares = [...file.shares]
  if (index === -1) shares.push(record)
  else shares[index] = record
  writeSharesFile(dir, { version: 1, shares })
  projectDirByToken.set(record.token, dir)
}

/**
 * Revoke a share: stamp the record and DELETE the snapshot bytes. Both halves
 * matter — the stamp is what every later request checks, and removing the
 * PNGs means a future bug in the serving path has nothing left to leak.
 * Returns the updated record, or `null` when the token is unknown here.
 */
export function revokeShareRecord(dir: string, token: string, now: string): ShareRecord | null {
  const existing = findShareRecord(dir, token)
  if (!existing) return null
  if (!existing.revokedAt) {
    const revoked: ShareRecord = { ...existing, revokedAt: now }
    upsertShareRecord(dir, revoked)
    deleteShareSnapshot(dir, token)
    return revoked
  }
  return existing
}

/** Remove a share's snapshot directory. Idempotent; never throws on a missing directory. */
export function deleteShareSnapshot(dir: string, token: string): void {
  const snapshotDir = shareSnapshotDir(dir, token)
  if (!snapshotDir) return
  rmSync(snapshotDir, { recursive: true, force: true })
}
