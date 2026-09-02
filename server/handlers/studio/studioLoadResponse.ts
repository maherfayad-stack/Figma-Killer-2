/**
 * studioLoadResponse — response shaping for `GET /admin/api/studio/load`
 * (see `server/handlers/studio.ts`'s module doc for the route contract):
 * the `pageIds` filter, and the WS-5.5 `?stream=1` NDJSON line generator.
 * Split out of `studio.ts` (routing-only) because both pieces are genuinely
 * "how does this route shape its response", not request wiring, and the
 * addition pushed `studio.ts` past the 700-line module-size ceiling.
 *
 * ## The `pageIds` filter
 *
 * Lets a caller — specifically the canvas's targeted live-reload after a
 * server-side agent write (`studio_apply_edits`/`studio_codemod`/
 * `studio_create_page`/`studio_set_frames`) — ask for only the pages it
 * actually needs re-parsed, instead of re-streaming (and re-patching into the
 * store) every page in the project for a one-page edit.
 *
 * **Deliberately NOT a second parse path.** `loadStudioPages(dir)` still runs
 * in full, unfiltered, exactly as it does for a normal load — this module
 * only decides which of its already-computed `pages` get sent back. Two
 * reasons that's the right split, not a missed optimization:
 *
 * 1. **Meta correctness.** `componentSources`, `styleRules`,
 *    `styleRuleSources`, `conditions`, `vendorCss`, and `authoredCss` are
 *    genuinely PROJECT-WIDE, not per-page — `loadStudioStyles` builds the style
 *    registry from every page's imported stylesheets together (shared CSS
 *    files, cascade order), and `componentSources` is merged across every
 *    route. The very edit that triggered a targeted reload can change any of
 *    them without touching the page the client asked for: a new `import` on
 *    the edited page adds a `componentSource` for a component every OTHER
 *    page might also use; an edited page whose `className` maps to a
 *    previously-unseen selector changes `styleRules` for the whole registry a
 *    sibling page reads from too. There is no way to answer "what changed"
 *    without recomputing the whole registry — a filtered load that skipped
 *    this and returned stale `styleRules` would render the edited page
 *    WRONG, which is worse than the full reload this feature replaces. So the
 *    meta line is ALWAYS a full, fresh recompute, filtered or not.
 * 2. **The cache already pays for it — now genuinely, on both halves of the
 *    pipeline.** `pageParseCache.ts` (WS-5.5) keys on each route's own file
 *    plus its resolved local-component dependencies' mtimes — completely
 *    independent of whether THIS call filters its output. By the time a
 *    targeted reload fires, the board's own initial load already warmed the
 *    cache for every untouched page; only the file an agent tool just wrote
 *    has a stale mtime and pays a real re-parse. This claim used to be only
 *    HALF true: `loadStudioStyles` -> `collectEntryStylesheets` (the entry
 *    `index.html`/`main` import-graph BFS that finds the app's GLOBAL
 *    stylesheets) had no cache of its own and ran its full ts-morph
 *    semantic-resolution walk on every single `loadStudioPages` call
 *    regardless of `pageParseCache` hits — 500-850ms of synchronous compute
 *    paid again on every targeted reload no matter how narrow. Fixed by
 *    `@core/studio-sync`'s `entryStylesheetCache` (mtime + missing-candidate
 *    keyed, invalidated on any dependency it walked moving) — see that
 *    module's doc for the exact contract. With both caches warm, running the
 *    unfiltered pipeline and filtering the OUTPUT costs the same
 *    server-side compute as a genuinely page-scoped parse would, for the
 *    common case this feature exists for. What filtering actually saves is
 *    the part that scales with project size regardless of caching: the
 *    NDJSON transfer size, the client's JSON-parse work, and the store patch
 *    for every UNCHANGED page — the real "wrong cost" on a large project.
 *
 * **Unknown/stale ids never fail the request.** A page id the client holds
 * may have been deleted or renamed by the very edit that triggered the
 * reload (or simply never existed). `filterStudioLoadPages` reports those as
 * `missingPageIds` instead of erroring, so the caller can drop the
 * corresponding frame(s) from its store rather than keep a ghost page. A
 * BRAND-NEW page (`studio_create_page`) needs no special case here at all:
 * `loadStudioPages` re-walks the pages directory on every call, so a page
 * the client has never seen shows up in its unfiltered `pages` just like any
 * other, and gets selected the same way an edited one does.
 */
import type { Page } from '@core/page-tree'
import { safeParseValue, Type } from '@core/utils/typeboxHelpers'
import type { StudioLoadResult } from '../studioPageLoad'

/** At least one non-empty id — an empty/whitespace-only `pageIds` param is a caller error (400), not "no filter". */
const StudioLoadPageIdsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })

/**
 * Parses `?pageIds=<comma-separated ids>`. Comma-separated (not repeated
 * `pageIds=a&pageIds=b` params) because `@core/http`'s `apiRequest`/
 * `ndjsonRequest` `query` option is `Record<string, string | number |
 * boolean>` — one value per key — so a client building this call joins its
 * id list into a single string; this parser is the matching split.
 *
 * Three-way result, not a boolean: `undefined` means "no `pageIds` param at
 * all" (every existing caller — full, unfiltered load, preserved exactly).
 * `null` means the param was present but invalid (empty, or only
 * whitespace/empty segments) — the route returns 400 for that, same as any
 * other malformed input. Otherwise a deduplicated, trimmed array of the
 * requested ids, in the order first seen.
 */
export function parseStudioLoadPageIdsParam(raw: string | null): string[] | undefined | null {
  if (raw === null) return undefined
  const candidates = [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0))]
  const result = safeParseValue(StudioLoadPageIdsSchema, candidates)
  return result.ok ? result.value : null
}

export interface FilteredStudioLoadPages {
  pages: Page[]
  /** `undefined` when no filter was requested — see this module's doc for why that keeps an unfiltered response byte-identical (`JSON.stringify` drops `undefined`-valued keys). */
  missingPageIds: string[] | undefined
}

/**
 * Selects the requested subset of an already-fully-computed `pages` array.
 * `pageIds === undefined` (no filter) returns every page, unchanged — the
 * existing, unfiltered contract. Otherwise returns only the pages whose id
 * matched, plus every requested id that matched nothing.
 */
export function filterStudioLoadPages(
  pages: readonly Page[],
  pageIds: readonly string[] | undefined,
): FilteredStudioLoadPages {
  if (!pageIds) return { pages: [...pages], missingPageIds: undefined }
  const requested = new Set(pageIds)
  const filtered = pages.filter((page) => requested.has(page.id))
  const found = new Set(filtered.map((page) => page.id))
  const missingPageIds = pageIds.filter((id) => !found.has(id))
  return { pages: filtered, missingPageIds }
}

/**
 * WS-5.5 — the `?stream=1` NDJSON body for `GET /admin/api/studio/load`:
 * one `{ kind: 'meta', ... }` line (everything except `pages`), then one
 * `{ kind: 'page', page }` line per page, in the same order `pages` was in.
 * `@core/http`'s `ndjsonRequest` (client) validates each line against a
 * matching discriminated-union TypeBox schema — see `fsCodemodAdapter.ts`'s
 * `StudioLoadStreamLineSchema`, which MUST stay in sync with this shape.
 * `missingPageIds` rides in `meta` (`undefined`, hence dropped by
 * `JSON.stringify`, on every unfiltered call — see this module's own doc).
 */
export async function* studioLoadStreamLines(
  result: StudioLoadResult & {
    dir: string
    projectName: string
    trust: unknown
    paletteHiddenModuleIds: string[]
    missingPageIds: string[] | undefined
  },
): AsyncGenerator<Record<string, unknown>> {
  const { pages, ...meta } = result
  yield { kind: 'meta', ...meta, pageCount: pages.length }
  for (const page of pages) {
    // Yield control back to the event loop between pages so Bun actually
    // flushes each chunk to the socket instead of enqueueing every line
    // inside one synchronous burst (server-side compute for ALL pages is
    // already done by the time this generator starts — see the route's own
    // comment for exactly what this streaming does and does not buy).
    await new Promise((resolve) => setImmediate(resolve))
    yield { kind: 'page', page }
  }
}
