/**
 * DeviceMockup — the physical device drawn around live mode's frame.
 *
 * Wraps the live iframe viewport in a bezel, rounds the screen's corners, and
 * adds the furniture a real device has (a phone's dynamic island and home
 * indicator). `kind === null` renders `children` untouched, with no wrapper
 * element at all — so a desktop breakpoint is byte-identical to what live mode
 * rendered before this existed.
 *
 * ## Three properties this must not break
 *
 * **The page keeps its exact breakpoint width.** The bezel is a `box-shadow`
 * spread, not padding or a border, so it is painted outside the screen box and
 * costs zero layout width. Live mode's whole point is that 375px means 375px;
 * a bezel that ate 12px off each side would quietly make it 351px and every
 * media query near the boundary would answer differently here than on a real
 * phone.
 *
 * **Live mode stays editable.** This is not a read-only preview — click to
 * select, the properties panel, and structural edits all work in live mode. So
 * every piece of chrome here is `pointer-events: none`; the island sits over
 * the top of the page and must not swallow a click meant for the node beneath
 * it.
 *
 * **Selection geometry is unaffected.** `BreakpointSelectionOverlay` measures
 * the viewport element that `CanvasLiveSurface` owns and passes in as
 * `children`. This wraps that element rather than replacing or re-parenting
 * what it measures, and the wrapper adds no padding, so the viewport's rect is
 * the same box it was.
 *
 * ## The island genuinely covers content
 *
 * That is the point of drawing it. An iPhone's dynamic island occludes the top
 * of the screen, and a header that collides with it is a real bug that a bare
 * 375px strip will never show you. It is chrome, so it never intercepts a
 * click — but it does sit visibly on top, exactly as the hardware does.
 */

import type { CSSProperties, ReactNode } from 'react'
import { DEVICE_BEZEL_PX, type DeviceKind } from './deviceKind'
import styles from './DeviceMockup.module.css'

interface DeviceMockupProps {
  /** `null` renders `children` bare — no wrapper, no chrome. */
  kind: DeviceKind | null
  children: ReactNode
}

export function DeviceMockup({ kind, children }: DeviceMockupProps) {
  if (!kind) return <>{children}</>
  return (
    <div
      className={styles.device}
      data-device={kind}
      // Set here, not in the stylesheet, so `DEVICE_BEZEL_PX` stays the one
      // source of truth: `CanvasLiveSurface` subtracts the same number when
      // fitting the mockup, and a bezel drawn one width and reserved another
      // would clip on exactly the narrow windows that need it most.
      style={{ '--device-bezel': `${DEVICE_BEZEL_PX[kind]}px` } as CSSProperties}
    >
      {children}
      {/* Chrome is a sibling of the viewport, not a child: the viewport owns
          the iframe and the selection overlay, and nothing decorative belongs
          inside a box something else measures. */}
      {kind === 'phone' && <span className={styles.island} aria-hidden="true" />}
      <span className={styles.homeIndicator} aria-hidden="true" />
    </div>
  )
}
