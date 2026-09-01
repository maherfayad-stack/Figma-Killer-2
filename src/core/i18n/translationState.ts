/**
 * translationState — when a dictionary entry still needs translating.
 *
 * Shared by the Content panel (which counts, filters and labels) and the
 * server's translate action (which picks what to send to the model). They were
 * two independent copies of `(value ?? '').trim() === ''`, and a rule that
 * decides both "is there work to do" and "what gets worked on" cannot be
 * allowed to drift between them: a key the panel calls untranslated but the
 * action skips is a row the user can never clear.
 *
 * ## Identical to the source counts as untranslated
 *
 * An empty cell is the obvious case. The one that actually bit: a translator
 * — human or model — handed back the SOURCE STRING unchanged. Measured on a
 * real project, `page2.page2`, `popup.popup`, `sheet.sheet` and `sheet2.sheet2`
 * all had `ar` set to `"Page2"`, `"Popup"`, `"Sheet"`, `"Sheet2"` — the English
 * words, because a model asked to translate a bare product-ish noun often
 * returns it verbatim. Every one of them was then counted as done: the panel
 * read "Missing ar (0)", the translate button sat disabled with "Every key
 * already has ar", and the Arabic canvas kept rendering a Latin `Sheet2` at the
 * top of a fully Arabic sheet. The strings were not merely untranslated, they
 * were **unreachable** — no filter surfaced them and no action targeted them.
 *
 * ## The cost, stated plainly
 *
 * Some strings are legitimately identical across locales: a brand name, a
 * product code, `OK`. Those now flag as needing attention and will keep
 * flagging, because nothing in the data distinguishes "deliberately the same"
 * from "silently skipped".
 *
 * That trade is deliberate. A false positive is visible and costs a glance —
 * the row is right there with both values shown side by side. A false negative
 * is invisible and permanent, which is the failure this function exists to
 * end. On the project this was measured against the rule produced four true
 * positives and zero false ones, because pure numbers and punctuation are
 * excluded below.
 */

/**
 * Whether `target` still needs translating from `source`.
 *
 * Blank target: yes, always — unchanged from the original rule.
 *
 * Target identical to source: yes, but only when the string contains a letter.
 * A value that is purely digits, punctuation or symbols (`"9:41"`, `"—"`,
 * `"2025"`) is normally correct as-is in every locale, so flagging it would be
 * noise with no plausible fix behind it.
 */
export function isUntranslated(source: string | undefined, target: string | undefined): boolean {
  const targetText = (target ?? '').trim()
  if (targetText === '') return true
  const sourceText = (source ?? '').trim()
  if (sourceText === '') return false
  if (targetText !== sourceText) return false
  // `\p{L}` rather than a-z: the source may already be non-Latin, and a
  // Cyrillic or CJK string echoed back is the same failure.
  return /\p{L}/u.test(targetText)
}
