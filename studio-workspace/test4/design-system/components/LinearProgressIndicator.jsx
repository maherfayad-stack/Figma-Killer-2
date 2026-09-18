import { usePlatform, useDir } from '../context/DesignSystemContext'
import './LinearProgressIndicator.css'

/**
 * LinearProgressIndicator — platform-aware determinate progress bar.
 *
 * One public component; the platform is a single input resolved through
 * usePlatform (prop > DesignSystemProvider > "ios"). Both platforms share the
 * same shell + `role="progressbar"` a11y contract and differ in markup:
 *
 *   - ios     → a flat 6px rounded track with an aqua fill that grows from the
 *               leading edge (shows a small dot at 0%).
 *   - android → Material 3: an aqua active bar, a gap, and a flat remaining
 *               track, with an aqua "stop" dot pinned to the trailing end while
 *               the process is incomplete.
 *
 * `value` is a 0–100 percentage. RTL flips the growth direction (and the stop
 * dot side) via the `dir` prop.
 */

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0))

// ── iOS ────────────────────────────────────────────────────────────────
const IOS = ({ pct }) => (
  <div className="lpi__track">
    <div className="lpi__fill" style={{ width: `${pct}%` }} />
  </div>
)

// ── Android (Material 3) ───────────────────────────────────────────────
const Android = ({ pct }) => (
  <>
    {pct > 0 && <div className="lpi__active" style={{ width: `${pct}%` }} />}
    {pct < 100 && <div className="lpi__remaining" />}
    {pct < 100 && <span className="lpi__stop" />}
  </>
)

export function LinearProgressIndicator({
  value = 0,
  platform,
  dir,
  className = '',
  'aria-label': ariaLabel,
  ...props
}) {
  const p = usePlatform(platform)
  const d = useDir(dir)
  const pct = clamp(value)

  const cls = ['lpi', `lpi--${p}`, className].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      role="progressbar"
      dir={d}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel || 'Progress'}
      {...props}
    >
      {p === 'android' ? <Android pct={pct} /> : <IOS pct={pct} />}
    </div>
  )
}
