/**
 * localizedPageSlice — WS-10 §4.4 (Phase 4): the `(pageId, locale)` keying
 * the coordinator asked for, landed as the SMALLEST change that lets a board
 * frame render a different tree — a PARALLEL map, not a reshape of `Page[]`.
 *
 * `site.pages` (`src/core/page-tree/siteDocument.ts`) stays exactly what it
 * has always been: one `Page` per `pageId`, the board-DEFAULT-locale parse,
 * load-bearing for the publisher and the CMS half of this fork. A "duplicate
 * as variant" frame whose `axes.locale` differs from the board's current
 * `previewAxes.locale` reads from `localizedPages` INSTEAD, keyed by
 * `localizedPageKey(pageId, locale)` — never touching `site.pages` at all.
 *
 * **The node id grammar does not change** (trap #2) — a locale-variant
 * `Page`'s nodes carry the SAME ids as the default tree's (both are `${relFile}:
 * ${line}:${col}`, a pure function of AST POSITION, never of the resolved
 * VALUE — see `parsePageFile.ts`), because both are parses of the SAME
 * source file with only the dictionary branch pick (`preferredKey`)
 * differing. Selection/hover already resolve this correctly with ZERO
 * change needed here: Phase 2's `(frameId, nodeId)` re-keying
 * (`selectionSlice.ts`) doesn't care WHICH tree a node id's DATA came from,
 * only which FRAME the click/hover belonged to.
 *
 * **What Phase 2's keying did NOT provide, and this slice adds:** a
 * per-frame "which tree do I render" dimension. `selectCanvasPageFor`
 * (`store.ts`) is the ONE function every node-data read in `NodeRenderer`
 * goes through — extending IT with an optional `frameId` (this slice's only
 * externally-visible read API, `resolveFrameLocalizedPage`) is what makes a
 * frame's OWN locale override actually apply, with no other call site
 * needing to change.
 *
 * **Fetch, not reshape.** A locale-variant page is fetched on demand — see
 * `useEnsureLocalizedPage` (`canvas/useEnsureLocalizedPage.ts`) — from a NEW,
 * narrow server route (`GET /admin/api/studio/localized-page`,
 * `server/handlers/studio/localizedPage.ts`) that parses ONE page under an
 * explicit `preferredKey` override, not the whole project. A frame whose
 * locale did NOT change never triggers a fetch and never re-renders from
 * this slice at all — `status`/`page` for its key simply doesn't exist yet
 * (or already does, cached).
 *
 * **Text writeback (WS-10 §4.4's "most valuable behaviour")** — see
 * `inlineEditSlice.ts`'s doc for the read/write split: a locale-variant
 * node's `textOrigin` (computed under ITS OWN `preferredKey`) already points
 * at the correct dictionary branch's string literal — that falls out of the
 * EXISTING §7.4 mechanism, verified in
 * `server/handlers/__tests__/localizedPage.test.ts`. `updateLocalizedNodeText`
 * below is the mutation this slice exposes for `inlineEditSlice.ts` to call
 * INSTEAD of `updateNodeProps` when a text-edit session belongs to a
 * locale-variant frame — a plain, undo-EXEMPT mutation (see its own doc for
 * why that's an explicit, documented scope boundary, not an oversight).
 *
 * **Out of scope, explicitly:** non-text prop/style edits (Properties panel)
 * are NOT locale-variant-aware — selecting a node for the panel still
 * resolves through the board-DEFAULT tree regardless of which frame you
 * clicked in. Colour/spacing/etc. aren't "which locale's branch" concepts
 * the way text is, so this is a defensible line, not a gap in the same
 * class as the text one — but it IS a real, named scope boundary. See
 * `STATE.md`'s handoff for the full reasoning.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { PageSchema, type Page } from '@core/page-tree'
import type { EditorStoreSliceCreator } from '@site/store/types'

/** `${pageId}::${locale}` — the one key shape every read/write in this slice uses. Exported so `store.ts`'s `selectCanvasPageFor` and the fetch hook agree on it without duplicating the format. */
export function localizedPageKey(pageId: string, locale: string): string {
  return `${pageId}::${locale}`
}

type LocalizedPageStatus = 'loading' | 'ready' | 'error'

interface LocalizedPageSlice {
  /** Keyed by `localizedPageKey`. Absent (not `undefined` explicitly) means "never fetched." */
  localizedPages: Record<string, Page>
  localizedPageStatus: Record<string, LocalizedPageStatus>
  /**
   * Fetches (once) the `(pageId, locale)` tree from the server and stores it.
   * A concurrent second call for the SAME key while one is already `loading`
   * is a no-op — `useEnsureLocalizedPage` calls this on every relevant
   * render, so this guard is what keeps that from firing N redundant
   * requests. Never throws — a failed fetch sets `status: 'error'` and
   * leaves `localizedPages[key]` absent, which `selectCanvasPageFor` treats
   * as "fall back to the default tree" (see that function's own doc) so a
   * probe/parse failure degrades to SOMETHING on screen, never a blank frame.
   */
  ensureLocalizedPage: (dir: string, pageId: string, locale: string) => Promise<void>
  /**
   * `inlineEditSlice.ts`'s locale-variant text-edit path. Mutates
   * `localizedPages[key].nodes[nodeId].props[prop]` directly — deliberately
   * NOT routed through `mutateActiveTree`/`updateNodeProps` (those operate on
   * `site`, which this map is not part of) and deliberately NOT
   * patch-tracked for undo (see this slice's module doc — a documented scope
   * boundary, not an oversight: `boardSlice.ts`'s frame drags are the same
   * "real edit, no undo entry" precedent). No-ops when the key or node
   * doesn't exist (session outlived the fetch, or the page changed under it).
   */
  updateLocalizedNodeText: (pageId: string, locale: string, nodeId: string, prop: string, value: string) => void
}

declare module '@site/store/types' {
  interface EditorStore extends LocalizedPageSlice {}
}

const LocalizedPageResponseSchema = Type.Object({
  page: Type.Union([PageSchema, Type.Null()]),
})

export const createLocalizedPageSlice: EditorStoreSliceCreator<LocalizedPageSlice> = (set, get) => ({
  localizedPages: {},
  localizedPageStatus: {},

  ensureLocalizedPage: async (dir, pageId, locale) => {
    const key = localizedPageKey(pageId, locale)
    if (get().localizedPageStatus[key]) return // already loading, ready, or errored — no re-fetch
    set((s) => {
      s.localizedPageStatus[key] = 'loading'
    })
    try {
      const { page } = await apiRequest('/admin/api/studio/localized-page', {
        schema: LocalizedPageResponseSchema,
        query: { dir, pageId, locale },
      })
      set((s) => {
        if (page) s.localizedPages[key] = page
        s.localizedPageStatus[key] = page ? 'ready' : 'error'
      })
    } catch (err) {
      console.error('[localizedPageSlice] failed to fetch locale-variant page:', err)
      set((s) => {
        s.localizedPageStatus[key] = 'error'
      })
    }
  },

  updateLocalizedNodeText: (pageId, locale, nodeId, prop, value) => {
    const key = localizedPageKey(pageId, locale)
    set((s) => {
      const node = s.localizedPages[key]?.nodes[nodeId]
      if (!node) return
      node.props[prop] = value
    })
  },
})
