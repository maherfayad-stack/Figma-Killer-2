/**
 * svgPartCommits — writing attributes of the elements inside an inline
 * `<svg>` (P5-D): the client half of the `svg-attr` edit kind
 * (`server/handlers/studioSvgWriteback.ts`).
 *
 * ONE GESTURE = ONE WRITE. A vector drag previews on the canvas without the
 * store (the overlay and a mirrored `d` on the real element, no React), and
 * posts here once, on release. It rides `commitStructural` because that is
 * the one body that already does everything a source gesture needs: flush the
 * autosave first, post with the P1-A identities, report a refusal as one
 * toast, re-sync the board only when a write landed, and push ONE undo entry
 * whose inverse is KNOWN now — the same kind carrying the previous literals,
 * with `remove` for the attributes that were absent. ⌘Z posts that; ⇧⌘Z posts
 * the gesture again.
 *
 * `rollback` is what takes the canvas preview back when the write does not
 * land — the preview is imperative DOM the resync would otherwise have
 * replaced.
 */
import { mintPendingCommitId } from '@site/store/slices/site/structuralCommitRollback'
import { commitStructural } from './studioStructuralCommitEngine'
import type { StructuralEditPayload } from './structuralUndoPlan'

export interface SvgPartWrite {
  /** The host `<svg>`'s node id. */
  hostNodeId: string
  /** The part's stamped `line:col`, or `''` for the host `<svg>` itself. */
  part: string
  /** The part's tag, as read — the server refuses `element-moved` when the file disagrees. */
  partTag: string
  /** JSX attribute names → the literal to write. */
  set: Readonly<Record<string, string | number>>
  /** JSX attribute names to delete. */
  remove?: readonly string[]
  /**
   * What each attribute this write touches holds NOW (`undefined` = absent) —
   * the inverse. Every key of `set` and every name in `remove` must appear.
   */
  previous: Readonly<Record<string, string | number | undefined>>
}

function forwardEdit(write: SvgPartWrite): StructuralEditPayload {
  return {
    kind: 'svg-attr',
    nodeId: write.hostNodeId,
    part: write.part,
    partTag: write.partTag,
    set: { ...write.set },
    ...(write.remove && write.remove.length > 0 ? { remove: [...write.remove] } : {}),
  }
}

/** The edit that puts `write`'s attributes back as they were. */
export function inverseSvgPartEdit(write: SvgPartWrite): StructuralEditPayload {
  const set: Record<string, string | number> = {}
  const remove: string[] = []
  for (const name of [...Object.keys(write.set), ...(write.remove ?? [])]) {
    const before = write.previous[name]
    if (before === undefined) remove.push(name)
    else set[name] = before
  }
  return {
    kind: 'svg-attr',
    nodeId: write.hostNodeId,
    part: write.part,
    partTag: write.partTag,
    set,
    ...(remove.length > 0 ? { remove } : {}),
  }
}

/**
 * Post `writes` as ONE gesture: one `/save`, one undo entry named `label`.
 * `onNotLanded` runs when the write was refused or never answered.
 */
export async function commitSvgPartAttributes(
  writes: readonly SvgPartWrite[],
  label: string,
  onNotLanded?: () => void,
): Promise<void> {
  if (writes.length === 0) return
  let done = false
  await commitStructural(writes.map(forwardEdit), 'Edit refused', {
    undo: { label, template: { kind: 'known', inverse: writes.map(inverseSvgPartEdit) } },
    rollback: {
      id: mintPendingCommitId(),
      settle: () => {
        done = true
      },
      rollback: () => {
        if (done) return
        done = true
        onNotLanded?.()
      },
    },
  })
}
