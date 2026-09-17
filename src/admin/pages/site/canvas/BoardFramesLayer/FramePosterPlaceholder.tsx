/**
 * FramePosterPlaceholder — an offscreen board frame's body (WS-5.3): either
 * a frozen poster of the frame's last-settled content, or (before any
 * capture has landed) the plain title stand-in `BoardFramesLayer` always
 * rendered.
 *
 * Wrapped in `React.memo` — CLAUDE.md's documented exception 2 (hot,
 * list-rendered, O(N) critical path): `BoardFramesLayer` re-renders every
 * `zoom`/`panX`/`panY` store commit (still just the ~100ms debounce
 * `useCanvas.ts` already applies, not per pointermove — see WS-5.4), and at
 * a typical zoomed-out view MOST of a 50-frame board's frames are offscreen
 * placeholders. Without this bailout, every one of them — including the
 * `<img>` element, which the browser can re-decode on prop churn — would
 * re-render on every pan tick even though neither `title` nor `posterUrl`
 * changed. `title`/`posterUrl` are primitive strings, so the default
 * shallow-prop comparison is exact, not an approximation.
 */
import { memo } from 'react'
import { cn } from '@ui/cn'
import styles from './BoardFramesLayer.module.css'

interface FramePosterPlaceholderProps {
  title: string
  posterUrl: string | undefined
}

/**
 * `overlay` (S1) — the same poster, painted ON TOP of a live iframe whose
 * staged mount has not reached its node tree yet, rather than INSTEAD of an
 * iframe that isn't there. It carries its own testids so a count of "frames
 * standing in for a live iframe" stays honest: an overlay is never a
 * substitute for a frame, it is a frame that has not finished arriving.
 */
type FramePosterPlaceholderRenderProps = FramePosterPlaceholderProps & { overlay?: boolean }

export const FramePosterPlaceholder = memo(function FramePosterPlaceholder({
  title,
  posterUrl,
  overlay = false,
}: FramePosterPlaceholderRenderProps) {
  if (posterUrl) {
    return (
      <img
        className={cn(styles.offscreenPlaceholderImage, overlay && styles.mountOverlay)}
        data-testid={overlay ? 'board-frame-poster-overlay' : 'board-frame-poster'}
        src={posterUrl}
        alt=""
        draggable={false}
      />
    )
  }
  return (
    <div
      className={cn(styles.offscreenPlaceholder, overlay && styles.mountOverlay)}
      data-testid={overlay ? 'board-frame-placeholder-overlay' : 'board-frame-placeholder'}
    >
      <span className={styles.offscreenPlaceholderTitle}>{title}</span>
    </div>
  )
})
