/**
 * framePosters — the one poster store of the running editor, and the hook a
 * frame reads its picture through (SB-2).
 *
 * The store is memory + IndexedDB. The hook paints from memory in the same
 * commit and, on a miss, asks persistence once, so a reopened board shows
 * every frame's last picture before any iframe has booted.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { EditorStore } from '@site/store/types'
import { siteStyleSignature } from './posterKey'
import { createIndexedDbPosterPersistence } from './posterPersistence'
import { createPosterStore } from './posterStore'

export const framePosters = createPosterStore({ persistence: createIndexedDbPosterPersistence() })

/** The picture URL for `key` (see `posterKey.ts`), or `undefined` until one exists. */
export function useFramePoster(key: string): string | undefined {
  const url = useSyncExternalStore(
    framePosters.subscribe,
    () => framePosters.peek(key),
    () => undefined,
  )
  useEffect(() => {
    void framePosters.ensure(key)
  }, [key])
  return url
}

/** Selector: the style inputs of the site, as the short string `posterKey` folds in. Primitive, so a consumer re-renders only when it changes. */
export function selectPosterStyleSignature(state: EditorStore): string {
  const site = state.site
  return siteStyleSignature({
    styleRules: site?.styleRules,
    breakpoints: site?.breakpoints,
    conditions: site?.conditions,
    framework: site?.settings.framework,
    fonts: site?.settings.fonts,
  })
}
