/**
 * Stale heavy-evidence elision for the HTTP tool loop — a per-request
 * PROJECTION of the history, never an edit of it (see `toolLoop.ts`'s
 * "The history is append-only"). Split out of `toolLoop.ts` at the 700-line
 * ceiling.
 */
import type { ProviderAdapter, TurnToolResult } from './toolLoopTypes'

/**
 * Tools whose results carry heavy, snapshot-in-time payloads (a full page's
 * HTML/CSS, a node subtree, a screenshot). Older copies describe page state the
 * model has since mutated — useless to re-send. Any result with an image
 * attachment is heavy regardless of tool name.
 */
const HEAVY_TOOL_NAMES = new Set(['site_render_snapshot', 'site_read_document', 'site_get_node_html'])

export function isHeavyResult(r: TurnToolResult): boolean {
  return (r.output.images?.length ?? 0) > 0 || HEAVY_TOOL_NAMES.has(r.name)
}

/**
 * What a call's result is about, from its input: the pages it named
 * (`pages`, sorted — the same set in another order is the same capture), else
 * one `pageId`/`page`/`path`/`nodeId`. `''` when the call names nothing, which
 * keeps the old per-tool behaviour for it.
 */
export function heavyResultScope(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const params = input as Record<string, unknown>
  if (Array.isArray(params.pages)) {
    return params.pages.filter((page): page is string => typeof page === 'string').sort().join(',')
  }
  for (const key of ['pageId', 'page', 'path', 'nodeId']) {
    const value = params[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/** Results supersede each other per (tool, scope) — see `TurnToolResult.scope`. */
function supersessionKey(r: TurnToolResult): string {
  return `${r.name}|${r.scope ?? ''}`
}

/** Replace a heavy payload with a one-line breadcrumb pointing back at the tool. */
function stubHeavyResult(r: TurnToolResult): TurnToolResult {
  return {
    ...r,
    output: {
      ok: r.output.ok,
      data: {
        elided: true,
        note: `Earlier ${r.name} output removed to conserve context. Call ${r.name} again if you need the current state.`,
      },
    },
  }
}

/**
 * The message array for ONE request: the canonical history with every
 * superseded heavy tool result swapped for its breadcrumb. Per heavy tool name
 * AND scope (the page or file it is about — AI-18) only the most recent
 * message keeps full fidelity; non-heavy results in the
 * same message are left untouched (a turn can mix a heavy `site_read_document`
 * with a cheap `site_update_node_props`). Messages are rebuilt through the
 * adapter, so this stays provider-agnostic.
 *
 * This is a projection, NOT an edit. `history` is returned untouched — it is
 * the array the next round appends to, and rewriting an entry of it (which is
 * what this used to do) invalidated the prompt cache from that position onward
 * on every single capture.
 */
export function projectHeavyElision<TMessage>(
  history: readonly TMessage[],
  heavyMessages: readonly { index: number; results: TurnToolResult[]; notes?: readonly string[] }[],
  adapter: Pick<ProviderAdapter<TMessage>, 'buildToolResultMessage'>,
): TMessage[] {
  const projected = history.slice()
  if (heavyMessages.length === 0) return projected

  const lastIndexByKey = new Map<string, number>()
  for (const m of heavyMessages) {
    for (const r of m.results) {
      if (isHeavyResult(r) && m.index > (lastIndexByKey.get(supersessionKey(r)) ?? -1)) {
        lastIndexByKey.set(supersessionKey(r), m.index)
      }
    }
  }
  for (const m of heavyMessages) {
    const superseded = (r: TurnToolResult): boolean =>
      isHeavyResult(r) && lastIndexByKey.get(supersessionKey(r)) !== m.index
    if (!m.results.some(superseded)) continue
    projected[m.index] = adapter.buildToolResultMessage(
      m.results.map((r) => (superseded(r) ? stubHeavyResult(r) : r)),
      m.notes ?? [],
    )
  }
  return projected
}

