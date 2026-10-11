/**
 * posterStore — the board's pictures of its own frames (SB-2).
 *
 * Replaces `frameSnapshotCache.ts`, a `WeakMap<Page, dataUrl>` that died with
 * the tab, kept a base64 string per frame and could only ever hold a picture
 * for the exact `Page` object it was taken from.
 *
 * - Keyed by {@link posterKey}: frame id + content hash + preview axes +
 *   width. A stale picture is unreachable by construction, never "invalidated".
 * - ONE picture per frame: putting a new key for a frame drops that frame's
 *   older ones (memory and disk), so an edited frame cannot grow the store.
 * - In-memory LRU by encoded bytes. A picture is a `Blob` (WebP) with a
 *   lazily-made object URL, so an `<img>` costs no base64 copy and an
 *   evicted entry gives its URL back.
 * - Persisted through a {@link PosterPersistence} (IndexedDB in the browser)
 *   so reopening a board paints every frame's picture before any iframe boots.
 *   Persistence is best-effort: a failed read or write leaves the memory store
 *   exactly as correct as it was.
 *
 * Reads are synchronous (`peek`) so a frame can render the picture in the
 * same commit; `ensure` hydrates a key from persistence and notifies.
 */
import { posterKeyFrameId } from './posterKey'

/** Where pictures live between sessions. Every method may reject; the store treats that as a miss. */
export interface PosterPersistence {
  get(key: string): Promise<Blob | undefined>
  /** Store `blob` under `key` and drop the frame's other keys. */
  put(key: string, frameId: string, blob: Blob): Promise<void>
  /** Drop every key of `frameId`, or every key when omitted. */
  clear(frameId?: string): Promise<void>
}

/** How a blob becomes an `<img src>` and gives it back. Injectable because `bun test` has no object URLs worth asserting on. */
export interface PosterUrls {
  create(blob: Blob): string
  revoke(url: string): void
}

const browserUrls: PosterUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

/** Encoded bytes the in-memory store may hold. A 480 px WebP is ~15-40 KB, so this is ~1,000+ frames. */
export const POSTER_MEMORY_BYTES = 48 * 1024 * 1024

interface Entry {
  blob: Blob
  url: string | null
}

export interface PosterStore {
  /** The picture's URL when it is in memory (and marks it recently used), else `undefined`. */
  peek(key: string): string | undefined
  /** Whether a picture for this exact key is already in memory. Does not touch recency. */
  has(key: string): boolean
  /** Load `key` from persistence into memory. Resolves true when a picture is now available. */
  ensure(key: string): Promise<boolean>
  put(key: string, blob: Blob): void
  /** Forget one frame's pictures, or all of them. */
  invalidate(frameId?: string): void
  subscribe(listener: () => void): () => void
  /** Entries and bytes currently in memory. */
  stats(): { entries: number; bytes: number }
}

interface PosterStoreOptions {
  persistence?: PosterPersistence | null
  urls?: PosterUrls
  maxBytes?: number
}

export function createPosterStore({
  persistence = null,
  urls = browserUrls,
  maxBytes = POSTER_MEMORY_BYTES,
}: PosterStoreOptions = {}): PosterStore {
  // Map insertion order is the recency order: first key is the least recently used.
  const entries = new Map<string, Entry>()
  const hydrating = new Map<string, Promise<boolean>>()
  const listeners = new Set<() => void>()
  let bytes = 0

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const drop = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    bytes -= entry.blob.size
    if (entry.url) urls.revoke(entry.url)
  }

  const evictOverBudget = (keep: string) => {
    for (const key of entries.keys()) {
      if (bytes <= maxBytes) return
      if (key !== keep) drop(key)
    }
  }

  const insert = (key: string, blob: Blob) => {
    const frameId = posterKeyFrameId(key)
    for (const other of [...entries.keys()]) {
      if (other !== key && posterKeyFrameId(other) === frameId) drop(other)
    }
    drop(key)
    entries.set(key, { blob, url: null })
    bytes += blob.size
    evictOverBudget(key)
  }

  return {
    peek(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      entry.url ??= urls.create(entry.blob)
      return entry.url
    },
    has: (key) => entries.has(key),
    ensure(key) {
      if (entries.has(key)) return Promise.resolve(true)
      const inFlight = hydrating.get(key)
      if (inFlight) return inFlight
      if (!persistence) return Promise.resolve(false)
      const load = persistence
        .get(key)
        .then((blob) => {
          if (!blob || entries.has(key)) return entries.has(key)
          insert(key, blob)
          notify()
          return true
        })
        .catch(() => false)
        .finally(() => hydrating.delete(key))
      hydrating.set(key, load)
      return load
    },
    put(key, blob) {
      insert(key, blob)
      notify()
      void persistence?.put(key, posterKeyFrameId(key), blob).catch((err: unknown) => {
        console.warn('[posterStore] could not persist a poster:', err)
      })
    },
    invalidate(frameId) {
      for (const key of [...entries.keys()]) {
        if (frameId === undefined || posterKeyFrameId(key) === frameId) drop(key)
      }
      notify()
      void persistence?.clear(frameId).catch((err: unknown) => {
        console.warn('[posterStore] could not clear persisted posters:', err)
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stats: () => ({ entries: entries.size, bytes }),
  }
}
