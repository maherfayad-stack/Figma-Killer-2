/**
 * CanvasEmptyPageHint — what a frame says when its page has nothing on it.
 *
 * ## The gap this fills
 *
 * A page whose `base.body` has no children renders as a blank rectangle. That
 * is a truthful drawing of an empty page and a useless one to arrive at: there
 * is no selection to make, so the Properties panel is empty, the DOM panel is
 * empty, and the one control that would change any of it — the insert
 * affordance — is on the toolbar, several hundred pixels away and never
 * pointed at. A first-time user's own reading of that screen is "it did not
 * load".
 *
 * ## Why it is drawn OUTSIDE the iframe
 *
 * Every frame's content renders inside its own iframe, which carries the
 * user's stylesheets and nothing of Studio's. An `EmptyState` mounted in there
 * would arrive unstyled and, worse, would be a Studio element inside the
 * document the parser reads back. This is a sibling of the iframe in the
 * EDITOR's document, absolutely positioned over the frame body — the same
 * place `BoardFrameView`'s resize handles live, for the same reason.
 *
 * `pointer-events: none` on the root: the hint must never eat a click meant
 * for the frame under it (a drop from the insert palette, a marquee started
 * over an empty page). The one thing inside it that IS clickable re-enables
 * them for itself.
 *
 * ## When it shows
 *
 * `pageHasNoContent` (`./canvasEmptyPage.ts`), and nothing else — no "is this
 * project new", no dismissal, no first-run flag. A page that gains a node
 * loses the hint immediately, and a page emptied by deleting its last element
 * gets it back, which is correct both times: the hint is a statement about the
 * page, not about the user.
 *
 * ## …unless the page is not empty at all (P3-B, WB-5)
 *
 * An imported page whose default export the parser cannot read a component out
 * of (`lazy(…)`, a component imported from another file, a class with no JSX
 * `render()`) also arrives with no nodes — and "This page is empty. Add the
 * first element" would be false twice: the page has content, and adding an
 * element here would write into a file whose real component Studio never
 * showed. The load names that shape (`unreadable-page-export`, via
 * `studioLoadWarningsStore.ts`), and the hint says it instead.
 */
import { useSyncExternalStore } from 'react'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { EmptyState } from '@ui/components/EmptyState'
import {
  getStudioLoadWarnings,
  subscribeStudioLoadWarnings,
  unreadablePageExportMessage,
} from '../studio/studioLoadWarningsStore'
import styles from './CanvasEmptyPageHint.module.css'

export function CanvasEmptyPageHint({ pageId }: { pageId: string }) {
  const warnings = useSyncExternalStore(subscribeStudioLoadWarnings, getStudioLoadWarnings)
  const unreadable = unreadablePageExportMessage(warnings, pageId)
  return (
    <div className={styles.hint} data-testid="canvas-empty-page-hint">
      {unreadable ? (
        <EmptyState
          variant="centered"
          plain
          icon={<CodeIcon size={22} aria-hidden="true" />}
          title="Studio can’t draw this page from its code."
          description={`${unreadable} Open the file in your editor to change it.`}
        />
      ) : (
        <EmptyState
          variant="centered"
          plain
          icon={<AppGridPlusGlyphIcon size={22} aria-hidden="true" />}
          title="This page is empty."
          description="Add the first element from the toolbar’s Add button, or drop one in from the insert palette."
        />
      )}
    </div>
  )
}
