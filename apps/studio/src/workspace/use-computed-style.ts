import * as React from 'react';
import type { ComputedStyleRow, StudioCanvasHandle } from '@ccs/canvas';

/**
 * FIX-W4b-1 Part B — fetches the SELECTED node's real computed CSS via the
 * EXISTING FP-INS-b bridge round-trip (`StudioCanvasHandle.
 * requestComputedStyle` -> `report-computed-style`/`computed-style-result`,
 * `@ccs/bridge`'s `computed-style.ts`) — the SAME mechanism `InspectPanel.
 * tsx`'s own CSS effect already uses for the Inspect tab. This hook is what
 * lets `Inspector.tsx` (the Design tab) show those same real values —
 * read-only, consumes the existing message, adds ZERO new bridge/protocol
 * plumbing (hard constraint).
 *
 * `bridgeGeneration` (bumped by `WorkspaceShell` every time the edit-mode
 * frame's bridge (re)connects) is a required dependency for the exact reason
 * `InspectPanel`'s own doc gives: `requestComputedStyle` resolves
 * `{ok:false}` while no bridge is live, and selecting a node only brings its
 * frame's bridge up AFTER the selection — a one-shot fetch keyed on `uid`
 * alone would lose that race and show "loading" forever.
 *
 * Unlike `InspectPanel`'s `InspectContent` (which relies on being REMOUNTED
 * per-node via `key={node.uid}` to reset its `useState(null)`), this hook
 * lives inside `Inspector`, a single long-lived component instance across
 * every selection change. Rather than SYNCHRONOUSLY reset state when `uid`
 * changes (which `react-hooks/set-state-in-effect` — a hard lint gate in this
 * repo — forbids as a cascading-render smell), it tags the stored result with
 * the uid it belongs to and DERIVES "loading" (`null`) for any other uid: a
 * stale result from the previously-selected node simply never surfaces, and
 * `setState` only ever happens inside the async `.then` callback (allowed —
 * it's a response to an external system, not a synchronous effect-body write).
 */
export function useComputedStyle(
  uid: string | undefined,
  canvasHandle: StudioCanvasHandle | null,
  bridgeGeneration: number,
): ComputedStyleRow[] | null {
  const [state, setState] = React.useState<{ uid: string; rows: ComputedStyleRow[] } | null>(null);

  React.useEffect(() => {
    if (!uid || !canvasHandle) return;
    let cancelled = false;
    void canvasHandle.requestComputedStyle(uid).then((result) => {
      if (!cancelled && result.ok) setState({ uid, rows: result.info.rows });
    });
    return () => {
      cancelled = true;
    };
  }, [uid, canvasHandle, bridgeGeneration]);

  // Only surface rows that belong to the CURRENTLY selected uid — a result
  // still stored from a previous selection reads as "loading" (`null`) until
  // this uid's own fetch resolves.
  return state && state.uid === uid ? state.rows : null;
}
