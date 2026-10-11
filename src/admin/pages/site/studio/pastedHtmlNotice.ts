/**
 * pastedHtmlNotice - the words the board uses after HTML is pasted onto it
 * (G-10): what was left out of the markup, and where its styles went.
 *
 * Two different facts, two different moments:
 *
 *  - **Left out** is known the moment the markup is converted
 *    (`HtmlToJsxReport`): scripts, event handlers and unsafe links the paste
 *    never carried over. Said once, as soon as the write is posted - it does
 *    not depend on the write landing.
 *  - **Where the styles went** is the server's answer (`pastedHtml` on the save
 *    response): the stylesheet, the rules, the classes it renamed so a rule you
 *    already had stayed untouched, the rules it would not write because they
 *    would have restyled more than the paste. Said once the board has re-read
 *    the file, with an Undo that is only live while the paste is still the
 *    newest history entry.
 *
 * Both are info/warning notices, never a red toast: the editor did what it was
 * asked and says exactly what it did. Nothing is silent, and nothing is a
 * failure.
 */
import { pushToast } from '@ui/components/Toast'
import type { HtmlToJsxReport } from './htmlToJsxReport'
import type { StudioSaveResponse } from './studioSaveRequests'
import { announceUndoableNotice } from './transplantCarryNotice'

type Summaries = NonNullable<StudioSaveResponse['pastedHtml']>

const MAX_LISTED = 3

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown} +${items.length - MAX_LISTED} more` : shown
}

/** What the markup conversion left out, as a sentence - or `null` when it left nothing out. */
export function leftOutSentence(report: HtmlToJsxReport): string | null {
  const parts = [
    report.scripts > 0 ? plural(report.scripts, 'script') : null,
    report.handlers > 0 ? plural(report.handlers, 'event handler') : null,
    report.unsafeUrls > 0 ? plural(report.unsafeUrls, 'unsafe link') : null,
    report.styleDeclarations > 0 ? plural(report.styleDeclarations, 'inline style declaration') : null,
  ].filter((part): part is string => part !== null)
  const svg = report.svgRefusals.slice(0, 1)
  if (parts.length === 0 && svg.length === 0) return null
  return [parts.length > 0 ? `Left out: ${parts.join(', ')}.` : null, ...svg].filter(Boolean).join(' ')
}

export function announceLeftOut(report: HtmlToJsxReport): void {
  const body = leftOutSentence(report)
  if (!body) return
  pushToast({ kind: 'info', title: 'Pasted HTML was cleaned', body, location: 'site-editor', dedupeKey: 'paste-html:left-out' })
}

/** The notice for where the styles went, or `null` when the paste had no styles to place. */
export function pastedStylesNotice(summaries: Summaries): { title: string; body?: string } | null {
  const rules = summaries.reduce((sum, summary) => sum + summary.rules, 0)
  const inlined = summaries.reduce((sum, summary) => sum + summary.inlined, 0)
  const dropped = summaries.reduce((sum, summary) => sum + summary.droppedDeclarations, 0)
  const renamed = summaries.flatMap((summary) => summary.renamed)
  const skipped = summaries.flatMap((summary) => summary.skipped)
  const stylesheet = summaries.find((summary) => summary.stylesheet !== null)?.stylesheet ?? null
  if (rules === 0 && inlined === 0 && skipped.length === 0 && dropped === 0) return null

  const title =
    rules > 0 && stylesheet
      ? `Pasted - ${plural(rules, 'style rule')} added to ${stylesheet.slice(stylesheet.lastIndexOf('/') + 1)}`
      : inlined > 0
        ? `Pasted - ${plural(inlined, 'style rule')} written on the elements (this page imports no stylesheet)`
        : 'Pasted - some of its styles were left out'
  const body = [
    renamed.length > 0
      ? `Renamed ${listed(renamed.map((entry) => `.${entry.from} to .${entry.to}`))} so the ${renamed.length === 1 ? 'class' : 'classes'} you already have stay${renamed.length === 1 ? 's' : ''} as ${renamed.length === 1 ? 'it is' : 'they are'}.`
      : null,
    skipped.length > 0
      ? `Not written because they would restyle more than the pasted elements: ${listed(skipped)}.`
      : null,
    dropped > 0 ? `${plural(dropped, 'declaration')} left out (scripts or external resources).` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
  return body ? { title, body } : { title }
}

export function announcePastedStyles(summaries: StudioSaveResponse['pastedHtml']): void {
  const notice = summaries ? pastedStylesNotice(summaries) : null
  if (notice) announceUndoableNotice(notice.title, notice.body)
}
