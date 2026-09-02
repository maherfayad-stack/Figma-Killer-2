/**
 * componentCatalog — the client half of Track E1's `GET
 * /admin/api/studio/components` (`server/handlers/studio/components.ts`),
 * un-consumed until E2.5. Every exported, PascalCase-named component
 * declared anywhere in the current project, with its declared `PropKind`
 * per prop — what the unified Component section (`InstanceCallSiteView.tsx`)
 * drives its row set from, instead of the call site's own (possibly empty)
 * attribute list.
 *
 * **Cost-aware on purpose.** E1's own measurement: ~755ms cold for a
 * few-hundred-file project (a fixed TS binder cost, not per-file), ~59ms on
 * a re-walk of an already-bound `Project` — but this endpoint builds a FRESH
 * `Project` per HTTP request, so there is no in-process reuse to lean on
 * from the browser's side either. This module fetches ONCE per (workspace
 * dir), caches the in-flight/resolved promise, and is never called from a
 * per-render selector or a per-keystroke path — only from a `useEffect` on
 * mount/dir-change (`useLocalComponentCatalog`) and from the slot-fill
 * picker's one-time "open" click, mirroring `InstanceCallSiteView.tsx`'s own
 * pre-existing `openSwapPicker` precedent for "imperative read triggered by
 * a click, not a reactive selector".
 */
import { useEffect, useState } from 'react'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { LocalComponentSpecSchema, type LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { studioWriteDir } from './studioSaveRequests'

const ComponentsResponseSchema = Type.Object({
  components: Type.Array(LocalComponentSpecSchema),
})

/** Never mutated — a stable empty-array identity for the "not loaded yet" / "fetch failed" case (`selectorStability`). */
const EMPTY_CATALOG: readonly LocalComponentSpec[] = []

let cache: { dir: string | undefined; promise: Promise<LocalComponentSpec[]> } | null = null

/**
 * Fetches the current project's component catalog, cached per workspace dir.
 * Never throws — a network failure or an unreachable project resolves to an
 * empty catalog (logged), matching the route's own "never errors, an empty
 * project yields `[]`" contract.
 */
export function fetchLocalComponentCatalog(): Promise<LocalComponentSpec[]> {
  const dir = studioWriteDir() ?? undefined
  if (cache && cache.dir === dir) return cache.promise
  const promise = apiRequest('/admin/api/studio/components', {
    query: { dir },
    schema: ComponentsResponseSchema,
  })
    .then((res) => res.components)
    .catch((err) => {
      console.error('[componentCatalog] fetch failed:', err)
      return []
    })
  cache = { dir, promise }
  return promise
}

/** Drops the cached catalog — call after an edit that changes which components exist (e.g. a future "promote to component"). */
export function invalidateLocalComponentCatalog(): void {
  cache = null
}

/**
 * React hook wrapper: the catalog for the CURRENT project, or the frozen
 * `EMPTY_CATALOG` while loading/on failure. One fetch per mount (the
 * underlying promise is cached by dir, so re-mounting the same panel for a
 * different node in the same project is free).
 */
export function useLocalComponentCatalog(): readonly LocalComponentSpec[] {
  const [components, setComponents] = useState<readonly LocalComponentSpec[]>(EMPTY_CATALOG)
  useEffect(() => {
    let cancelled = false
    fetchLocalComponentCatalog().then((list) => {
      if (!cancelled) setComponents(list)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return components
}

/**
 * Best-effort match of a `studio.instance`'s `{componentName, sourceFile}`
 * against the catalog. Matches on `file` first (both are workspace-root-
 * relative POSIX paths — `inlineLocalComponents.ts`'s `targetRelFile` and
 * `LocalComponentSpec.file` share the exact same convention), then narrows
 * by `name === componentName` when a file declares more than one component,
 * falling back to the default export, then the first entry. An aliased
 * import (`import { Card as MyCard } from './Card'`, used as `<MyCard/>`)
 * is the one case this can misidentify — `componentName` is the call site's
 * own JSX tag name, which is the LOCAL BINDING name, not necessarily the
 * export's own name; disclosed, not silently "fixed" by guessing further.
 */
export function findLocalComponentSpec(
  catalog: readonly LocalComponentSpec[],
  componentName: string,
  sourceFile: string,
): LocalComponentSpec | null {
  const inFile = catalog.filter((c) => c.file === sourceFile)
  if (inFile.length === 0) return null
  return (
    inFile.find((c) => c.name === componentName) ??
    inFile.find((c) => c.isDefaultExport) ??
    inFile[0] ??
    null
  )
}
