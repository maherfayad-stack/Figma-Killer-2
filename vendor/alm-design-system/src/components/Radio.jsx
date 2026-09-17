import { forwardRef, useId } from 'react'
import './Radio.css'

export const Radio = forwardRef(function Radio({
  checked,
  disabled = false,
  error = false,
  skeleton = false,
  name,
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
    'radio',
    disabled && 'radio--disabled',
    error && 'radio--error',
    skeleton && 'radio--skeleton',
    checked && 'radio--checked',
    className,
  ].filter(Boolean).join(' ')

  if (skeleton) {
    return <span className={cls} dir={dir} {...props} />
  }

  return (
    <span className={cls} dir={dir} {...props}>
      <input
        ref={ref}
        type="radio"
        id={id}
        className="radio__input"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
      />
      <span className="radio__circle" aria-hidden="true">
        <span className="radio__dot" />
      </span>
    </span>
  )
})
