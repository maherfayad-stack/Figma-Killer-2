/**
 * vectorEditParts — the DOM half of vector edit mode (P5-D): find the host
 * `<svg>` in its frame, read every editable `<path>` part, and measure the one
 * affine per part that maps its user space onto the board.
 *
 * Measured ONCE per session start (and again when the host's markup changes,
 * because a re-applied `__html` recreates every inner element — a ref held
 * across a commit is stale, so parts are always re-queried by their stamp).
 * Never per pan, zoom or pointer move: the board layer lives inside
 * `CanvasTransformLayer`, so pan and zoom move it for free.
 *
 * `frame origin + part.getScreenCTM() · p` is the whole conversion: the CTM
 * covers the `viewBox`, `preserveAspectRatio` and every ancestor `transform`
 * inside the iframe, in iframe client pixels, and iframe content is unscaled
 * (the canvas transform scales the `<iframe>` ELEMENT). The frame origin is
 * read against `[data-studio-board-origin]`, the free canvas's board-origin
 * marker, so there is one definition of "where board (0, 0) is on screen".
 */
import {
  SVG_CODE_ATTRIBUTE,
  SVG_PART_ATTRIBUTE,
  SVG_SPREAD_CODE,
  createPathModel,
  decimalsForScale,
  parsePathData,
  parseSvgCodeAttributes,
  type PathModel,
  type Point,
} from '@core/vector'
import { findBoardOrigin } from '../BoardCanvasLayer/canvasLayerGeometry'
import { affineScale, composeAffine, invertAffine, translation, type Affine } from './vectorGeometry'

/** Past this many anchors the canvas is the wrong editor — the refusal says "open it in code". */
export const MAX_EDITABLE_ANCHORS = 5000

export interface VectorPart {
  /** The live in-frame element. Re-queried after every markup change. */
  element: SVGPathElement
  /** Its stamped `line:col`. */
  part: string
  /** The `d` it had when measured — the source text the model preserves. */
  d: string
  model: PathModel
  /** Local user space → board units. */
  toBoard: Affine
  /** Board units → local user space. */
  toLocal: Affine
  /** Decimals a rewritten coordinate gets: a tenth of a CSS pixel at 1×. */
  decimals: number
}

export interface ResolvedVectorHost {
  iframe: HTMLIFrameElement
  host: SVGSVGElement
  parts: VectorPart[]
}

export type VectorHostResolution = { ok: true; value: ResolvedVectorHost } | { ok: false; message: string }

function escapeAttribute(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

/** The frame's iframes that can be read from this document (a live bridge frame cannot). */
function frameIframes(frameId: string | null): HTMLIFrameElement[] {
  const scope = frameId ? document.querySelector(`[data-frame-id="${escapeAttribute(frameId)}"]`) : document
  if (!scope) return []
  return [...scope.querySelectorAll('iframe')]
}

/** The in-frame element of node `hostNodeId`, in the first frame document that renders it. */
export function findVectorHost(frameId: string | null, hostNodeId: string): { iframe: HTMLIFrameElement; host: Element } | null {
  const selector = `[data-node-id="${escapeAttribute(hostNodeId)}"]`
  for (const iframe of frameIframes(frameId)) {
    let doc: Document | null = null
    try {
      doc = iframe.contentDocument
    } catch (_err) {
      doc = null // cross-origin: a live frame's document is not ours to read
    }
    const host = doc?.querySelector(selector)
    if (host) return { iframe, host }
  }
  return null
}

function matrixOf(m: DOMMatrix): Affine {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
}

/** The iframe's content (0, 0) in board units. */
function frameContentOrigin(iframe: HTMLIFrameElement): Point | null {
  const origin = findBoardOrigin()
  if (!origin) return null
  const rect = iframe.getBoundingClientRect()
  return {
    x: (rect.left - origin.left) / origin.zoom + iframe.clientLeft,
    y: (rect.top - origin.top) / origin.zoom + iframe.clientTop,
  }
}

/**
 * Resolve the session: the host, and every `<path>` part whose `d` is a
 * literal Studio can rewrite. Refuses BY NAME when there is nothing honest to
 * edit — the sentence is what the user reads.
 */
export function resolveVectorHost(frameId: string | null, hostNodeId: string): VectorHostResolution {
  const found = findVectorHost(frameId, hostNodeId)
  if (!found) {
    return { ok: false, message: 'Vector editing works on the design canvas. This frame is showing the running app, where Studio cannot reach the graphic.' }
  }
  const { iframe, host } = found
  if (host.localName !== 'svg') {
    return { ok: false, message: 'This graphic is not an inline <svg> in your code, so its points cannot be edited here.' }
  }
  const origin = frameContentOrigin(iframe)
  if (!origin) return { ok: false, message: 'Vector editing needs the board.' }

  const parts: VectorPart[] = []
  let anchors = 0
  let readOnly = 0
  for (const element of host.querySelectorAll<SVGPathElement>(`path[${SVG_PART_ATTRIBUTE}]`)) {
    const code = parseSvgCodeAttributes(element.getAttribute(SVG_CODE_ATTRIBUTE))
    const d = element.getAttribute('d') ?? ''
    if (code.has('d') || code.has(SVG_SPREAD_CODE) || d.trim() === '') {
      readOnly += 1
      continue
    }
    const parsed = parsePathData(d)
    const ctm = element.getScreenCTM()
    if (!parsed.ok || !ctm) {
      readOnly += 1
      continue
    }
    const toBoard = composeAffine(matrixOf(ctm), translation(origin.x, origin.y))
    const toLocal = invertAffine(toBoard)
    if (!toLocal) {
      readOnly += 1
      continue
    }
    const model = createPathModel(parsed.path)
    anchors += model.segments.length
    parts.push({
      element,
      part: element.getAttribute(SVG_PART_ATTRIBUTE)!,
      d,
      model,
      toBoard,
      toLocal,
      decimals: decimalsForScale(1 / Math.max(affineScale(toBoard), 1e-9)),
    })
  }

  if (parts.length === 0) {
    return {
      ok: false,
      message: readOnly > 0
        ? 'The paths in this graphic are drawn from code, so their points cannot be edited on the canvas. Change them in the code.'
        : 'This graphic has no paths to edit.',
    }
  }
  if (anchors > MAX_EDITABLE_ANCHORS) {
    return { ok: false, message: `This graphic has more than ${MAX_EDITABLE_ANCHORS} points — too many to edit on the canvas. Open it in code.` }
  }
  return { ok: true, value: { iframe, host: host as SVGSVGElement, parts } }
}
