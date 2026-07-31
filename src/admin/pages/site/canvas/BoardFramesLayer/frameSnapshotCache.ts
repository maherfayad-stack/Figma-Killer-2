/**
 * frameSnapshotCache — in-memory poster cache for offscreen board frames
 * (WS-5.3).
 *
 * `isFrameOnScreen` (`frameVirtualization.ts`) already unmounts a frame's
 * live iframe once it leaves the viewport margin — that's the correctness
 * half of virtualization. Without a poster, an offscreen frame renders as an
 * empty box with just a title, so panning a 50-frame board loses the
 * content the user was just looking at. This cache holds one rasterized PNG
 * per settled frame so the placeholder shows a frozen picture instead.
 *
 * Cache key: `(page, width)`. The plan text (`STUDIO-IMPORT-V2-PLAN.md`
 * WS-5.3) specs the key as `(pageId, width, treeRevision)` — this
 * implementation gets `treeRevision` for free from the store's existing
 * structural-sharing guarantee instead of maintaining a parallel counter:
 * `site.pages[i]` (a Mutative/Immer-style immutable tree) is a NEW object
 * reference exactly when that page's content changes, and the SAME
 * reference when it doesn't (confirmed: `zustand-mutative` + `create({
 * enablePatches: true })`, `src/admin/pages/site/store/slices/site/helpers.ts`).
 * Keying a `WeakMap` on the `Page` object itself therefore IS the tree
 * revision, with no extra bookkeeping: an edit produces a new `Page` object,
 * a lookup under the new object misses, and the stale entry is simply
 * unreachable (GC'd once nothing else references the old `Page`, e.g. after
 * it ages out of undo history).
 */

import type { Page } from '@core/page-tree'

interface PosterEntry {
  dataUrl: string
  width: number
}

const posterCache = new WeakMap<Page, PosterEntry>()

/**
 * The cached poster for `page` at `width`, or `undefined` if none exists yet
 * or the cached one was captured at a different frame width (Phase 6E
 * resizable frames — a resize invalidates by simply not matching).
 */
export function getFramePoster(page: Page, width: number): string | undefined {
  const entry = posterCache.get(page)
  if (!entry || entry.width !== width) return undefined
  return entry.dataUrl
}

export function setFramePoster(page: Page, width: number, dataUrl: string): void {
  posterCache.set(page, { dataUrl, width })
}
