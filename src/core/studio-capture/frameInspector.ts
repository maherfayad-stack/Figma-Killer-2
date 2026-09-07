/**
 * The ONE implementation of "read a settled Studio frame document" — the
 * browser half of `frameInspectWire.ts`.
 *
 * Two consumers run this exact code against two different documents:
 *
 *   - the **headless capture page** (`src/admin/agentCapture/`), on the iframe
 *     of a frame it just settled, reached through
 *     `window[AGENT_CAPTURE_INSPECT_GLOBAL]`;
 *   - the **live editor canvas** (`src/admin/pages/site/agent/`), on the iframe
 *     of a board frame in the user's own tab, as the fallback path for the same
 *     two tools.
 *
 * One implementation rather than two, because the whole point of these tools is
 * that the number they report is TRUE: a headless answer and a live-tab answer
 * that disagreed about what "the font size" means would make the fidelity loop
 * unfalsifiable. The only thing the two call sites own is finding the document.
 *
 * Everything here reads. Nothing mutates the document, and nothing touches the
 * user's source — a measurement that changed what it measured would be worse
 * than no measurement.
 *
 * ## Where the coordinates come from
 *
 * `x`/`y` are frame-local CSS px measured against the frame document's own
 * `documentElement` rect — deliberately the same origin `captureWire.ts`'s
 * `nodeRects` uses, so a rect from a screenshot and a rect from a measurement
 * are directly comparable without a transform.
 */
import { safeParseValue } from '@core/utils/typeboxHelpers'
import {
  AgentFrameInspectRequestSchema,
  INSPECT_COMPUTED_STYLES_DEFAULT_LIMIT,
  INSPECT_MEASURE_DEFAULT_LIMIT,
  type AgentComputedStyleRow,
  type AgentComputedStylesResult,
  type AgentFrameInspectRequest,
  type AgentFrameInspectResponse,
  type AgentMeasureResult,
  type AgentMeasuredElement,
} from './frameInspectWire'

/** How much of a node's own text is worth carrying back before it stops being an identifier. */
const MAX_TEXT_CHARS = 60

interface EdgeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The first family in `font-family` that the document can actually render with.
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

/** A length that may legitimately be `normal`/`auto` — reported as `null` rather than as a fake 0. */
function parseOptionalPx(value: string): number | null {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Text belonging to this node itself, not to its descendants — a container's concatenated subtree text is noise. */
function ownText(el: Element): string {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) out += child.textContent ?? ''
  }
  return out.replace(/\s+/g, ' ').trim()
}

function truncateText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 3)}…` : text
}

function insets(cs: CSSStyleDeclaration, prefix: 'padding' | 'margin'): EdgeInsets {
  return {
    top: parsePx(cs.getPropertyValue(`${prefix}-top`)),
    right: parsePx(cs.getPropertyValue(`${prefix}-right`)),
    bottom: parsePx(cs.getPropertyValue(`${prefix}-bottom`)),
    left: parsePx(cs.getPropertyValue(`${prefix}-left`)),
  }
}

function borderInsets(cs: CSSStyleDeclaration): EdgeInsets {
  return {
    top: parsePx(cs.getPropertyValue('border-top-width')),
    right: parsePx(cs.getPropertyValue('border-right-width')),
    bottom: parsePx(cs.getPropertyValue('border-bottom-width')),
    left: parsePx(cs.getPropertyValue('border-left-width')),
  }
}

// ---------------------------------------------------------------------------
// computedStyles
// ---------------------------------------------------------------------------

function readComputedStyles(
  doc: Document,
  view: Window,
  request: Extract<AgentFrameInspectRequest, { kind: 'computedStyles' }>,
): AgentComputedStylesResult {
  const textOnly = request.textOnly ?? true
  const limit = request.limit ?? INSPECT_COMPUTED_STYLES_DEFAULT_LIMIT
  const wanted = request.nodeIds ? new Set(request.nodeIds) : null

  const rows: AgentComputedStyleRow[] = []
  let skippedNoText = 0
  for (const el of doc.querySelectorAll<HTMLElement>('[data-node-id]')) {
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
    const row: AgentComputedStyleRow = {
      nodeId,
      tag: el.tagName.toLowerCase(),
      fontFamily: resolvedFontFamily(doc, cs.fontFamily, fontSizePx),
      fontSizePx,
      lineHeightPx: cs.lineHeight === 'normal' ? null : parsePx(cs.lineHeight),
      fontWeight: cs.fontWeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      rect: { width: round2(rect.width), height: round2(rect.height) },
    }
    if (text) row.text = truncateText(text)
    if (!textOnly || !text) {
      if (cs.borderRadius !== '0px') row.borderRadius = cs.borderRadius
      if (cs.padding !== '0px') row.padding = cs.padding
    }
    rows.push(row)
    if (rows.length >= limit) break
  }

  const result: AgentComputedStylesResult = {
    kind: 'computedStyles',
    pageId: request.pageId,
    nodeCount: rows.length,
    truncated: rows.length >= limit,
    fontFamiliesInUse: [...new Set(rows.map((r) => r.fontFamily))].sort(),
    nodes: rows,
  }
  if (textOnly && !wanted) result.skippedWithoutOwnText = skippedNoText
  return result
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

/**
 * Which axis a parent lays its children out along.
 *
 * Read off the parent's own computed `display`/`flex-direction` rather than
 * inferred from where the boxes landed: a single-child row and a single-child
 * column are indistinguishable by geometry, and reporting the wrong axis makes
 * `gapAfterPx` measure the wrong edge silently.
 */
function siblingAxisOf(cs: CSSStyleDeclaration | null): 'inline' | 'block' {
  if (!cs) return 'block'
  const display = cs.display
  const isFlex = display === 'flex' || display === 'inline-flex'
  if (isFlex && cs.flexDirection.startsWith('row')) return 'inline'
  return 'block'
}

/** The rendered element children of `parent`, in DOM order, skipping boxes with no size at all. */
function renderedChildren(parent: Element): Element[] {
  const out: Element[] = []
  for (const child of parent.children) {
    const rect = child.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    out.push(child)
  }
  return out
}

function measureElements(
  doc: Document,
  view: Window,
  request: Extract<AgentFrameInspectRequest, { kind: 'measure' }>,
): AgentMeasureResult | { error: string } {
  const root = doc.documentElement
  const rootRect = root.getBoundingClientRect()
  const limit = request.limit ?? INSPECT_MEASURE_DEFAULT_LIMIT

  // Resolution order is "everything the caller named", deduped, in document
  // order — so a nodeIds + selector call reads like one list rather than two
  // concatenated ones.
  const matches = new Set<HTMLElement>()
  const unmatched: string[] = []
  for (const nodeId of request.nodeIds ?? []) {
    const el = doc.querySelector<HTMLElement>(`[data-node-id="${cssEscapeAttr(nodeId)}"]`)
    if (el) matches.add(el)
    else unmatched.push(nodeId)
  }
  if (request.selector) {
    let found: NodeListOf<HTMLElement>
    try {
      found = doc.querySelectorAll<HTMLElement>(request.selector)
    } catch {
      return { error: `"${request.selector}" is not a valid CSS selector.` }
    }
    for (const el of found) matches.add(el)
  }
  // Neither filter given: measure every authored node, which is the "what does
  // this screen actually lay out like" question.
  if (!request.nodeIds && !request.selector) {
    for (const el of doc.querySelectorAll<HTMLElement>('[data-node-id]')) matches.add(el)
  }

  const ordered = [...doc.querySelectorAll<HTMLElement>('*')].filter((el) => matches.has(el))
  const elements: AgentMeasuredElement[] = []
  for (const el of ordered) {
    if (elements.length >= limit) break
    elements.push(measureOne(el, view, rootRect))
  }

  return {
    kind: 'measure',
    pageId: request.pageId,
    frame: {
      width: Math.round(rootRect.width),
      height: Math.round(Math.max(rootRect.height, root.scrollHeight)),
    },
    matched: ordered.length,
    truncated: ordered.length > elements.length,
    unmatched,
    elements,
  }
}

function measureOne(el: HTMLElement, view: Window, rootRect: DOMRect): AgentMeasuredElement {
  const cs = view.getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const parent = el.parentElement
  const parentCs = parent ? view.getComputedStyle(parent) : null
  const axis = siblingAxisOf(parentCs)

  const measured: AgentMeasuredElement = {
    nodeId: el.dataset.nodeId ?? '',
    tag: el.tagName.toLowerCase(),
    x: round2(rect.left - rootRect.left),
    y: round2(rect.top - rootRect.top),
    width: round2(rect.width),
    height: round2(rect.height),
    paddingPx: insets(cs, 'padding'),
    marginPx: insets(cs, 'margin'),
    borderPx: borderInsets(cs),
    siblingAxis: axis,
  }
  const text = ownText(el)
  if (text) measured.text = truncateText(text)

  if (parent && parentCs) {
    const siblings = renderedChildren(parent)
    const index = siblings.indexOf(el)
    if (index > 0) {
      const before = siblings[index - 1]!.getBoundingClientRect()
      measured.gapBeforePx = round2(
        axis === 'inline' ? rect.left - before.right : rect.top - before.bottom,
      )
    }
    if (index >= 0 && index < siblings.length - 1) {
      const after = siblings[index + 1]!.getBoundingClientRect()
      measured.gapAfterPx = round2(
        axis === 'inline' ? after.left - rect.right : after.top - rect.bottom,
      )
    }
    const parentRect = parent.getBoundingClientRect()
    const parentNodeId = parent.dataset.nodeId
    measured.parent = {
      ...(parentNodeId ? { nodeId: parentNodeId } : {}),
      tag: parent.tagName.toLowerCase(),
      display: parentCs.display,
      ...(parentCs.flexDirection ? { flexDirection: parentCs.flexDirection } : {}),
      rowGapPx: parseOptionalPx(parentCs.rowGap),
      columnGapPx: parseOptionalPx(parentCs.columnGap),
      paddingPx: insets(parentCs, 'padding'),
      rect: {
        x: round2(parentRect.left - rootRect.left),
        y: round2(parentRect.top - rootRect.top),
        width: round2(parentRect.width),
        height: round2(parentRect.height),
      },
    }
  }

  return measured
}

/** Escapes a node id for use inside a CSS attribute selector's double-quoted value. */
function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Answer one inspect request against a settled frame document.
 *
 * `view` is the frame's OWN `defaultView`, never the host window: `doc.fonts`
 * and `getComputedStyle` both have to resolve against the stylesheets and font
 * set the frame loaded, and the admin document knows nothing about the fonts
 * the user's project loaded.
 */
export function inspectFrameDocument(
  doc: Document,
  view: Window,
  request: AgentFrameInspectRequest,
): AgentFrameInspectResponse {
  if (request.kind === 'computedStyles') {
    return { ok: true, result: readComputedStyles(doc, view, request) }
  }
  const measured = measureElements(doc, view, request)
  if ('error' in measured) return { ok: false, error: measured.error }
  return { ok: true, result: measured }
}

/**
 * The string-in/string-out form the headless driver calls through
 * `window[AGENT_CAPTURE_INSPECT_GLOBAL]`. Validates the incoming request (it
 * arrives as text from outside the page's own code) and never throws — a thrown
 * exception inside `page.evaluate` reaches the driver as an opaque protocol
 * error, where a returned `{ ok: false }` reaches it as a readable sentence.
 */
export function inspectFrameDocumentJson(
  resolveDocument: (pageId: string) => { doc: Document; view: Window } | null,
  requestJson: string,
): string {
  const respond = (response: AgentFrameInspectResponse): string => JSON.stringify(response)
  let raw: unknown
  try {
    raw = JSON.parse(requestJson)
  } catch (err) {
    return respond({ ok: false, error: `The inspect request was not valid JSON: ${String(err)}` })
  }
  const parsed = safeParseValue(AgentFrameInspectRequestSchema, raw)
  if (!parsed.ok) {
    const detail = parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
    return respond({ ok: false, error: `The inspect request failed validation: ${detail}` })
  }

  const target = resolveDocument(parsed.value.pageId)
  if (!target) {
    return respond({
      ok: false,
      error: `No settled frame document for page "${parsed.value.pageId}" — it never mounted, or it failed to settle.`,
    })
  }
  try {
    return respond(inspectFrameDocument(target.doc, target.view, parsed.value))
  } catch (err) {
    return respond({ ok: false, error: `Reading the frame document failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}
