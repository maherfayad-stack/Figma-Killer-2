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
 */
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { EmptyState } from '@ui/components/EmptyState'
import styles from './CanvasEmptyPageHint.module.css'

export function CanvasEmptyPageHint() {
  return (
    <div className={styles.hint} data-testid="canvas-empty-page-hint">
      <EmptyState
        variant="centered"
        plain
        icon={<AppGridPlusGlyphIcon size={22} aria-hidden="true" />}
        title="This page is empty."
        description="Add the first element from the toolbar’s Add button, or drop one in from the insert palette."
      />
    </div>
  )
}
