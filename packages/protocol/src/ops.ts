import { z } from 'zod';
import { NodeUidSchema } from './uid.js';
import { JsonSchema } from './json.js';

/**
 * CanvasOp — Appendix B, frozen for P0. Field names match exactly:
 * set-text, set-prop, set-classes, insert-node, delete-node, move-node,
 * wrap-node. Discriminant field is `t` (not `type`) per Appendix B.
 *
 * Two deliberate additions beyond the bare Appendix B sketch, called out as
 * CHANGE-REQUESTs rather than silent drift:
 *   1. `index` (insert-node, move-node) is constrained to a non-negative
 *      integer — implied by "index into a children array" but not stated.
 *   2. `wrap-node.uids` is constrained non-empty (`.min(1)`) — wrapping zero
 *      nodes is not a meaningful operation.
 * Appendix B also hard-codes `wrapper.tag` to the literal `"div"` — kept
 * exactly as specified, but flagged as a CHANGE-REQUEST: P3/P5 may want to
 * wrap inline selections in a `<span>` instead, which this schema currently
 * forbids.
 */

const TokenRefSchema = z.object({ token: z.string() }).strict();

export const SetTextOpSchema = z
  .object({
    t: z.literal('set-text'),
    uid: NodeUidSchema,
    text: z.string(),
  })
  .strict();

export const SetPropOpSchema = z
  .object({
    t: z.literal('set-prop'),
    uid: NodeUidSchema,
    name: z.string().min(1),
    // Json | { token } | null — literal union per Appendix B (the trailing
    // `| null` is redundant with Json already including null; kept verbatim
    // rather than silently collapsed).
    value: z.union([JsonSchema, TokenRefSchema, z.null()]),
  })
  .strict();

export const SetClassesOpSchema = z
  .object({
    t: z.literal('set-classes'),
    uid: NodeUidSchema,
    add: z.array(z.string()),
    remove: z.array(z.string()),
  })
  .strict();

const InsertSourceDsComponentSchema = z
  .object({
    kind: z.literal('ds-component'),
    name: z.string().min(1),
  })
  .strict();

const InsertSourceElementSchema = z
  .object({
    kind: z.literal('element'),
    tag: z.string().min(1),
    classes: z.string().optional(),
  })
  .strict();

export const InsertNodeOpSchema = z
  .object({
    t: z.literal('insert-node'),
    parentUid: NodeUidSchema,
    index: z.number().int().nonnegative(),
    source: z.discriminatedUnion('kind', [
      InsertSourceDsComponentSchema,
      InsertSourceElementSchema,
    ]),
  })
  .strict();

export const DeleteNodeOpSchema = z
  .object({
    t: z.literal('delete-node'),
    uid: NodeUidSchema,
  })
  .strict();

export const MoveNodeOpSchema = z
  .object({
    t: z.literal('move-node'),
    uid: NodeUidSchema,
    newParentUid: NodeUidSchema,
    index: z.number().int().nonnegative(),
  })
  .strict();

export const WrapNodeOpSchema = z
  .object({
    t: z.literal('wrap-node'),
    uids: z.array(NodeUidSchema).min(1),
    wrapper: z
      .object({
        tag: z.literal('div'),
        classes: z.string(),
      })
      .strict(),
  })
  .strict();

export const CanvasOpSchema = z.discriminatedUnion('t', [
  SetTextOpSchema,
  SetPropOpSchema,
  SetClassesOpSchema,
  InsertNodeOpSchema,
  DeleteNodeOpSchema,
  MoveNodeOpSchema,
  WrapNodeOpSchema,
]);

export type SetTextOp = z.infer<typeof SetTextOpSchema>;
export type SetPropOp = z.infer<typeof SetPropOpSchema>;
export type SetClassesOp = z.infer<typeof SetClassesOpSchema>;
export type InsertNodeOp = z.infer<typeof InsertNodeOpSchema>;
export type DeleteNodeOp = z.infer<typeof DeleteNodeOpSchema>;
export type MoveNodeOp = z.infer<typeof MoveNodeOpSchema>;
export type WrapNodeOp = z.infer<typeof WrapNodeOpSchema>;
export type CanvasOp = z.infer<typeof CanvasOpSchema>;
