import { usePlatform, useDir } from '../context/DesignSystemContext'
import './SegmentedControl.css'

// The iOS and Android segmented controls share the exact same DOM
// (a tablist of equal-width segment buttons); only the styling differs —
// iOS floats a white pill over a tinted track, Android draws joined,
// outlined Material buttons. So the platform is resolved through the shared
// hook (per the platform-variant model) and expressed as a modifier class
// rather than splitting into structurally distinct per-platform renders.
export function SegmentedControl({
  items = [],
  value = 0,
  onChange,
  platform,
  dir,
  className = '',
  ...props
}) {
  const p = usePlatform(platform)
  const d = useDir(dir)

  const cls = ['seg-control', `seg-control--${p}`, className].filter(Boolean).join(' ')

  return (
    <div className={cls} role="tablist" dir={d} {...props}>
      {items.map((label, i) => {
        const isActive = i === value

        return (
          <button
            key={i}
            role="tab"
            aria-selected={isActive}
            className={['seg-control__segment', isActive && 'seg-control__segment--active'].filter(Boolean).join(' ')}
            onClick={() => onChange?.(i)}
            type="button"
          >
            <span className="seg-control__segment-inner">
              <span className="seg-control__label">{label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
