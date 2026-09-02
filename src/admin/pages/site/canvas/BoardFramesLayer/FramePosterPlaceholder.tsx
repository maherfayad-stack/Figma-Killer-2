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
import styles from './BoardFramesLayer.module.css'

interface FramePosterPlaceholderProps {
  title: string
  posterUrl: string | undefined
}

export const FramePosterPlaceholder = memo(function FramePosterPlaceholder({
  title,
  posterUrl,
}: FramePosterPlaceholderProps) {
  if (posterUrl) {
    return (
      <img
        className={styles.offscreenPlaceholderImage}
        data-testid="board-frame-poster"
        src={posterUrl}
        alt=""
        draggable={false}
      />
    )
  }
  return (
    <div className={styles.offscreenPlaceholder} data-testid="board-frame-placeholder">
      <span className={styles.offscreenPlaceholderTitle}>{title}</span>
    </div>
  )
})
