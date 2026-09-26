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
 * **The filter reaches the COMPUTE, not just the response.** The parsed ids
 * are handed to `loadStudioPages(dir, { pageIds })`, which skips the
 * per-page convert (`parsedPageToSitePage` + the asset-sentinel rewrite) for
 * every route the caller did not ask for — see that function's own
 * `options.pageIds` doc for exactly which stages narrow and which stay
 * project-wide. This module is then left owning the two things that are
 * genuinely about the RESPONSE: naming the ids that matched nothing, and the
 * `?stream=1` line shape.
 *
 * **The meta line stays a full, fresh recompute — filtered or not.**
 * `componentSources`, `styleRules`, `styleRuleSources`, `conditions`,
 * `vendorCss`, and `authoredCss` are genuinely PROJECT-WIDE, not per-page:
 * `loadStudioStyles` builds the style registry from every page's imported
 * stylesheets together (shared CSS files, cascade order), and
 * `componentSources` is merged across every route. The very edit that
 * triggered a targeted reload can change any of them without touching the
 * page the client asked for: a new `import` on the edited page adds a
 * `componentSource` for a component every OTHER page might also use; an
 * edited page whose `className` maps to a previously-unseen selector changes
 * `styleRules` for the whole registry a sibling page reads from too. There is
 * no way to answer "what changed" without recomputing the whole registry — a
 * filtered load that returned stale `styleRules` renders the edited page
 * WRONG, which is `canvas-14`'s bug and is worse than the full reload this
 * feature replaces.
 *
 * The parse behind that registry is not re-paid per reload: `pageParseCache.ts`
 * (WS-5.5) keys each route on its own file plus its resolved local-component
 * dependencies' mtimes, and `@core/studio-sync`'s `entryStylesheetCache`
 * covers the entry-stylesheet BFS that used to run its full ts-morph
 * semantic-resolution walk on every single call. With both warm — which a
 * targeted reload always has, by construction, since the board loaded the
 * project before it could edit it — only the file the write actually touched
 * pays a real re-parse.
 *
 * **Unknown/stale ids never fail the request.** A page id the client holds
 * may have been deleted or renamed by the very edit that triggered the
 * reload (or simply never existed). `missingStudioLoadPageIds` reports those
 * as `missingPageIds` instead of erroring, so the caller can drop the
 * corresponding frame(s) from its store rather than keep a ghost page. A
 * BRAND-NEW page (`studio_create_page`) needs no special case here at all:
 * `loadStudioPages` re-walks the pages directory on every call, so a page
 * the client has never seen is converted and returned like any other as soon
 * as the caller names its id.
 */
import type { Page } from '@core/page-tree'
import { isCanvasLayerPageId } from '@core/studio-board'
import { safeParseValue, Type } from '@core/utils/typeboxHelpers'
import { viewportPriorityOrder } from './loadPriority'
import type { StudioLoadResult } from './studioLoadContract'

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

/**
 * Every requested id that the narrowed load produced no page for — a page
 * deleted or renamed by the very edit that triggered this reload, or one that
 * never existed. `undefined` when no filter was requested, which is what
 * keeps an unfiltered response byte-identical (`JSON.stringify` drops
 * `undefined`-valued keys).
 *
 * `pages` is already the narrowed set (`loadStudioPages(dir, { pageIds })`),
 * so this only reports; it never filters a second time.
 */
export function missingStudioLoadPageIds(
  pages: readonly Page[],
  pageIds: readonly string[] | undefined,
): string[] | undefined {
  if (!pageIds) return undefined
  const found = new Set(pages.map((page) => page.id))
  // P5-G — a narrowed reload after a canvas-layer write names the layer's
  // `canvas:<id>` page id; a layer is answered by `canvasLayers` (always the
  // full set), never by `pages`, so it is not missing and must never make the
  // client drop a page.
  return pageIds.filter((id) => !found.has(id) && !isCanvasLayerPageId(id))
}

/**
 * WS-5.5 — the `?stream=1` NDJSON body for `GET /admin/api/studio/load`:
 * one `{ kind: 'meta', ... }` line (everything except `pages`), then one
 * `{ kind: 'page', page, index }` line per page.
 * `@core/http`'s `ndjsonRequest` (client) validates each line against a
 * matching discriminated-union TypeBox schema — see
 * `studioLoadStreamSchema.ts`'s `StudioLoadStreamLineSchema`, which MUST stay
 * in sync with this shape. `missingPageIds` rides in `meta` (`undefined`,
 * hence dropped by `JSON.stringify`, on every unfiltered call — see this
 * module's own doc).
 *
 * P6-B — page lines arrive in VIEWPORT order (`loadPriority.ts`: the first
 * board's frames top-left first, then the rest), not page order, and each
 * carries `index`, its position in the project's page order. The client
 * places a page by its `index`, so the line order is the server's to choose —
 * and the server chooses the order a person sees frames in. That is the
 * contract a streaming client needs: the client (`fsCodemodAdapter.ts`) hands
 * the board each batch of lines as it arrives, so the visible frames paint
 * first while the rest are still on the wire, and `meta.pageList` names the
 * ones still to come.
 *
 * What this does NOT do is emit a page before every page is parsed: the
 * compute behind it is whole-project (the style registry's class ids are
 * last-wins across every page's stylesheets, in page order), so the first
 * line of a cold load still waits for the whole parse. See `STATE.md`'s
 * P6-B entry.
 *
 * `StudioLoadResult['stories']` (W5-3) is `Omit`ted deliberately: it is a
 * byproduct the `/load` ROUTE consumes to place board frames, not part of the
 * wire envelope. Every accepted story is already in `pages` like any other
 * page, and this generator spreads whatever it is handed into the `meta` line
 * — so leaving it in the type would quietly widen a contract the client
 * mirrors by hand (`fsCodemodAdapter.ts`'s `StudioLoadStreamLineSchema`).
 */
export async function* studioLoadStreamLines(
  result: Omit<StudioLoadResult, 'stories'> & {
    dir: string
    projectName: string
    trust: unknown
    /** L8 Phase A (`perf-06`, STATE.md) — the `/p/<projectKey>` live-origin routing key, `null` below Tier 2. See `studioLoadStreamSchema.ts`'s matching field doc. */
    projectKey: string | null
    paletteHiddenModuleIds: string[]
    missingPageIds: string[] | undefined
  },
): AsyncGenerator<Record<string, unknown>> {
  const { pages, ...meta } = result
  // P6-B — every page the stream will carry, in page order, BEFORE any of
  // them: what lets the client paint the frames that have arrived and hold a
  // placeholder for the rest, and put the pages back in page order at the end.
  const pageList = pages.map(({ id, slug, title }) => ({ id, slug, title }))
  yield { kind: 'meta', ...meta, pageList }
  const indexById = new Map(pages.map((page, index) => [page.id, index]))
  for (const pageId of viewportPriorityOrder(result.dir, pages.map((page) => page.id))) {
    const index = indexById.get(pageId)!
    // Yield control back to the event loop between pages so Bun actually
    // flushes each chunk to the socket instead of enqueueing every line
    // inside one synchronous burst (server-side compute for ALL pages is
    // already done by the time this generator starts — see the route's own
    // comment for exactly what this streaming does and does not buy).
    await new Promise((resolve) => setImmediate(resolve))
    yield { kind: 'page', page: pages[index]!, index }
  }
}
