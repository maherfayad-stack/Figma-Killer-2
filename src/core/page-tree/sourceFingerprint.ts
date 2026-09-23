/**
 * The WIRE half of a studio node's identity fingerprint (P1-A, WB-1/ERR-4):
 * the shape every layer agrees on, with none of the computation.
 *
 * A node id is `rel:line:col`. That is a POSITION, not an identity: when the
 * file changes under the board (the agent's Edit tool, VS Code, `git pull`, a
 * write still in flight), the same position names a different element, and a
 * prop, text or delete edit aimed at it used to land on the neighbour and
 * report `written: 1`. The fingerprint is what the board recorded ABOUT the
 * element when it read that position, so the server can check it is still the
 * element there before any codemod runs, and refuse `element-moved` when not.
 *
 * ## The shape
 *
 * `<label>#<8 lowercase hex digits>`:
 *
 *   - `label` is the element's tag name as written (`li`, `Card`,
 *     `motion.div`) or `literal` for a string/number literal token (the target
 *     of a `literal` or `asset` edit). Readable on purpose: a refusal can say
 *     "expected <li>, found <section>" without a second field.
 *   - the hash is FNV-1a (32 bit) over the element's opening tag and its own
 *     direct text, whitespace-collapsed. `@core/page-parser`'s
 *     `sourceFingerprint.ts` is the only place that computes one; the browser
 *     never does, it only carries what the parser minted.
 *
 * `#` cannot occur in a JSX tag name, so the LAST `#` always splits the two.
 *
 * ## Why a string and not `{ tag, hash }`
 *
 * It is carried on every source-derived node in every page line of the load
 * stream, and compared for equality only. One short string is the cheapest
 * thing that still names the tag.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { buildSourceNodeId, decodeSourceNodeId } from './sourceNodeId'

/**
 * The refusal reason a write gets when a position it names no longer holds the
 * element the writer expected. Shared by the server that decides it and the
 * client that recovers from it, so the two cannot spell it differently.
 */
export const ELEMENT_MOVED_REASON = 'element-moved'

export const SourceFingerprintSchema = Type.String({ pattern: '^[^\\s#]+#[0-9a-f]{8}$' })
export type SourceFingerprint = Static<typeof SourceFingerprintSchema>

/**
 * What a writer expects to find, keyed by the node id (or origin location id)
 * the edit names — the `expect` field of `POST /admin/api/studio/save`. Every id
 * an edit names (`nodeId`, `anchorNodeId`, `parentNodeId`, `siblingNodeIds`) is
 * checked against its entry, when it has one.
 */
export const SourceFingerprintExpectationsSchema = Type.Record(Type.String(), SourceFingerprintSchema)
export type SourceFingerprintExpectations = Static<typeof SourceFingerprintExpectationsSchema>

/** The label half — the tag name, or `literal`. */
export function sourceFingerprintLabel(fingerprint: string): string {
  const at = fingerprint.lastIndexOf('#')
  return at <= 0 ? fingerprint : fingerprint.slice(0, at)
}

/**
 * The plain `rel:line:col` a node id WRITES to — the tail of a composite id —
 * or `null` for an id with no writable source location (a synthetic root, a
 * `.map` row). Two composite ids with the same tail are one source element,
 * so this is the key a fingerprint belongs to, not the node id.
 */
export function sourceLocationKey(nodeId: string): string | null {
  const location = decodeSourceNodeId(nodeId)
  return location ? buildSourceNodeId(location.rel, location.line, location.col) : null
}
