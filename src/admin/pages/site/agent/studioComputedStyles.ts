/**
 * `studio_computed_styles` — the browser half.
 *
 * Reads the RESOLVED computed style of the nodes in a live board frame, so the
 * agent can compare what its stylesheet produced against what the design
 * specifies, by number, instead of inferring it from a screenshot.
 *
 * ## Why this exists
 *
 * Before it, the agent had two of the three things a fidelity loop needs: the
 * design's intended values (a Figma connector's variable definitions give exact
 * tokens — "Body/Semibold/EN: Open Sans SemiBold 14px") and a picture of its own
 * output. It had no way to read what its own CSS actually computed to. So every
 * "the type is still wrong" round was answered by editing a font-size that was
 * already correct, because the real causes were invisible from a picture: a
 * component's size variant resolving to a different token than its name
 * suggested, and a font-family naming a font the project never loaded — which
 * makes correct px look like the wrong size and is unfixable by tuning px.
 *
 * `fontFamily` and `fontWeight` are therefore reported alongside the sizes, and
 * `fontFamily` carries the FIRST ACTUALLY-USED family rather than the whole
 * stack: a declared `"Open Sans", system-ui, sans-serif` tells you nothing about
 * whether Open Sans loaded, and that distinction was the entire bug.
 *
 * ## Why per-node and not per-component
 *
 * A component-variant catalogue would need to know what `size="default"` means
 * for every component in every design system. Reading the rendered node needs to
 * know nothing: buttons, inputs, labels and containers all report the same way,
 * which is what makes this cover "all components" rather than the one that was
 * complained about.
 */
import { parseValue } from '@core/utils/typeboxHelpers'
import { StudioComputedStylesInputSchema, aiToolError, aiToolOk } from '@core/ai'
import type { AiToolOutput } from '@core/ai'
import { findAgentRenderFrame } from './renderEvidence'

const DEFAULT_LIMIT = 80
const STUDIO_BREAKPOINT_ID = 'studio'

interface ComputedStyleRow {
  nodeId: string
  tag: string
  text?: string
  fontFamily: string
  fontSizePx: number
  lineHeightPx: number | null
  fontWeight: string
  color: string
  backgroundColor: string
  borderRadius?: string
  padding?: string
  rect: { width: number; height: number }
}

/**
 * The first family in `font-family` that the browser can actually use.
 *
 * `getComputedStyle().fontFamily` echoes the declared STACK, not the resolved
 * face, so a stack whose first entry never loaded looks identical to one that
 * did. `document.fonts.check` answers the question the stack cannot: it is true
 * only when a face for that family is available to render with. Walking the
 * stack in order and returning the first available entry therefore reports the
 * family the text is actually set in.
 *
 * Returns the raw stack unchanged when nothing in it is available (an exotic
 * generic, or a document with no font access) rather than guessing — a wrong
 * confident answer here would send the reader chasing the wrong cause.
 */
function resolvedFontFamily(doc: Document, declared: string, sizePx: number): string {
  const stack = declared.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  const fonts = doc.fonts
  if (!fonts || typeof fonts.check !== 'function') return declared
  for (const family of stack) {
    try {
      // `check` needs a full font shorthand; the size is irrelevant to
      // availability but the shorthand is invalid without one.
      if (fonts.check(`${sizePx}px "${family}"`)) return family
    } catch {
      // A generic keyword (`sans-serif`) can throw when quoted — it is also
      // always available, so treat it as the resolved end of the stack.
      return family
    }
  }
  return declared
}

function parsePx(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Text belonging to this node itself, not to its descendants — a container's concatenated subtree text is noise. */
function ownText(el: Element): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? ''
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function runStudioComputedStyles(rawInput: unknown): AiToolOutput {
  const input = parseValue(StudioComputedStylesInputSchema, rawInput)
  const textOnly = input.textOnly ?? true
  const limit = input.limit ?? DEFAULT_LIMIT

  const frame = findAgentRenderFrame({ breakpointId: STUDIO_BREAKPOINT_ID, pageId: input.pageId })
  if (!frame) {
    return aiToolError(
      `No live frame for page "${input.pageId}". Computed styles are read off the rendered canvas, so the project must be open in a Studio tab and the page must have a board frame (studio_screenshot places one).`,
    )
  }

  const doc = frame.ownerDocument
  const view = doc.defaultView
  if (!view) return aiToolError('The board frame has no window to read styles from.')

  const wanted = input.nodeIds ? new Set(input.nodeIds) : null
  const elements = Array.from(frame.querySelectorAll<HTMLElement>('[data-node-id]'))

  const rows: ComputedStyleRow[] = []
  let skippedNoText = 0
  for (const el of elements) {
    const nodeId = el.dataset.nodeId ?? ''
    if (wanted && !wanted.has(nodeId)) continue

    const text = ownText(el)
    // An explicit nodeIds request is honoured verbatim — the caller asked about
    // that node, so silently dropping it for having no text would look like the
    // node does not exist.
    if (!wanted && textOnly && !text) {
      skippedNoText += 1
      continue
    }

    const cs = view.getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const fontSizePx = parsePx(cs.fontSize)
    const row: ComputedStyleRow = {
      nodeId,
      tag: el.tagName.toLowerCase(),
      fontFamily: resolvedFontFamily(doc, cs.fontFamily, fontSizePx),
      fontSizePx,
      lineHeightPx: cs.lineHeight === 'normal' ? null : parsePx(cs.lineHeight),
      fontWeight: cs.fontWeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      rect: { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
    }
    if (text) row.text = text.length > 60 ? `${text.slice(0, 57)}…` : text
    if (!textOnly || !text) {
      if (cs.borderRadius !== '0px') row.borderRadius = cs.borderRadius
      if (cs.padding !== '0px') row.padding = cs.padding
    }
    rows.push(row)
    if (rows.length >= limit) break
  }

  const declaredStacks = new Set(
    rows.map((r) => r.fontFamily),
  )

  return aiToolOk({
    pageId: input.pageId,
    nodeCount: rows.length,
    truncated: rows.length >= limit,
    skippedWithoutOwnText: textOnly && !wanted ? skippedNoText : undefined,
    /** Every family actually in use — a single unexpected entry here is a font that failed to load. */
    fontFamiliesInUse: [...declaredStacks].sort(),
    nodes: rows,
  })
}
