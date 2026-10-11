/**
 * studioHtmlWrites - pasting HTML onto a studio-imported tree (G-10).
 *
 * `HTML_IMPORT_ON_SOURCE_REFUSAL` used to stop every one of these ("a block of
 * HTML has no single honest form to write there"). It has one: the markup is
 * converted to intrinsic JSX (`htmlToJsx.ts`) and written as ONE `insert` whose
 * `pastedHtml` carries the CSS that came with it, and the server puts the two
 * halves where each has exactly one honest target - the elements in the
 * container the user pointed at, the styles in the page's own stylesheet
 * (`studioInsertHtml.ts`). One write, one resync, one journaled undo step.
 *
 * Same contract as every other writer next door (`studioSourceWrites.ts`):
 *
 *   1. Ask `structuralSourceEdits.ts` whether the source can take the gesture.
 *   2. Refused -> say why out loud and STOP; nothing changes.
 *   3. An ordinary CMS tree -> `{ kind: 'cms' }`; the caller takes its normal
 *      in-memory import, untouched.
 *   4. Otherwise post the write and STOP. The board is not updated here and no
 *      node id is returned: the elements do not exist until the codemod has
 *      written them, and their ids are the `line:col`s it produces. The commit's
 *      own resync brings them in and selects them.
 */
import { describeStructuralRefusal, type NodeTree, type PageNode } from '@core/page-tree'
import { htmlToJsx, pinPastedRoots } from '@site/studio/htmlToJsx'
import { announceLeftOut, announcePastedStyles } from '@site/studio/pastedHtmlNotice'
import { commitStudioInsert } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import type { StudioSaveResponse } from '@site/studio/studioSaveRequests'
import { STRUCTURAL_REFUSAL_TITLE, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import type { HtmlSourceWriteResult, PasteHtmlOptions } from './htmlSourceWriteResult'
import type { SiteSliceHelpers } from './types'

export function createStudioHtmlWrite(
  helpers: SiteSliceHelpers,
  readTree: () => NodeTree<PageNode> | null,
): (html: string, parentId: string, options?: PasteHtmlOptions) => HtmlSourceWriteResult {
  const { get, set } = helpers

  const refuse = (message: string): HtmlSourceWriteResult => {
    // Always `actions: []` - always the toast, never the dialog: the remedy is
    // a different paste, not a button on a node.
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.insert,
      describeStructuralRefusal({ refusal: { reason: 'insert', message } }),
      { getState: get, set },
    )
    return { kind: 'refused', message }
  }

  const writeHtmlToSource = (html: string, parentId: string, options: PasteHtmlOptions = {}): HtmlSourceWriteResult => {
    const tree = readTree()
    if (!tree) return { kind: 'cms' }
    // `commit: null` is an ordinary CMS container - and the only outcome that may
    // take the in-memory import. A refused container is refused below.
    const probe = planSourceInsert(tree, parentId, options.index)
    if (probe.ok && !probe.commit) return { kind: 'cms' }

    const converted = htmlToJsx(html)
    if (!converted.ok) return refuse(converted.message)

    // `store-14` - a paste fired while a structural write is on the wire runs
    // NEXT, re-planned against the tree that write's resync leaves.
    if (
      deferWhileStructuralCommitInFlight((relocate) => {
        writeHtmlToSource(html, relocate(parentId), options)
      }, [parentId])
    ) {
      return { kind: 'written', report: converted.report }
    }

    const plan = planSourceInsert(tree, parentId, options.index)
    if (!plan.ok) {
      presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
        nodeId: plan.nodeId,
        retry: (mapId) => { writeHtmlToSource(html, mapId(parentId), options) },
        getState: get,
        set,
      })
      return { kind: 'refused', message: plan.constraint.explanation }
    }
    if (!plan.commit) return { kind: 'cms' }

    const placed = options.absolute ? pinPastedRoots(converted.nodes, options.absolute) : converted.nodes
    const [first, ...rest] = placed
    let answer: StudioSaveResponse | undefined
    void commitStudioInsert({
      ...plan.commit,
      name: first!.name,
      props: first!.props ?? {},
      ...(first!.children === undefined ? {} : { children: first!.children }),
      ...(rest.length > 0 ? { siblings: rest } : {}),
      pastedHtml: { css: converted.css },
      undoLabel: options.undoLabel ?? 'Paste HTML',
      onAnswer: (next) => { answer = next },
      onLanded: () => announcePastedStyles(answer?.pastedHtml),
    })
    announceLeftOut(converted.report)
    return { kind: 'written', report: converted.report }
  }

  return writeHtmlToSource
}
