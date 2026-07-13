import { z } from 'zod';
import { NodeUidSchema } from './uid.js';
import { TreeNodeSchema } from './tree.js';
import { CanvasOpSchema } from './ops.js';

/**
 * DaemonEvent — union of Appendix B's sketch and playbook §4/P0's prose list.
 * Appendix B: hmr-update, uid-remap, tree-snapshot, tokens-changed,
 * components-changed, op-applied, op-rejected.
 * §4/P0 prose: file-changed, hmr-update, uid-remap, tokens-changed,
 * components-changed (omits tree-snapshot/op-applied/op-rejected — an
 * earlier, less complete pass at the same list).
 * This task's brief explicitly resolves the mismatch as a union of both
 * ("plus file-changed per §4/P0") rather than leaving it ambiguous, so
 * `file-changed` is added as an 8th variant alongside the 7 from Appendix B.
 * Discriminant field is `t`, matching CanvasOp.
 */

export const FileChangedEventSchema = z
  .object({
    t: z.literal('file-changed'),
    file: z.string(),
  })
  .strict();

export const HmrUpdateEventSchema = z
  .object({
    t: z.literal('hmr-update'),
    file: z.string(),
  })
  .strict();

export const UidRemapEventSchema = z
  .object({
    t: z.literal('uid-remap'),
    file: z.string(),
    map: z.record(NodeUidSchema, NodeUidSchema),
  })
  .strict();

export const TreeSnapshotEventSchema = z
  .object({
    t: z.literal('tree-snapshot'),
    file: z.string(),
    tree: TreeNodeSchema,
  })
  .strict();

export const TokensChangedEventSchema = z
  .object({
    t: z.literal('tokens-changed'),
  })
  .strict();

export const ComponentsChangedEventSchema = z
  .object({
    t: z.literal('components-changed'),
  })
  .strict();

export const OpAppliedEventSchema = z
  .object({
    t: z.literal('op-applied'),
    opId: z.string(),
    inverse: z.array(CanvasOpSchema),
  })
  .strict();

export const OpRejectedEventSchema = z
  .object({
    t: z.literal('op-rejected'),
    opId: z.string(),
    reason: z.string(),
  })
  .strict();

export const DaemonEventSchema = z.discriminatedUnion('t', [
  FileChangedEventSchema,
  HmrUpdateEventSchema,
  UidRemapEventSchema,
  TreeSnapshotEventSchema,
  TokensChangedEventSchema,
  ComponentsChangedEventSchema,
  OpAppliedEventSchema,
  OpRejectedEventSchema,
]);

export type FileChangedEvent = z.infer<typeof FileChangedEventSchema>;
export type HmrUpdateEvent = z.infer<typeof HmrUpdateEventSchema>;
export type UidRemapEvent = z.infer<typeof UidRemapEventSchema>;
export type TreeSnapshotEvent = z.infer<typeof TreeSnapshotEventSchema>;
export type TokensChangedEvent = z.infer<typeof TokensChangedEventSchema>;
export type ComponentsChangedEvent = z.infer<typeof ComponentsChangedEventSchema>;
export type OpAppliedEvent = z.infer<typeof OpAppliedEventSchema>;
export type OpRejectedEvent = z.infer<typeof OpRejectedEventSchema>;
export type DaemonEvent = z.infer<typeof DaemonEventSchema>;
