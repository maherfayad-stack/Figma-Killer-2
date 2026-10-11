/**
 * frameGeometryRegistry — the board-wide home of every mounted frame's
 * {@link FrameGeometryIndex}: build it on demand, keep it until the frame says
 * it went stale, and hit-test across frames in board space.
 *
 * ## Lifecycle
 *
 * Frames are discovered through `canvasFrameAdapterRegistry` (the registry of
 * "every mounted canvas frame's adapter"), not by scanning the DOM. An index is
 * built LAZILY, the first time something asks for a frame's geometry, by
 * `adapter.measureAll()`. That first call is also what arms the frame's dirty
 * signal (`geometry:dirty`), so a frame nobody queries costs nothing: no
 * observers, no reads, no messages.
 *
 * After that the entry is trusted until the adapter reports `geometry:dirty`
 * (existing observers: see `geometryDirtySignal.ts`). A stale entry is re-read
 * by the next {@link getFrameGeometry}; {@link peekFrameGeometry} returns the
 * last build, stale or not, for callers that must not wait (SB-4's paint).
 *
 * ## Where the frame sits on the board
 *
 * Read from the DOM when an index is handed out: the iframe's client rect and
 * the board-origin element (`findBoardOrigin`), converted exactly once. That is
 * two rect reads per frame in the parent document, only for the frames a query
 * actually touches, and it keeps a dragged frame honest without a store
 * subscription. SB-4/SB-5 replace it with the store's frame positions when they
 * need it for frames that have no iframe at all.
 *
 * ## Why async
 *
 * `measureAll` is Promise-shaped so a bridge frame (a real `postMessage` round
 * trip) and a portal frame (synchronous) share one signature. A fresh portal
 * index resolves in a microtask; a warm one resolves from the cache.
 */
import { clientToBoardPoint, findBoardOrigin } from '../BoardCanvasLayer/canvasLayerGeometry'
import type { FrameDocumentAdapter, Unsubscribe } from '../frameAdapter/FrameDocumentAdapter'
import { listFrameAdapterRegistrations, onFrameAdapterRegistryChange } from '../frameAdapter/canvasFrameAdapterRegistry'
import { FrameGeometryIndex, type BoardPoint, type FrameHit } from './frameGeometryIndex'

interface FrameGeometryEntry {
  adapter: FrameDocumentAdapter
  index: FrameGeometryIndex | null
  /** Bumped by every `geometry:dirty`; a build is stale if this moved while it was in flight. */
  epoch: number
  /** The epoch `index` was read at; `index` is fresh iff it equals `epoch`. */
  builtAtEpoch: number
  inflight: Promise<FrameGeometryIndex | null> | null
  /** The epoch `inflight` started at. */
  inflightEpoch: number
  unsubscribe: Unsubscribe
}

const entries = new Map<HTMLIFrameElement, FrameGeometryEntry>()
const dirtyListeners = new Set<(iframe: HTMLIFrameElement) => void>()
let stopWatchingAdapters: (() => void) | null = null

/** Reconciles `entries` with the adapter registry: a new adapter gets an entry, a gone or replaced one loses it. */
function syncEntries(): void {
  const registrations = listFrameAdapterRegistrations()
  for (const [iframe, entry] of entries) {
    if (registrations.get(iframe)?.adapter !== entry.adapter) {
      entry.unsubscribe()
      entries.delete(iframe)
    }
  }
  for (const [iframe, { adapter }] of registrations) {
    if (entries.has(iframe)) continue
    const entry: FrameGeometryEntry = {
      adapter,
      index: null,
      epoch: 1,
      builtAtEpoch: 0,
      inflight: null,
      inflightEpoch: 0,
      unsubscribe: adapter.on('geometry:dirty', () => {
        entry.epoch += 1
        for (const listener of [...dirtyListeners]) listener(iframe)
      }),
    }
    entries.set(iframe, entry)
  }
}

/** Starts following adapter (un)registrations on first use, then reconciles once. */
function ensureWatching(): void {
  stopWatchingAdapters ??= onFrameAdapterRegistryChange(syncEntries)
  syncEntries()
}

function entryFor(iframe: HTMLIFrameElement): FrameGeometryEntry | null {
  ensureWatching()
  return entries.get(iframe) ?? null
}

/** Where the iframe's viewport top-left sits on the board, or `null` off a Studio board. */
function readFrameBoardOrigin(iframe: HTMLIFrameElement): BoardPoint | null {
  const boardOrigin = findBoardOrigin(iframe.ownerDocument)
  if (!boardOrigin) return null
  const rect = iframe.getBoundingClientRect()
  return clientToBoardPoint({ x: rect.left, y: rect.top }, boardOrigin, boardOrigin.zoom)
}

/**
 * Reads (or reuses) the entry's index. `origin` is only used to stamp a NEW build; a reused index keeps the origin
 * its last board-space caller gave it. A read already in flight is shared only while it is still current: one that
 * started before the latest `geometry:dirty` would hand back a picture the frame has since left, and the latch means
 * no further signal would ever correct it, so a newer read is queued behind it instead.
 */
function indexOf(iframe: HTMLIFrameElement, entry: FrameGeometryEntry, origin: BoardPoint): Promise<FrameGeometryIndex | null> {
  if (entry.index && entry.builtAtEpoch === entry.epoch) return Promise.resolve(entry.index)
  if (entry.inflight && entry.inflightEpoch === entry.epoch) return entry.inflight
  const queuedAtEpoch = entry.epoch
  const read = (): Promise<FrameGeometryIndex | null> => {
    const epochAtRead = entry.epoch
    return entry.adapter.measureAll().then(
      (snapshot) => {
        // The adapter may have been replaced while the read was out.
        if (entries.get(iframe) !== entry) return null
        entry.index = FrameGeometryIndex.fromSnapshot(snapshot, origin)
        entry.builtAtEpoch = epochAtRead
        return entry.index
      },
      (err: unknown) => {
        console.error('[frameGeometryRegistry] measureAll failed:', err)
        return null
      },
    )
  }
  const previous = entry.inflight
  const inflight: Promise<FrameGeometryIndex | null> = (previous ? previous.then(read, read) : read()).finally(() => {
    if (entry.inflight === inflight) entry.inflight = null
  })
  entry.inflight = inflight
  entry.inflightEpoch = queuedAtEpoch
  return inflight
}

/**
 * The frame's geometry index in BOARD space, re-read first if it was never built or went stale. `null` when the
 * iframe has no registered adapter, or it is not on a Studio board. Concurrent callers share one read.
 */
export function getFrameGeometry(iframe: HTMLIFrameElement): Promise<FrameGeometryIndex | null> {
  const entry = entryFor(iframe)
  if (!entry) return Promise.resolve(null)
  const origin = readFrameBoardOrigin(iframe)
  if (!origin) return Promise.resolve(null)
  return indexOf(iframe, entry, origin).then((index) => {
    index?.setOrigin(origin)
    return index
  })
}

/**
 * The frame's geometry index for chrome that rides the frame (SB-4: rings, handles, badges are painted in the
 * frame's own viewport px beside the iframe), re-read first if it was never built or went stale. Reads
 * `localRectOf`, which does not depend on the frame's place on the board, so it works for a CMS / Visual
 * Component frame too, and never touches the origin a board-space caller set. `null` only when the iframe has no
 * registered adapter. Concurrent callers share one read.
 */
export function getFrameLocalGeometry(iframe: HTMLIFrameElement): Promise<FrameGeometryIndex | null> {
  const entry = entryFor(iframe)
  return entry ? indexOf(iframe, entry, { x: 0, y: 0 }) : Promise.resolve(null)
}

/**
 * The frame's local geometry index THIS TASK, or `null` when only an async read can answer (a bridge frame with a
 * stale or missing index, an iframe with no registered adapter). A fresh index is returned as is; a stale one is
 * re-read synchronously when the adapter can (`measureAllNow`: a same-origin frame). This is what lets a press, a
 * hover or a layout effect place chrome in the task of the event that moved it.
 */
export function readFrameLocalGeometryNow(iframe: HTMLIFrameElement): FrameGeometryIndex | null {
  const entry = entryFor(iframe)
  if (!entry) return null
  if (entry.index && entry.builtAtEpoch === entry.epoch) return entry.index
  // A read already out belongs to a bridge frame; a same-origin frame has none, but never race one regardless.
  if (entry.inflight) return null
  const epochAtRead = entry.epoch
  const snapshot = entry.adapter.measureAllNow()
  if (!snapshot) return null
  entry.index = FrameGeometryIndex.fromSnapshot(snapshot, entry.index?.origin ?? { x: 0, y: 0 })
  entry.builtAtEpoch = epochAtRead
  return entry.index
}

/** True when the frame's last-built index is still trusted: it exists and no `geometry:dirty` arrived since. */
export function isFrameGeometryFresh(iframe: HTMLIFrameElement): boolean {
  const entry = entryFor(iframe)
  return entry !== null && entry.index !== null && entry.builtAtEpoch === entry.epoch
}

/** The last index built for the frame, fresh or not; `null` when none was ever built. Never reads the frame. */
export function peekFrameGeometry(iframe: HTMLIFrameElement): FrameGeometryIndex | null {
  return entryFor(iframe)?.index ?? null
}

/** Calls `listener` whenever any frame reports its geometry may be stale (a latch per read: see `geometry:dirty`). */
export function onFrameGeometryDirty(listener: (iframe: HTMLIFrameElement) => void): Unsubscribe {
  ensureWatching()
  dirtyListeners.add(listener)
  return () => {
    dirtyListeners.delete(listener)
  }
}

/** What a board hit test found: the frame it landed in and every node under the point there, topmost first. */
export interface BoardHit {
  iframe: HTMLIFrameElement
  breakpointId: string
  hits: FrameHit[]
}

/**
 * Hit-tests a parent-document client point against the mounted frames' indexes. Frames are visited topmost first
 * (registry order, reversed) and only those whose client box contains the point are read, so a point over empty
 * board costs no frame read at all. Returns `null` over empty board or off a Studio board.
 */
export async function hitTestBoard(client: { x: number; y: number }): Promise<BoardHit | null> {
  ensureWatching()
  const boardOrigin = findBoardOrigin(document)
  if (!boardOrigin) return null
  const board = clientToBoardPoint(client, boardOrigin, boardOrigin.zoom)
  const registrations = [...listFrameAdapterRegistrations()].reverse()
  for (const [iframe, { breakpointId }] of registrations) {
    const rect = iframe.getBoundingClientRect()
    if (client.x < rect.left || client.x > rect.right || client.y < rect.top || client.y > rect.bottom) continue
    const index = await getFrameGeometry(iframe)
    if (!index) continue
    return { iframe, breakpointId, hits: index.nodesAt(board) }
  }
  return null
}
