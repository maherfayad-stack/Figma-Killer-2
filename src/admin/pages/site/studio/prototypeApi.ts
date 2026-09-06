/**
 * prototypeApi — client for `/admin/api/studio/prototype`.
 *
 * Mirrors `commentsApi.ts` exactly, for the same reason: only the HTTP envelope
 * is validated with TypeBox here, because `parsePrototypeFile` /
 * `parseCodeFlow` from `@core/studio-prototype` are the real shape validators
 * and re-declaring their schemas as envelope fields would be a parallel,
 * driftable copy.
 *
 * TWO ENDPOINTS, AND THE ASYMMETRY IS THE POINT
 * ─────────────────────────────────────────────
 * `fetchPrototype`/`applyPrototypeOp` are the authored links: read and write.
 * `fetchCodeFlow` is the DERIVED flow map, and there is deliberately no write
 * counterpart — the only way to change one of those edges is to change the code
 * Studio read it out of.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import {
  parseCodeFlow,
  parsePrototypeFile,
  type CodeFlow,
  type PrototypeFile,
  type PrototypeLink,
} from '@core/studio-prototype'

const PrototypeGetResponseSchema = Type.Object({
  dir: Type.String(),
  prototype: Type.Unknown(),
})

const PrototypePostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  changed: Type.Boolean(),
  prototype: Type.Unknown(),
})

const CodeFlowGetResponseSchema = Type.Object({
  dir: Type.String(),
  flow: Type.Unknown(),
})

/**
 * The client-side op vocabulary. Deliberately NOT imported from the server's
 * `PrototypeOpSchema` — `server/` is not reachable from the browser bundle —
 * but every field name here is checked against it on arrival, so a drift is a
 * 400 at the boundary rather than a silent mis-write.
 */
export type PrototypeOp =
  | { kind: 'upsert'; link: PrototypeLink }
  | { kind: 'remove'; linkId: string }
  | { kind: 'prune'; pageIds: string[] }

/** Fetch and parse the authored links for `dir` (server default workspace when omitted). */
export async function fetchPrototype(dir?: string): Promise<PrototypeFile> {
  const res = await apiRequest('/admin/api/studio/prototype', {
    schema: PrototypeGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return parsePrototypeFile(res.prototype)
}

/**
 * Apply one operation and adopt the server's merged result.
 *
 * The returned file is the authority, not a confirmation — see
 * `prototypeStore.ts` for why these writes are op-shaped.
 */
export async function applyPrototypeOp(op: PrototypeOp, dir?: string): Promise<PrototypeFile> {
  const res = await apiRequest('/admin/api/studio/prototype', {
    method: 'POST',
    body: { dir, op },
    schema: PrototypePostResponseSchema,
  })
  return parsePrototypeFile(res.prototype)
}

/** Fetch the flow map Studio derived from the project's own navigation code. */
export async function fetchCodeFlow(dir?: string): Promise<CodeFlow> {
  const res = await apiRequest('/admin/api/studio/prototype/flow', {
    schema: CodeFlowGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return parseCodeFlow(res.flow)
}
