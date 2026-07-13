import { z } from 'zod';
import { NodeUidSchema } from './uid.js';

/**
 * TreeNode — carried by the `tree-snapshot` DaemonEvent, consumed by
 * `LayersPanel` (playbook §2.2/§5). Not specified in Appendix B; authored
 * fresh here for P0. CHANGE-REQUEST: revisit this shape once P2 (bridge/
 * hit-test) and P5 (LayersPanel) are built against it — in particular
 * whether `children` should carry raw text nodes as TreeNode leaves or a
 * separate lightweight text-run representation.
 *
 * - `kind` distinguishes an HTML element from a resolved design-system /
 *   local component instance, from a text run, from a fragment wrapper.
 * - `dynamic` mirrors `data-dynamic` from `vite-plugin-source-uid` (P2):
 *   true for anything generated inside `.map()` / conditionals / logical
 *   expressions — the editable-surface contract (playbook §0) locks these.
 * - `component` is only meaningful when `kind === "component-instance"`;
 *   carries the resolved import name (e.g. "Button"), prefixed `ds:` when
 *   it resolves through the design-system package alias (§1 node-addressing).
 */
export const TreeNodeKindSchema = z.enum(['element', 'component-instance', 'text', 'fragment']);
export type TreeNodeKind = z.infer<typeof TreeNodeKindSchema>;

export interface TreeNode {
  uid: import('./uid.js').NodeUid;
  kind: TreeNodeKind;
  /** HTML tag or component name; null for text runs and fragments. */
  tag: string | null;
  dynamic: boolean;
  // `| undefined` (not just `?`) to match zod's inferred optional-field
  // output shape under `exactOptionalPropertyTypes: true`.
  component?: string | undefined;
  children: TreeNode[];
}

export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    uid: NodeUidSchema,
    kind: TreeNodeKindSchema,
    tag: z.string().nullable(),
    dynamic: z.boolean(),
    component: z.string().optional(),
    children: z.array(TreeNodeSchema),
  }),
);
