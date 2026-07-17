/**
 * Inspector "class hints" — a session-local, IN-MEMORY (never localStorage,
 * never persisted — satisfies this task's One-Rule-adjacent "no design data
 * in localStorage" constraint trivially, since this cache doesn't survive a
 * page reload at all) record of the last value THIS Inspector itself wrote
 * for a given `(uid, group)` pair.
 *
 * ## Disclosed divergence: this is NOT a read of the node's true current
 * state
 * The brief asks each control to "READ the node's current state (parse the
 * node's Tailwind className, and/or query computed style via the existing
 * bridge if you need a live value)". Neither is actually wired to
 * `apps/studio` today: `TreeNode` (the FROZEN `packages/protocol` shape the
 * daemon's `tree-snapshot` event carries) has no `className` field at all
 * (confirmed: `packages/ast-engine/src/build-tree.ts` never captures one),
 * and the bridge's live DOM/computed-style connection
 * (`packages/canvas/src/bridge-client.ts`'s `connectBridge`) is owned
 * entirely by `@ccs/canvas`'s internal `EditModeLayer` — it is never
 * surfaced to `apps/studio`, and `StudioCanvasHandle` (the one imperative
 * seam `WorkspaceShell` exposes) has no "read this uid's live classes/style"
 * method. Building either path is a multi-package, protocol/bridge-adjacent
 * change (a new `TreeNode` field, or a new bridge message + `BridgeConnection`
 * method + `StudioCanvasHandle` passthrough threaded through `WorkspaceShell`
 * into a new context) — outside this task's "Inspector.tsx + small helpers"
 * scope and its own explicit escape valve ("if a control seems to need new
 * plumbing, STOP and report" — read the spirit of that as covering new DATA
 * plumbing, not just new ops). Flagged here, in the worker report, and NOT
 * silently worked around by fabricating a fake "current value".
 *
 * What this module gives instead: every control still shows SOMETHING
 * sensible on first selection (a neutral placeholder/Penpot-shaped default —
 * chosen per-section in `Inspector.tsx`), and from the moment the user first
 * uses a control on a given node for the rest of THIS session, the control
 * reflects exactly what IT wrote (so "change size -> control now reflects
 * the new size" — the literally re-testable half of the acceptance bullet —
 * holds; "select a never-before-touched node -> shows its true pre-existing
 * size" does not, and is disclosed as a carry-forward CR: add `className` to
 * `TreeNode` additively, or add a read-only bridge query, in a follow-up
 * phase).
 */

const hints = new Map<string, string>();

function hintKey(uid: string, group: string): string {
  return `${uid}::${group}`;
}

export function getClassHint(uid: string, group: string): string | undefined {
  return hints.get(hintKey(uid, group));
}

export function setClassHint(uid: string, group: string, value: string): void {
  hints.set(hintKey(uid, group), value);
}

/** Test-only: unit tests run in the same module registry across `it()`
 * blocks (no fresh module instance per test), so this resets the shared
 * cache between assertions. Never called from product code. */
export function _resetClassHintsForTest(): void {
  hints.clear();
}
