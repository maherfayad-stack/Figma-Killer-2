import { z } from 'zod';

/**
 * NodeUid — how the canvas addresses a JSX node.
 *
 * Appendix B: `type NodeUid = \`${string}.tsx:${string}\`` (relPath : astPath).
 * Playbook §1 node-addressing section spells out the concrete shape:
 *   `<relPath>:<astNodePath>` e.g. `src/frames/Hero.tsx:JSXElement[3].children[1]`
 *
 * We validate the wire format with a regex rather than zod's native
 * `z.templateLiteral` so the schema also rejects structurally-empty halves
 * (`"".tsx:"" ` — an empty relPath or empty astPath is never a valid uid,
 * something the bare TS template-literal type cannot express).
 */
export type NodeUid = `${string}.tsx:${string}`;

const NODE_UID_PATTERN = /^.+\.tsx:.+$/;

// A plain `z.string().regex(...)` at runtime, typed as `NodeUid` so every
// schema that embeds it (including as `z.record` keys, which reject
// `ZodEffects`/transform pipelines) infers the branded template-literal type
// instead of widening to `string`.
export const NodeUidSchema = z
  .string()
  .regex(
    NODE_UID_PATTERN,
    'NodeUid must match `<relPath>.tsx:<astPath>` (e.g. "src/frames/Hero.tsx:JSXElement[3]")',
  ) as unknown as z.ZodType<NodeUid>;

export function isNodeUid(value: unknown): value is NodeUid {
  return typeof value === 'string' && NODE_UID_PATTERN.test(value);
}
