import { forwardRef, useId } from 'react'
import './Checkbox.css'

export const Checkbox = forwardRef(function Checkbox({
  checked,
  disabled = false,
  error = false,
  skeleton = false,
  dir = 'ltr',
  id: idProp,
  onChange,
  className = '',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  ...props
}, ref) {
  const uid = useId()
  const id = idProp ?? uid

  const cls = [
    'checkbox',
    disabled && 'checkbox--disabled',
    error && 'checkbox--error',
    skeleton && 'checkbox--skeleton',
    checked && 'checkbox--checked',
    className,
  ].filter(Boolean).join(' ')

  if (skeleton) {
    return <span className={cls} dir={dir} {...props} />
  }

  return (
    <span className={cls} dir={dir} {...props}>
      <input
        ref={ref}
        type="checkbox"
        id={id}
        className="checkbox__input"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
      />
      <span className="checkbox__box" aria-hidden="true">
        <svg className="checkbox__check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M7 12L10.5 15.5L17 8.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  )
})
