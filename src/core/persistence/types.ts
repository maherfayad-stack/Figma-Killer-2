import type { Page, SiteDocument } from '@core/page-tree'

/**
 * Which parts of the site document actually changed — and which rows were
 * deleted — since the last successful save. Produced by the editor store's
 * patch-derived dirty tracking and consumed by `saveSite` to ship an
 * incremental-mode save (changed rows + explicit deleted ids).
 *
 * `all: true` is the conservative sentinel — the save ships as a
 * replace-mode full save (used after imports, fresh-site marks, or any
 * mutation whose patches could not be attributed to specific rows).
 * Over-marking is always safe; under-marking would lose edits, so anything
 * ambiguous must mark all.
 */
interface SaveDirtyHints {
  all: boolean
  pageIds: ReadonlySet<string>
  componentIds: ReadonlySet<string>
  layoutIds: ReadonlySet<string>
  deletedPageIds: ReadonlySet<string>
  deletedComponentIds: ReadonlySet<string>
  deletedLayoutIds: ReadonlySet<string>
}

export interface SaveSiteOptions {
  /** Dirty hints from the editor store. Absent → replace-mode full save. */
  dirty?: SaveDirtyHints
}

/**
 * IPersistenceAdapter — the interface the CMS draft storage backend satisfies.
 */
export interface IPersistenceAdapter {
  /**
   * Persist the single site draft document atomically (one request, one
   * server transaction). With `opts.dirty`, ships an incremental save:
   * only the changed pages/components/layouts plus explicitly deleted row
   * ids. Without hints (or `dirty.all`), ships a replace-mode full save —
   * the server derives deletions as stored − shipped.
   */
  saveSite(site: SiteDocument, opts?: SaveSiteOptions): Promise<void>

  /**
   * Load the single site draft document (shell + pages assembled).
   * Returns undefined before setup creates it.
   */
  loadSite(id: string, options?: LoadSiteOptions): Promise<SiteDocument | undefined>
}

export interface LoadSiteOptions {
  /** Abandons the load: the request is aborted and the promise rejects with an `AbortError`. */
  signal?: AbortSignal
  /**
   * P6-B — hand the document over while its pages are still arriving. An
   * adapter that can (the Studio one) calls `open` once, then `pages` for each
   * batch that follows, and resolves with the whole document only after the
   * last batch; one that cannot ignores this and resolves as usual.
   */
  progress?: SiteLoadProgress
}

/** One page a streamed load has announced but not delivered yet. */
export interface PendingPage {
  id: string
  title: string
}

export interface SiteLoadProgress {
  /**
   * The document with every page that has arrived so far, and the pages still
   * to come, in the order they will be added to `site.pages`. Called once,
   * before any `pages` call; never called when the load fails first.
   */
  open(site: SiteDocument, pending: readonly PendingPage[]): void
  /** More pages, to be appended to `site.pages`. */
  pages(pages: readonly Page[]): void
}
