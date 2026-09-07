/**
 * canvasEmptyPage — the one predicate `CanvasEmptyPageHint` is shown by.
 *
 * Its own module rather than an export beside the component: a file that
 * exports both a component and a plain function is not fast-refreshable
 * (`react-refresh/only-export-components`), and this is the half `BoardFrameView`
 * calls before deciding to render the other half at all.
 */
import type { Page } from '@core/page-tree'

/**
 * True when the page's root `base.body` has no children.
 *
 * Deliberately the shallowest possible test. "No user content" could mean a
 * dozen richer things — only hidden nodes, only an empty wrapper, only a slot
 * with nothing in it — and every one of them is a judgement this hint has no
 * business making: a page with one empty `<div>` on it is a page someone is
 * working on. A missing root node reads as empty too, because there is nothing
 * to draw either way.
 */
export function pageHasNoContent(page: Page): boolean {
  return (page.nodes[page.rootNodeId]?.children.length ?? 0) === 0
}
