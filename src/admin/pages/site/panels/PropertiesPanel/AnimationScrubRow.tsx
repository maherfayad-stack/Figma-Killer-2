/**
 * AnimationScrubRow — the timeline control under the Animations list.
 *
 * Two gestures, both driving machinery that already existed:
 *
 *   - the **scrub** sets `animationScrubStore`'s progress, which
 *     `CanvasAnimationInjector` turns into the negative-delay-on-a-paused-
 *     animation rule it documents under "Freeze point". Every design frame on
 *     the board moves together, because the freeze is a `*` rule per frame and
 *     the scrub is one value shared by all of them.
 *   - **Play once** replays every animation from its first keyframe at its
 *     authored speed and leaves it settled on its last — the two-phase
 *     sequence in `animationScrubStore.ts`.
 *
 * ## Why a native range input
 *
 * `src/ui/components/` has no slider primitive, and this pass does not add one
 * — the same call `TypographySettings.tsx` made and documented for the
 * variable-font axes. The difference is that a bounded number field was an
 * honest substitute THERE and is not here: scrubbing a timeline is a drag
 * along a track, and a field you type `0.4` into is a different control for a
 * different task. A native `<input type="range">` is the real thing, is a
 * `slider` to assistive technology without any ARIA of our own, and answers
 * arrow keys, Home and End for free.
 *
 * ## `prefers-reduced-motion`
 *
 * The editor's own chrome here has no motion at all — no animated thumb, no
 * transitioned fill; the one hover/active tone change is gated in the module's
 * reduced-motion block. Playback itself is left available: a user who asks for
 * reduced motion is asking not to be moved WITHOUT having asked, and pressing
 * a button labelled "Play once" is asking. Nothing here plays on its own — not
 * on mount, not on selection, not on edit.
 */
import { useState, type ChangeEvent } from 'react'
import { Button } from '@ui/components/Button'
import {
  clearCanvasAnimationScrub,
  playCanvasAnimationsOnce,
  setCanvasAnimationScrub,
  useCanvasAnimationScrub,
} from '@site/canvas/animationScrubStore'
import styles from './AnimationsSection.module.css'

/** Steps per full timeline — 1% is finer than the eye resolves on a 200 ms fade and coarse enough to arrow through. */
const SCRUB_STEPS = 100

export function AnimationScrubRow() {
  const { progress, phase } = useCanvasAnimationScrub()
  // The slider's own position while nothing is being scrubbed. Held locally so
  // releasing the scrub (which is what "Play once" does) does not snap the
  // handle back to 0 and make the control look broken.
  const [handle, setHandle] = useState(0)
  const value = progress ?? handle

  function handleScrub(event: ChangeEvent<HTMLInputElement>) {
    const next = Number(event.target.value) / SCRUB_STEPS
    if (!Number.isFinite(next)) return
    setHandle(next)
    setCanvasAnimationScrub(next)
  }

  return (
    <div className={styles.scrubRow}>
      <input
        type="range"
        className={styles.scrubTrack}
        min={0}
        max={SCRUB_STEPS}
        step={1}
        value={Math.round(value * SCRUB_STEPS)}
        aria-label="Animation progress"
        aria-valuetext={`${Math.round(value * 100)} percent`}
        data-testid="animation-scrub"
        onChange={handleScrub}
      />
      <span className={styles.scrubValue}>{Math.round(value * 100)}%</span>
      <Button
        variant="ghost"
        size="xs"
        data-testid="animation-play-once"
        aria-label="Play animations once"
        tooltip="Play every animation on this board once"
        loading={phase !== 'idle'}
        onClick={playCanvasAnimationsOnce}
      >
        Play
      </Button>
      <Button
        variant="ghost"
        size="xs"
        data-testid="animation-scrub-release"
        aria-label="Stop holding animations at this point"
        tooltip="Back to each frame's own resting point"
        disabled={progress === null}
        onClick={clearCanvasAnimationScrub}
      >
        Reset
      </Button>
    </div>
  )
}
