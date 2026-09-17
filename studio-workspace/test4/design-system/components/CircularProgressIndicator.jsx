import { usePlatform, useDir } from '../context/DesignSystemContext'
import './CircularProgressIndicator.css'

/**
 * CircularProgressIndicator — platform-aware indeterminate loading spinner.
 *
 * One public component; the platform is a single input resolved through
 * usePlatform (prop > DesignSystemProvider > "ios"). The two platforms share
 * the same shell + a11y contract and differ in the rendered SVG:
 *
 *   - android → Material 3 spinner: an 80%-sweep aqua arc rotating at a
 *               constant speed.
 *   - ios     → UIActivityIndicatorView (the spinner UIRefreshControl renders):
 *               8 tapering gray teeth that fade around a small hub.
 *
 * Pass `label` to render a status row (spinner + text), e.g. "Loading results…".
 */

// Android (Material 3) — diameter + arc thickness (4dp / 8dp).
const ANDROID_SIZES = {
  default: { d: 40, stroke: 4 },
  large: { d: 48, stroke: 8 },
}

// iOS (UIActivityIndicatorView) — native container sizes.
const IOS_SIZES = { default: 24, large: 40 }
const IOS_SPOKES = 8

// Fraction of the circle the Android arc covers.
const ARC_SWEEP = 0.8

// ── Android (Material 3) ───────────────────────────────────────────────
const Android = ({ size }) => {
  const { d, stroke } = ANDROID_SIZES[size]
  const r = (d - stroke) / 2
  const c = 2 * Math.PI * r
  const cx = d / 2

  // Active arc + complementary track, separated by a ~2px gap on each end.
  // Round caps bulge stroke/2 into the gap, so add `stroke` to the 2px centerline gap.
  const gap = stroke + 2
  const active = c * ARC_SWEEP
  const track = c - active - 2 * gap

  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="cpi__svg cpi__svg--spin-android">
      <circle
        className="cpi__track"
        cx={cx}
        cy={cx}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${track} ${c - track}`}
        strokeDashoffset={-(active + gap)}
      />
      <circle
        className="cpi__arc"
        cx={cx}
        cy={cx}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${active} ${c - active}`}
      />
    </svg>
  )
}

// ── iOS (UIActivityIndicatorView) ──────────────────────────────────────
// 8 capsule teeth in a 24-unit box (artwork is the 22px Figma group offset by
// the 4.17% inset). Each tooth runs from radius 11 (outer, at the edge) inward
// over a length of 7.25; the opacity ramp fades counter-clockwise from the top.
const IOS = ({ size }) => {
  const d = IOS_SIZES[size]
  const cx = 12
  const w = 3
  const top = 1
  const len = 7.25

  return (
    <svg width={d} height={d} viewBox="0 0 24 24" className="cpi__svg cpi__svg--spin-ios">
      {Array.from({ length: IOS_SPOKES }, (_, i) => (
        <rect
          key={i}
          x={cx - w / 2}
          y={top}
          width={w}
          height={len}
          rx={w / 2}
          fill="currentColor"
          transform={`rotate(${i * (360 / IOS_SPOKES)} ${cx} ${cx})`}
          style={{ opacity: (i === 0 ? IOS_SPOKES : i) / IOS_SPOKES }}
        />
      ))}
    </svg>
  )
}

export function CircularProgressIndicator({
  platform,
  size = 'default',
  label,
  dir,
  className = '',
  'aria-label': ariaLabel,
  ...props
}) {
  const p = usePlatform(platform)
  const d = useDir(dir)
  const showLabel = typeof label === 'string' && label.length > 0

  const cls = [
    'cpi',
    `cpi--${p}`,
    `cpi--${size}`,
    showLabel && 'cpi--with-label',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      role="progressbar"
      dir={d}
      aria-label={ariaLabel || label || 'Loading'}
      {...props}
    >
      {p === 'android' ? <Android size={size} /> : <IOS size={size} />}
      {showLabel && <span className="cpi__label">{label}</span>}
    </div>
  )
}
