/**
 * historyCoalesce — the shared "single-field patch -> stable coalesce key"
 * rule every per-keystroke/per-tick mutation path uses so a typing/drag burst
 * folds into ONE undo entry instead of one per tick.
 *
 * Originally lived only in `nodeActions.ts` (the node-prop/breakpoint-override
 * path). Extracted here so `styleRule/crudActions.ts`'s class/style edits
 * (`STUDIO-FIGMA-PARITY-PLAN.md` 0.3) use the EXACT same shape rather than a
 * hand-rolled duplicate that could silently drift from it.
 */

/**
 * Build the history-coalescing options for a single-field patch, or `undefined`
 * for multi-field patches (which always get their own discrete undo entry).
 *
 * Per-keystroke text/number/color controls patch exactly one property per
 * change, so a stable `<scope>:<id>:<key>` key lets `pushHistorySnapshot` fold
 * a whole burst into one undo step instead of cloning the site per tick.
 */
export function coalesceKeyForPatch(
  scope: string,
  id: string,
  patch: Record<string, unknown>,
): { coalesceKey: string } | undefined {
  const keys = Object.keys(patch)
  if (keys.length !== 1) return undefined
  return { coalesceKey: `${scope}:${id}:${keys[0]}` }
}
