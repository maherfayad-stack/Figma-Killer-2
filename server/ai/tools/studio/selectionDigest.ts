/**
 * The selection half of the live digest (AI-9): for each node the user has
 * selected, where it is in the source, the few lines around it, and where it
 * is drawn.
 *
 * ## Why this exists
 *
 * The digest used to report the selection as a node id, a tag and a list of
 * writable props — for ONE node. So "make this bigger" arrived with no file,
 * no line and no sense of which of three identical buttons "this" was; the
 * agent had to decode the id itself (only the HTTP path had
 * `studio_get_node_source`) and a multi-selection reached it as its last
 * member only. Now every selected node carries:
 *
 *   - `source` — `file:line:col`, decoded with the ONE node-id grammar
 *     (`decodeSourceNodeId`). A `.map` row keeps its template's location and
 *     is marked, because a style edit lands on the template and a structural
 *     one on the array (OD-8), never on "row 2";
 *   - `excerpt` — the line and its neighbours, numbered, for the first few
 *     nodes only (the dynamic suffix is paid on every turn, uncached);
 *   - `box` — the browser's measurement, frame-local CSS px, when a canvas
 *     frame it can read draws the node.
 *
 * Bounded: at most {@link MAX_SELECTION_DETAILED} nodes are described, each
 * excerpt line is capped, and a file is read once however many selected nodes
 * it holds. Reads go through the agent containment rule
 * (`resolveAgentFilePath`), so a node id naming a path outside the project —
 * `../x:1:1` — yields no excerpt rather than reading it. Never throws.
 */
import type { Page } from '@core/page-tree'
import { decodeSourceNodeId, INLINE_ID_SEPARATOR, LOOP_ID_SEPARATOR } from '@core/page-tree'
import { readTextFile, resolveAgentFilePath } from '../../../handlers/studio/agentFileAccess'
import type { StudioAgentSnapshot } from './snapshot'

/** Selected nodes described in full. The rest are counted. */
export const MAX_SELECTION_DETAILED = 8
/** Of those, how many carry a source excerpt. */
const MAX_SELECTION_EXCERPTS = 3
/** Lines either side of the node's own line. */
const EXCERPT_CONTEXT_LINES = 1
const EXCERPT_LINE_MAX_CHARS = 140
/** Files larger than this are not read for an excerpt. */
const EXCERPT_FILE_MAX_BYTES = 400_000

export interface SelectedNodeDigest {
  readonly nodeId: string
  /** `null` when the node is not on the active page (a shared component's node, or a stale id). */
  readonly tag: string | null
  readonly moduleId: string | null
  readonly source: { readonly file: string; readonly line: number; readonly col: number; readonly mapRow: boolean } | null
  /** `NN| code` lines around `source.line`; empty when not read. */
  readonly excerpt: readonly string[]
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
  readonly writableProps: readonly string[]
  readonly lockedReason: string | null
}

export interface SelectionDigest {
  readonly nodes: readonly SelectedNodeDigest[]
  /** How many selected nodes were left out of `nodes` by the cap. */
  readonly omitted: number
}

/** The node's source location — a `.map` row reports its template's, marked. */
function sourceOf(nodeId: string): SelectedNodeDigest['source'] {
  const direct = decodeSourceNodeId(nodeId)
  if (direct) return { file: direct.rel, line: direct.line, col: direct.col, mapRow: false }
  const tail = nodeId.split(INLINE_ID_SEPARATOR).pop() ?? nodeId
  const template = tail.includes(LOOP_ID_SEPARATOR) ? decodeSourceNodeId(tail.slice(0, tail.indexOf(LOOP_ID_SEPARATOR))) : null
  return template ? { file: template.rel, line: template.line, col: template.col, mapRow: true } : null
}

function excerptFrom(lines: readonly string[], line: number): string[] {
  const from = Math.max(1, line - EXCERPT_CONTEXT_LINES)
  const to = Math.min(lines.length, line + EXCERPT_CONTEXT_LINES)
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1]!.replace(/\t/g, '  ').trimEnd()
    out.push(`${n}| ${text.length > EXCERPT_LINE_MAX_CHARS ? `${text.slice(0, EXCERPT_LINE_MAX_CHARS)}…` : text}`)
  }
  return out
}

export function buildSelectionDigest(dir: string, activePage: Page | null, selection: StudioAgentSnapshot['selection']): SelectionDigest {
  const detailed = selection.slice(-MAX_SELECTION_DETAILED)
  const fileLines = new Map<string, string[] | null>()
  const linesOf = (rel: string): string[] | null => {
    if (!fileLines.has(rel)) {
      let lines: string[] | null = null
      try {
        const target = resolveAgentFilePath(dir, rel, 'read')
        if (target.ok) {
          const read = readTextFile(target.abs, EXCERPT_FILE_MAX_BYTES)
          if (read.kind === 'text') lines = read.content.split(/\r?\n/)
        }
      } catch (err) {
        console.error('[ai/liveDigest] could not read a selected node\'s source — continuing without its excerpt:', err)
      }
      fileLines.set(rel, lines)
    }
    return fileLines.get(rel) ?? null
  }

  const nodes = detailed.map((entry, index): SelectedNodeDigest => {
    const node = activePage?.nodes[entry.nodeId]
    const codeProps = new Set(node?.codeProps ?? [])
    const source = sourceOf(entry.nodeId)
    const lines = source && index >= detailed.length - MAX_SELECTION_EXCERPTS ? linesOf(source.file) : null
    return {
      nodeId: entry.nodeId,
      tag: typeof node?.props?.tag === 'string' ? node.props.tag : null,
      moduleId: node?.moduleId ?? null,
      source,
      excerpt: source && lines && source.line <= lines.length ? excerptFrom(lines, source.line) : [],
      box: entry.box ?? null,
      writableProps: node?.props ? Object.keys(node.props).filter((key) => !codeProps.has(key)) : [],
      lockedReason: node?.lockReason ?? null,
    }
  })
  return { nodes, omitted: selection.length - detailed.length }
}

/** One node, as the digest line reads it. */
function describeNode(node: SelectedNodeDigest): string {
  const what = node.moduleId ? `<${node.tag ?? node.moduleId}>` : '(not on the active page)'
  const where = node.source
    ? `${node.source.file}:${node.source.line}:${node.source.col}${node.source.mapRow ? ' (one row of a .map: a style edit goes to this template, a structural edit to the array)' : ''}`
    : 'no source location (a synthetic node)'
  const box = node.box ? `box ${node.box.x},${node.box.y} ${node.box.width}x${node.box.height}` : 'box unmeasured (studio_measure_element measures it)'
  const writable = node.moduleId ? `writable: ${node.writableProps.length > 0 ? node.writableProps.join(', ') : '(none)'}` : null
  const locked = node.lockedReason ? `locked: ${node.lockedReason}` : null
  const head = [`${node.nodeId} ${what}`, where, box, writable, locked].filter((part): part is string => part !== null).join('; ')
  return node.excerpt.length > 0 ? `${head}\n    ${node.excerpt.join('\n    ')}` : head
}

/** The `Selected…` line(s) of the dynamic suffix. */
export function describeSelection(digest: SelectionDigest): string {
  if (digest.nodes.length === 0) return 'Selected: none'
  if (digest.nodes.length === 1 && digest.omitted === 0) return `Selected: ${describeNode(digest.nodes[0]!)}`
  const total = digest.nodes.length + digest.omitted
  const lines = digest.nodes.map((node, index) => `  ${index + 1}. ${describeNode(node)}`)
  const more = digest.omitted > 0 ? `\n  (+${digest.omitted} earlier selections not shown)` : ''
  return `Selected (${total} nodes, the last is the primary):\n${lines.join('\n')}${more}`
}
