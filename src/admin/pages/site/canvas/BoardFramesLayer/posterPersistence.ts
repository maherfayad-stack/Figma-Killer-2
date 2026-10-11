/**
 * posterPersistence — the IndexedDB half of `posterStore` (SB-2).
 *
 * One object store, `posters`, keyed by the full poster key, with an index on
 * the frame id (a new picture for a frame deletes its older ones) and one on
 * the write time (the store is capped at {@link MAX_PERSISTED_POSTERS}, oldest
 * writes evicted first). Blobs go in as Blobs: IndexedDB stores them natively,
 * no base64.
 *
 * `null` when the browser has no IndexedDB (private modes, `bun test`): the
 * poster store then simply runs memory-only.
 */
import type { PosterPersistence } from './posterStore'

const DB_NAME = 'studio-posters'
const STORE = 'posters'
const BY_FRAME = 'frameId'
const BY_TIME = 'at'

/** Pictures kept on disk, across every project and board. ~30 KB each. */
export const MAX_PERSISTED_POSTERS = 600

interface StoredPoster {
  key: string
  frameId: string
  at: number
  blob: Blob
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, { keyPath: 'key' })
      store.createIndex(BY_FRAME, 'frameId')
      store.createIndex(BY_TIME, 'at')
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('could not open the poster database'))
  })
}

export function createIndexedDbPosterPersistence(): PosterPersistence | null {
  if (typeof indexedDB === 'undefined') return null
  let database: Promise<IDBDatabase> | null = null
  const db = () => (database ??= openDatabase())

  return {
    async get(key) {
      const tx = (await db()).transaction(STORE, 'readonly')
      const row = await request<StoredPoster | undefined>(tx.objectStore(STORE).get(key))
      return row?.blob
    },
    async put(key, frameId, blob) {
      const tx = (await db()).transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const stale = await request(store.index(BY_FRAME).getAllKeys(frameId))
      for (const staleKey of stale) if (staleKey !== key) store.delete(staleKey)
      store.put({ key, frameId, at: Date.now(), blob } satisfies StoredPoster)
      const total = await request(store.count())
      if (total > MAX_PERSISTED_POSTERS) {
        const oldest = await request(store.index(BY_TIME).getAllKeys(undefined, total - MAX_PERSISTED_POSTERS))
        for (const oldKey of oldest) store.delete(oldKey)
      }
      await transactionDone(tx)
    },
    async clear(frameId) {
      const tx = (await db()).transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      if (frameId === undefined) store.clear()
      else for (const key of await request(store.index(BY_FRAME).getAllKeys(frameId))) store.delete(key)
      await transactionDone(tx)
    },
  }
}
