/**
 * prototypeApi — client for `/admin/api/studio/prototype`.
 *
 * Same posture as `commentsApi`: only the HTTP envelope is validated here,
 * because `parsePrototypeFile` from `@core/studio-prototype` is the real shape
 * validator and a second TypeBox mirror of the link model would be a parallel,
 * driftable copy of it.
 *
 * A write sends ONE `PrototypeOp` and the server returns the merged file, which
 * the store adopts wholesale. See `prototypeStore.ts` for why.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { parsePrototypeFile, type PrototypeFile, type PrototypeLink } from '@core/studio-prototype'

const PrototypeGetResponseSchema = Type.Object({
  dir: Type.String(),
  prototype: Type.Unknown(),
})

const PrototypePostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  changed: Type.Boolean(),
  prototype: Type.Unknown(),
})

/**
 * The client-side op vocabulary. Deliberately NOT imported from the server's
 * `PrototypeOpSchema` — `server/` is not reachable from the browser bundle —
 * but every field here is checked against it by that schema on arrival, so a
 * drift is a 400 at the boundary rather than a silent mis-write.
 */
export type PrototypeOp =
  | { kind: 'upsert'; link: PrototypeLink }
  | { kind: 'remove'; linkId: string }
  | { kind: 'prune'; pageIds: string[] }

export async function fetchPrototype(dir?: string): Promise<PrototypeFile> {
  const res = await apiRequest('/admin/api/studio/prototype', {
    schema: PrototypeGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return parsePrototypeFile(res.prototype)
}

export async function applyPrototypeOp(op: PrototypeOp, dir?: string): Promise<PrototypeFile> {
  const res = await apiRequest('/admin/api/studio/prototype', {
    method: 'POST',
    body: { dir, op },
    schema: PrototypePostResponseSchema,
  })
  return parsePrototypeFile(res.prototype)
}
