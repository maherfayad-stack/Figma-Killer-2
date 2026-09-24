/**
 * keyedNotifier — listeners grouped by key, notified by key.
 *
 * The primitive behind the canvas's per-node hover and selection reads
 * (PERF-1, audit `01-perf.md`). Zustand runs EVERY subscribed selector on
 * EVERY `set()`, so a per-node `useEditorStore((s) => …)` costs one selector
 * run per mounted node per store change — ~40k runs per hover crossing on a
 * 40 × 300 board with 12 mounted frames. A keyed notifier inverts that: the
 * writer works out which keys changed and wakes only their listeners, so a
 * hover crossing costs two listener calls however many nodes are mounted.
 *
 * Deliberately tiny and React-free: a hook pairs it with
 * `useSyncExternalStore`, whose `getSnapshot` does the (cheap, per-key) read.
 */
export interface KeyedNotifier {
  /** Listen for `key`. Returns the unsubscribe. */
  subscribe(key: string, listener: () => void): () => void
  /** Wake every listener of every key in `keys`. A key with no listeners costs one `Map` miss. */
  notify(keys: Iterable<string>): void
  /** How many listeners are registered across every key. */
  listenerCount(): number
}

export function createKeyedNotifier(): KeyedNotifier {
  const listenersByKey = new Map<string, Set<() => void>>()
  let count = 0

  return {
    subscribe(key, listener) {
      let listeners = listenersByKey.get(key)
      if (!listeners) {
        listeners = new Set()
        listenersByKey.set(key, listeners)
      }
      if (!listeners.has(listener)) {
        listeners.add(listener)
        count += 1
      }
      return () => {
        const current = listenersByKey.get(key)
        if (!current?.delete(listener)) return
        count -= 1
        if (current.size === 0) listenersByKey.delete(key)
      }
    },
    notify(keys) {
      for (const key of keys) {
        const listeners = listenersByKey.get(key)
        if (!listeners) continue
        // A listener may unsubscribe (a row unmounting) while we iterate.
        for (const listener of [...listeners]) listener()
      }
    },
    listenerCount() {
      return count
    },
  }
}
