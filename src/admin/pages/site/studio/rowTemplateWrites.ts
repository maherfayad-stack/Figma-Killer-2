/**
 * rowTemplateWrites — a `.map` row's style or class edit, written to the row
 * TEMPLATE (P3-C, OD-8).
 *
 * A row has no source location of its own (`…:14:9#2`): one piece of JSX
 * renders every row. Its style and class edits used to be refused for exactly
 * that reason. The owner's call (OD-8) is that restyling a list item means
 * restyling the list, so they are written to the template (`…:14:9`, see
 * `loopTemplateNodeId`) — one honest JSX site — and the editor is plain about
 * the blast radius: the panel says so before the edit (`SourceConstraintNotice`),
 * and this module says so once the write lands. The save then re-reads the
 * page so every row shows what was written, not just the one the user touched.
 *
 * What never goes to the template: a row's TEXT and origin-backed props (each
 * row read its own array element, and writes there), its literal attributes
 * (read-only), and anything structural (the array literal's business, P3-D).
 */
import { loopTemplateNodeId, type Page } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'

/**
 * One row edit sent to its template, which renders `rowCount` rows. `editKey`
 * is the edit's outcome key, so the caller can tell which of these landed.
 */
export interface RowTemplateWrite {
  editKey: string
  /** The ROW the edit was made on — a refused template write holds back its baseline. */
  nodeId: string
  templateId: string
  rowCount: number
}

/** How many rows of `page` one template renders — the `N` in "applied to all N rows". */
export function rowsOfTemplate(page: Page, templateId: string): number {
  let count = 0
  for (const id of Object.keys(page.nodes)) if (loopTemplateNodeId(id) === templateId) count += 1
  return count
}

/**
 * Says, once per template, that a row edit landed on every row. An `info`
 * notice, not a warning: nothing was refused, and the panel said this would
 * happen before the edit. `⌘Z` undoes it like any other edit — named rather
 * than offered as a button, because by the time this appears (after the
 * autosave) the most recent history entry may be something else entirely.
 */
export function notifyRowTemplateWrites(landed: readonly RowTemplateWrite[]): void {
  const byTemplate = new Map<string, number>()
  for (const write of landed) byTemplate.set(write.templateId, Math.max(byTemplate.get(write.templateId) ?? 0, write.rowCount))
  for (const rowCount of byTemplate.values()) {
    pushToast({
      kind: 'info',
      title: rowCount > 1 ? `Applied to all ${rowCount} rows` : 'Applied to the list’s row',
      body: 'Every row of this list is rendered by one piece of source, so the change was written there. ⌘Z undoes it.',
    })
  }
}
