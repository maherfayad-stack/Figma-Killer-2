import './Stepper.css'
import { PlusCircleIcon, MinusCircleIcon } from '../icons/LineIcons'

export function Stepper({
  value = 0,
  min = 0,
  max,
  onChange,
  dir = 'ltr',
  className = '',
  ...props
}) {
  const atMin = value <= min
  const atMax = max !== undefined && value >= max

  const decrement = () => { if (!atMin) onChange?.(value - 1) }
  const increment = () => { if (!atMax) onChange?.(value + 1) }

  const cls = ['stepper', className].filter(Boolean).join(' ')

  const minusBtn = (
    <button
      type="button"
      className="stepper__btn"
      onClick={decrement}
      disabled={atMin}
      aria-label="Decrease"
    >
      <MinusCircleIcon className="stepper__icon" />
    </button>
  )

  const plusBtn = (
    <button
      type="button"
      className="stepper__btn"
      onClick={increment}
      disabled={atMax}
      aria-label="Increase"
    >
      <PlusCircleIcon className="stepper__icon" />
    </button>
  )

  return (
    <div className={cls} dir={dir} {...props}>
      {dir === 'rtl' ? plusBtn : minusBtn}
      <span className="stepper__value">{value}</span>
      {dir === 'rtl' ? minusBtn : plusBtn}
    </div>
  )
}
