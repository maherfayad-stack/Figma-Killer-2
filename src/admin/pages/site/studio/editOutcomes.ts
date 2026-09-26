/**
 * editOutcomes — which edits of a `/save` batch actually wrote (WB-35).
 *
 * The server's `refusals` list is COMPLETE (WB-12, `server/handlers/
 * studioEditRefusals.ts`): every edit that did not write is named there once,
 * under the id the client sent, with its kind — and, for a `prop` edit, the
 * prop, because one element can carry several prop edits in one batch. So an
 * edit wrote exactly when no refusal carries its key. That is the per-edit
 * outcome the diff baselines are committed against: the edits that landed
 * advance their baseline, the refused ones stay in the diff (and are re-sent
 * by a later save), and one refusal no longer holds back — and re-sends — the
 * whole batch, which is what the old aggregate `skipped` count forced.
 */

/** The identity of one edit's outcome: what a refusal and the edit it answers have in common. */
export interface EditOutcomeRef {
  nodeId: string
  kind: string
  prop?: string
}

/** The key an edit and its refusal share. */
export function editOutcomeKey(ref: EditOutcomeRef): string {
  return `${ref.kind}|${ref.nodeId}|${ref.prop ?? ''}`
}

/** The keys of every edit the server refused. */
export function refusedEditKeys(refusals: readonly EditOutcomeRef[] | undefined): Set<string> {
  return new Set((refusals ?? []).map(editOutcomeKey))
}
