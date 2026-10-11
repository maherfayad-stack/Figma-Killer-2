/**
 * undoJournalToken — the one definition of what an undo-journal token looks
 * like, shared by the wire schema (`studioEditSchemas.ts`'s `restore` edit)
 * and the store that turns a token into a file name (`undoJournal.ts`). A
 * leaf, so neither has to import the other.
 *
 * Lowercase hex only: nothing that can spell a separator, a dot or a drive,
 * so a token that passes can never traverse out of the journal folder.
 */
import { Type } from '@core/utils/typeboxHelpers'

const UNDO_JOURNAL_TOKEN_PATTERN = '^[0-9a-f]{32}$'

/** Whether `token` is well-formed. Checked before a token is ever joined into a path. */
export function isUndoJournalToken(token: string): boolean {
  return new RegExp(UNDO_JOURNAL_TOKEN_PATTERN).test(token)
}

/** A token on the wire. */
export const UndoJournalTokenSchema = Type.String({ pattern: UNDO_JOURNAL_TOKEN_PATTERN })
