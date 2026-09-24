/**
 * studioEditRefusals — every way one studio edit can end WITHOUT writing,
 * turned into ONE named refusal (WB-12).
 *
 * ## Why every kind refuses by name now
 *
 * The batch used to have two failure channels. A handful of kinds (`detach`,
 * `swap`, `css`, `class`, `style`, the structural and slot families) threw a
 * typed `StudioEditRefusalError` and reached the client as a refusal with a
 * reason and a sentence. Everything else — a text edit on an element with
 * mixed children, a locate miss, a tag rename on a component, a literal that
 * is no longer a string, an asset path that failed containment — fell into an
 * "unexplained skip". The client could only answer those with one red toast,
 * "Some changes were not saved to source", and always blamed "text that comes
 * from a prop or a variable", which was the wrong cause for most of them.
 *
 * Every codemod decline is now a refusal with a stable reason, and the
 * sentence a person reads is written HERE, from the reason — never the
 * codemod's own message, which carries an absolute path and codemod internals
 * (WB-33). The batch's `refusals` list is therefore complete: an edit the
 * caller sent wrote exactly when no refusal names it. That is the per-edit
 * outcome the client commits its baselines against (WB-35).
 *
 * ## The reasons this module adds
 *
 *   - `element-moved` — nothing is at that `line:col` any more. The same code
 *     P1-A's identity check uses, so the board's silent re-read-and-retry
 *     (`elementMovedRecovery.ts`) covers a codemod-level miss too.
 *   - `mixed-children` — a text edit on an element whose children are not
 *     one plain text run.
 *   - `component-tag` / `invalid-tag` — a rename of a component, or to a name
 *     that is not an HTML tag.
 *   - `not-a-literal` — a `literal`/`asset` edit whose position holds
 *     something other than the string it expects.
 *   - `spread-attribute` — a prop that only exists inside `{...spread}`.
 *   - `no-source-location` / `stylesheet-unavailable` / `asset-unavailable` —
 *     an `applied: false` outcome: nowhere honest to write.
 *   - `write-failed` — an exception nobody named. Logged in full on the
 *     server; the person reads one plain sentence.
 */
import {
  ImportSpecifierTargetError,
  JsxElementNotFoundError,
  JsxPropTargetError,
  JsxStyleTargetError,
  JsxTagNameTargetError,
  JsxTextTargetError,
  StringLiteralTargetError,
} from '@core/ast-codemods'
import { ELEMENT_MOVED_REASON } from '@core/page-tree'
import type {
  StudioEdit,
  StudioEditApplyOutcome,
  StudioEditRefusal,
  StudioEditUnwritableReason,
} from './studioEditSchemas'

/**
 * A codemod (or the dispatcher in front of it) DECLINED this edit on purpose,
 * with a stable `reason` and a sentence for the person who made it. Thrown by
 * `applyStudioEdit`; `applyStudioEditBatch` records it in `refusals`.
 */
export class StudioEditRefusalError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'StudioEditRefusalError'
    this.reason = reason
  }
}

/** The reason for an exception no codemod named. See this module's doc. */
export const WRITE_FAILED_REASON = 'write-failed'

const ELEMENT_MOVED_SENTENCE =
  'The file changed since the board read it, and this element is no longer where it was, so nothing was written.'

const UNWRITABLE_SENTENCE: Record<StudioEditUnwritableReason, string> = {
  'no-source-location': 'This element has no single place in your code to write to, so the change stays on the canvas only.',
  'stylesheet-unavailable':
    'The stylesheet this change belongs in is outside the project or no longer exists, so nothing was written.',
  'asset-unavailable': 'That file is outside the project or no longer exists, so the image was not changed in your code.',
}

/**
 * The one refusal shape every channel reports. `prop` rides along for a `prop`
 * edit: one element can carry several prop edits in one batch, and only the
 * refused one may be held back (WB-35).
 */
export function refusalFor(edit: StudioEdit, reason: string, message: string): StudioEditRefusal {
  return {
    nodeId: edit.nodeId,
    kind: edit.kind,
    ...(edit.kind === 'prop' ? { prop: edit.prop } : {}),
    reason,
    message,
  }
}

/** The refusal an `applied: false` (non-preview) outcome stands for. */
export function refusalForUnwritable(edit: StudioEdit, outcome: StudioEditApplyOutcome): StudioEditRefusal {
  const reason = outcome.unwritable ?? 'no-source-location'
  return refusalFor(edit, reason, UNWRITABLE_SENTENCE[reason])
}

/**
 * Translates a codemod's typed throw into the refusal it stands for, or
 * `null` for an exception nobody named (the caller logs it and reports
 * {@link WRITE_FAILED_REASON}).
 */
export function refusalFromCodemodError(edit: StudioEdit, err: unknown): StudioEditRefusalError | null {
  if (err instanceof StudioEditRefusalError) return err
  if (err instanceof JsxElementNotFoundError) return new StudioEditRefusalError(ELEMENT_MOVED_REASON, ELEMENT_MOVED_SENTENCE)
  if (err instanceof JsxTextTargetError) {
    return new StudioEditRefusalError(
      err.reason,
      'This element holds other elements or code next to its text, so rewriting the text would overwrite them. Nothing was written; change this text in the code.',
    )
  }
  if (err instanceof JsxTagNameTargetError) {
    return new StudioEditRefusalError(
      err.reason,
      err.reason === 'component-tag'
        ? 'This element is a component, not an HTML element, so its tag cannot be renamed — that would need a different import. Swap the component instead.'
        : `"${edit.kind === 'tag' ? edit.tag : ''}" is not an HTML tag name Studio can write.`,
    )
  }
  if (err instanceof StringLiteralTargetError || err instanceof ImportSpecifierTargetError) {
    if (err.reason === ELEMENT_MOVED_REASON) return new StudioEditRefusalError(ELEMENT_MOVED_REASON, ELEMENT_MOVED_SENTENCE)
    return new StudioEditRefusalError(
      err.reason,
      err instanceof ImportSpecifierTargetError
        ? 'The import this image comes from is no longer a plain file import in the code, so Studio did not rewrite it.'
        : 'The text this copy comes from is no longer a plain string in the code, so Studio did not overwrite it. Change it in the code.',
    )
  }
  if (err instanceof JsxPropTargetError) {
    return new StudioEditRefusalError(
      err.reason,
      err.reason === 'spread-attribute'
        ? `"${edit.kind === 'prop' ? edit.prop : ''}" only comes from a spread ({...props}) on this element, so there is no attribute to write. Change it in the code.`
        : err.message,
    )
  }
  // `style-03` — a removal from an expression `style`, a non-object value, a
  // shorthand key (P3-C/WB-17 writes a spread or an identifier): a named
  // decision, with the codemod's own reason minus its path prefix.
  if (err instanceof JsxStyleTargetError) return new StudioEditRefusalError('style-target', err.detail)
  return null
}

/** The refusal for an exception no codemod named. The raw error goes to the server log, never to the client. */
export function writeFailedRefusal(edit: StudioEdit): StudioEditRefusal {
  return refusalFor(
    edit,
    WRITE_FAILED_REASON,
    'Studio could not write this change, so nothing was written. The details are in the server log.',
  )
}
