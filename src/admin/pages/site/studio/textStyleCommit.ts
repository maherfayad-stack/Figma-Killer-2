/**
 * textStyleCommit - CT-5: post a planned restyle (`textStylePlan.ts`) as ONE
 * structural commit.
 *
 * It rides `commitStructural` like every one-shot source write: the pending
 * autosave is flushed first, the batch is posted with the identities the board
 * read, a landed write re-syncs the board with disk, and a refused one says so
 * once. The undo entry is the undo journal's `restore` (`restore-journal`): the
 * server pre-imaged every file the batch changes - the stylesheet a create
 * writes included - so Cmd+Z puts them all back byte for byte, and Cmd+Shift+Z
 * posts the same edits again.
 */
import { pushToast } from '@ui/components/Toast'
import type { RestylePlan } from './textStylePlan'
import { commitStructural } from './studioStructuralCommitEngine'

/** The title of the warning a refused restyle shows. */
const REFUSAL_TITLE = 'Style not applied'

/**
 * Posts `plan`. A plan the client already knows cannot be written is shown as
 * the same warning a server refusal gets - the sentence is the remedy, and
 * nothing was written either way.
 */
export async function commitRestyle(plan: RestylePlan): Promise<void> {
  if (!plan.ok) {
    pushToast({ kind: 'warning', title: REFUSAL_TITLE, body: plan.message, location: 'site-editor' })
    return
  }
  if (plan.edits.length === 0) return
  await commitStructural(plan.edits, REFUSAL_TITLE, {
    undo: { label: plan.label, template: { kind: 'restore-journal' } },
    select: 'created',
  })
}
