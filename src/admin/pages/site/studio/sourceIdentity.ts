/**
 * sourceIdentity — the board's record of WHO each source position names, and
 * the client half of P1-A's element identity guard (WB-1, ERR-4).
 *
 * The parser stamps every source-derived node (`PageNode.sourceFingerprint`)
 * and every literal origin (`textOrigin`/`assetOrigin`/`resolvedProps[*].origin`
 * `.fingerprint`) with a fingerprint of what it read there. Every write the
 * board posts sends those back as `expect`, and the server refuses
 * `element-moved` when the element now at that `line:col` is a different one —
 * instead of writing to the neighbour that slid into the line.
 *
 * ## Why a table beside the store, not a read of the tree
 *
 * Three things the live tree cannot answer:
 *
 *   - A DELETE removes its node from the tree optimistically, before its
 *     commit posts, so the tree no longer knows what the deleted element was.
 *   - A VALUE write changes the very bytes the fingerprint covers (a prop, a
 *     class, the text) without moving anything, and the board does not re-read
 *     a file for a write that shifted nothing — so the tree's fingerprint goes
 *     stale, and the next edit to the same element would be refused by
 *     Studio's own previous write. The save response reports the new
 *     identity ({@link recordOwnWrites}), and it lands here.
 *   - A gesture QUEUED behind an in-flight structural commit
 *     (`structuralCommitQueue.ts`) holds ids from before that commit's
 *     resync. The same id may name a different element afterwards (ERR-4: a
 *     delete queued behind a move deleted the moved element). The queue
 *     captures identities when the gesture is made and re-finds each one in
 *     the fresh table when it runs ({@link relocateCapturedIds}).
 *
 * ## A record is an object on purpose
 *
 * The table maps a source LOCATION (`rel:line:col`, the tail of a node id — two
 * composite ids with one tail are one element) to a mutable
 * {@link SourceIdentity}. A capture holds the RECORD, not a copy of its
 * fingerprint, which is what distinguishes the two ways an identity changes:
 *
 *   - Studio's own value write MUTATES the record in place — so a structural
 *     gesture captured before a flush that wrote a prop to the same element
 *     posts the post-write identity, not the stale one;
 *   - a re-read of the board REPLACES the records of every file it covers —
 *     so a capture taken before a resync keeps describing the element the
 *     user actually acted on, however the file was renumbered since.
 *
 * Store-agnostic (no `useEditorStore` import): `studioStructuralCommits.ts` is
 * inside the store's own build graph, and `usePersistence.ts` feeds this at
 * the moment pages reach the store ({@link noteBoardRead}).
 */
import {
  INLINE_ID_SEPARATOR,
  decodeSourceNodeId,
  sourceLocationKey,
  type Page,
  type PageNode,
  type SourceFingerprintExpectations,
} from '@core/page-tree'

/** One source position's identity, as the board last knew it. Mutable — see this module's doc. */
export interface SourceIdentity {
  readonly location: string
  fingerprint: string
}

/** The identities a gesture captured when it was made, keyed by the node id it named. */
export type IdentityCapture = ReadonlyMap<string, SourceIdentity>

const identities = new Map<string, SourceIdentity>()
const boardReadWaiters = new Set<() => void>()

function relOfLocation(location: string): string | null {
  return decodeSourceNodeId(location)?.rel ?? null
}

/** Every fingerprinted position a page's nodes name: each element, plus each literal origin behind a resolved value. */
function* pageIdentities(page: Page): Generator<[string, string]> {
  for (const node of Object.values(page.nodes) as PageNode[]) {
    const location = sourceLocationKey(node.id)
    if (location && node.sourceFingerprint) yield [location, node.sourceFingerprint]
    const origins = [node.textOrigin, node.assetOrigin, ...Object.values(node.resolvedProps ?? {}).map((entry) => entry.origin)]
    for (const origin of origins) {
      if (origin?.fingerprint) yield [`${origin.rel}:${origin.line}:${origin.col}`, origin.fingerprint]
    }
  }
}

/**
 * The board just read these pages from disk — record who each position names
 * now. `reset` is a whole-project load; `merge` is a narrow re-read, which
 * drops every recorded position in the files the fresh pages cover (a
 * position that moved must not linger as a second candidate for the same
 * element) and records the fresh ones as NEW objects, leaving any capture
 * taken before it describing the element as it was.
 *
 * Also releases anything waiting for the board to catch up with disk
 * ({@link waitForBoardRead}).
 */
export function noteBoardRead(pages: readonly Page[], mode: 'reset' | 'merge'): void {
  const fresh = new Map<string, string>()
  for (const page of pages) for (const [location, fingerprint] of pageIdentities(page)) fresh.set(location, fingerprint)
  if (mode === 'reset') {
    identities.clear()
  } else {
    const files = new Set([...fresh.keys()].map(relOfLocation))
    for (const location of identities.keys()) if (files.has(relOfLocation(location))) identities.delete(location)
  }
  for (const [location, fingerprint] of fresh) identities.set(location, { location, fingerprint })
  const waiters = [...boardReadWaiters]
  boardReadWaiters.clear()
  for (const resolve of waiters) resolve()
}

/** The records `nodeIds` name right now. An id with no recorded identity is simply absent — it is not guarded. */
export function captureIdentities(nodeIds: Iterable<string>): IdentityCapture {
  const capture = new Map<string, SourceIdentity>()
  for (const nodeId of nodeIds) {
    const location = sourceLocationKey(nodeId)
    const identity = location ? identities.get(location) : undefined
    if (identity) capture.set(nodeId, identity)
  }
  return capture
}

/** What to send as `expect`: each captured id's identity as it stands NOW (a value write since the capture has updated it in place). */
export function expectationsFor(capture: IdentityCapture): SourceFingerprintExpectations {
  const expect: SourceFingerprintExpectations = {}
  for (const [nodeId, identity] of capture) expect[nodeId] = identity.fingerprint
  return expect
}

/**
 * A save landed: each value write's target has a new identity. Updates the
 * record the write was CAPTURED against (even if a re-read has replaced it in
 * the table since — a capture still holding it must post the truth), and the
 * table's current record for that position when the write carried no capture.
 */
export function recordOwnWrites(
  capture: IdentityCapture | undefined,
  written: readonly { nodeId: string; fingerprint: string }[],
): void {
  for (const { nodeId, fingerprint } of written) {
    const captured = capture?.get(nodeId)
    if (captured) {
      captured.fingerprint = fingerprint
      continue
    }
    const location = sourceLocationKey(nodeId)
    const current = location ? identities.get(location) : undefined
    if (current) current.fingerprint = fingerprint
  }
}

/**
 * Where each captured id's element is NOW — `null` when any one of them cannot
 * be found honestly (it is gone, or two positions in its file now match it).
 *
 * An id is kept when its position still holds the captured identity. Otherwise
 * it is re-found by fingerprint among the positions recorded in the same file,
 * and only a single match counts; the id keeps its composite head (the call
 * site an inlined node was reached through) and gets the new tail. An id the
 * capture has no record for is kept as-is: it was never guarded, and this is
 * no worse than before.
 */
export function relocateCapturedIds(
  capture: IdentityCapture,
  nodeIds: Iterable<string>,
): Map<string, string> | null {
  const relocated = new Map<string, string>()
  for (const nodeId of nodeIds) {
    const captured = capture.get(nodeId)
    const location = sourceLocationKey(nodeId)
    if (!captured || !location) {
      relocated.set(nodeId, nodeId)
      continue
    }
    if (identities.get(location)?.fingerprint === captured.fingerprint) {
      relocated.set(nodeId, nodeId)
      continue
    }
    const rel = relOfLocation(location)
    const matches = [...identities.values()].filter(
      (identity) => identity.fingerprint === captured.fingerprint && relOfLocation(identity.location) === rel,
    )
    if (matches.length !== 1) return null
    const cut = nodeId.lastIndexOf(INLINE_ID_SEPARATOR)
    relocated.set(nodeId, cut < 0 ? matches[0]!.location : `${nodeId.slice(0, cut + 1)}${matches[0]!.location}`)
  }
  return relocated
}

/**
 * ERR-8 — the one position in `rel` the board last read holding an element
 * with this `fingerprint`, or `null` when there is none or more than one. A
 * paste uses it to find what it copied after an edit above renumbered the
 * file; a guess between two identical elements is not an answer.
 */
export function findUniqueLocation(rel: string, fingerprint: string): string | null {
  let found: string | null = null
  for (const identity of identities.values()) {
    if (identity.fingerprint !== fingerprint || relOfLocation(identity.location) !== rel) continue
    if (found !== null) return null
    found = identity.location
  }
  return found
}

/**
 * Resolves `true` the next time the board reads pages from disk (a narrow
 * patch or a full load — {@link noteBoardRead}), `false` after `timeoutMs`
 * with no read. Register BEFORE triggering the re-read: a narrow resync
 * applies its patch synchronously inside the call that asked for it.
 */
export function waitForBoardRead(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onRead = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      boardReadWaiters.delete(onRead)
      resolve(false)
    }, timeoutMs)
    boardReadWaiters.add(onRead)
  })
}

/** Test seam: forget every recorded identity and waiter, so one spec cannot hand its table to the next. */
export function resetSourceIdentities(): void {
  identities.clear()
  boardReadWaiters.clear()
}
