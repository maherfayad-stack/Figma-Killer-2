/**
 * replaceEqualDeep — structural sharing between two versions of a value.
 *
 * Returns `next` with every plain-object or array subtree that is deep-equal
 * to the one at the same place in `prev` replaced by `prev`'s object. When the
 * whole of `next` is deep-equal to `prev`, `prev` itself comes back, so an
 * identity check (`===`, `Object.is`, a Zustand selector) sees "unchanged".
 *
 * Why: a value re-read from somewhere else (a page re-parsed from disk, a style
 * registry recomputed by the server) is a brand-new object graph even where
 * nothing changed, and every consumer that compares by identity re-renders
 * for it. Sharing the unchanged parts keeps that work proportional to what
 * actually changed (audit PERF-6).
 *
 * Records are matched by key, arrays by index. Only plain objects (prototype
 * `Object.prototype` or `null`) and arrays are descended into; anything else
 * (a Map, a Date, a class instance) is kept only when it is the same object.
 * Neither argument is mutated; the containers that differ are new objects, so
 * a frozen `prev` is safe to pass.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T

  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length
    const out = next.map((item: unknown, i) => {
      const shared = i < prev.length ? replaceEqualDeep(prev[i], item) : item
      if (shared !== prev[i]) same = false
      return shared
    })
    return (same ? prev : out) as T
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const nextKeys = Object.keys(next)
    let same = nextKeys.length === Object.keys(prev).length
    const out: Record<string, unknown> = Object.getPrototypeOf(next) === null ? Object.create(null) : {}
    for (const key of nextKeys) {
      const has = Object.prototype.hasOwnProperty.call(prev, key)
      const shared = has ? replaceEqualDeep(prev[key], next[key]) : next[key]
      if (!has || shared !== prev[key]) same = false
      out[key] = shared
    }
    return (same ? prev : out) as T
  }

  return next
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
