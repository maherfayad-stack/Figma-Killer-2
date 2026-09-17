import { forwardRef } from 'react'
import { usePlatform, useDir } from '../context/DesignSystemContext'
import './Toggle.css'

export const Toggle = forwardRef(function Toggle({
  platform,
  state = 'default',
  checked = false,
  label = 'Label',
  dir,
  onChange,
  className = '',
  ...props
}, ref) {
  const p = usePlatform(platform)   // prop > provider > "ios"
  const d = useDir(dir)             // prop > provider > "ltr"

  const cls = [
    'toggle',
    `toggle--${p}`,
    state !== 'default' && `toggle--${state}`,
    checked && 'toggle--checked',
    className,
  ].filter(Boolean).join(' ')

  if (state === 'skeleton') {
    return (
      <div className={cls} dir={d} {...props}>
        <div className="toggle__skeleton-label" />
        <div className="toggle__skeleton-track" />
      </div>
    )
  }

  return (
    <label className={cls} dir={d} {...props}>
      {label && <span className="toggle__label">{label}</span>}
      <input
        ref={ref}
        type="checkbox"
        className="toggle__input"
        checked={checked}
        disabled={state === 'disabled'}
        onChange={onChange}
      />
      <span className="toggle__track">
        <span className="toggle__knob" />
      </span>
    </label>
  )
})
