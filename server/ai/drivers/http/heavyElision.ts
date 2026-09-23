/**
 * Stale heavy-evidence elision for the HTTP tool loop — a per-request
 * PROJECTION of the history, never an edit of it (see `toolLoop.ts`'s
 * "The history is append-only"). Split out of `toolLoop.ts` at the 700-line
 * ceiling.
 */
import type { ProviderAdapter, TurnToolResult } from './toolLoop'

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
 * only the most recent message keeps full fidelity; non-heavy results in the
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

  const lastIndexByTool = new Map<string, number>()
  for (const m of heavyMessages) {
    for (const r of m.results) {
      if (isHeavyResult(r) && m.index > (lastIndexByTool.get(r.name) ?? -1)) {
        lastIndexByTool.set(r.name, m.index)
      }
    }
  }
  for (const m of heavyMessages) {
    const superseded = (r: TurnToolResult): boolean =>
      isHeavyResult(r) && lastIndexByTool.get(r.name) !== m.index
    if (!m.results.some(superseded)) continue
    projected[m.index] = adapter.buildToolResultMessage(
      m.results.map((r) => (superseded(r) ? stubHeavyResult(r) : r)),
      m.notes ?? [],
    )
  }
  return projected
}

