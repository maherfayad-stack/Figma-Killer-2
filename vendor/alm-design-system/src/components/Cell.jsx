import './Cell.css'
import { Toggle } from './Toggle'
import { Stepper } from './Stepper'
import { Separator } from './Separator'
import { Tag } from './Tag'
import { ChevronRightIcon, ChevronLeftIcon } from '../icons/LineIcons'

export function Cell({
  visual = 'icon',
  icon = null,
  iconSrc,
  title,
  label,
  subtext,
  value,
  sideIcon,
  sideIconSrc,
  tag,
  trailing = 'chevron',
  toggleChecked = false,
  onToggleChange,
  stepperValue = 0,
  stepperMin = 0,
  stepperMax,
  onStepperChange,
  selected = false,
  showSeparator = true,
  className = '',
  dir,
  ...rest
}) {
  const isRtl = dir === 'rtl'
  const cls = ['cell', selected && 'cell--selected', className].filter(Boolean).join(' ')

  const Chevron = (props) => isRtl
    ? <ChevronLeftIcon className="cell__chevron" {...props} />
    : <ChevronRightIcon className="cell__chevron" {...props} />

  const resolvedIcon = iconSrc
    ? <img src={iconSrc} alt="" className="cell__visual-img" />
    : typeof icon === 'string'
      ? <img src={icon} alt="" className="cell__visual-img" />
      : icon

  const resolvedSideIcon = sideIconSrc
    ? <img src={sideIconSrc} alt="" className="cell__visual-img" />
    : sideIcon

  const hasTrailing = trailing !== 'none' && (trailing === 'chevron' || trailing === 'toggle' || trailing === 'stepper' || value || resolvedSideIcon || tag)

  return (
    <div className={cls} dir={dir} {...rest}>
      <div className="cell__row">
        {visual && (
          <div className={`cell__visual cell__visual--${visual}`}>
            {resolvedIcon}
          </div>
        )}
        <div className="cell__content">
          {title && <span className="cell__title type-caption-regular">{title}</span>}
          {label && <span className="cell__label type-body-regular">{label}</span>}
          {subtext && <span className="cell__subtext type-caption-regular">{subtext}</span>}
        </div>
        {hasTrailing && (
          <div className="cell__trailing">
            {value && <span className="cell__trailing-value type-caption-regular">{value}</span>}
            {resolvedSideIcon && <span className="cell__trailing-icon">{resolvedSideIcon}</span>}
            {tag && <Tag {...(typeof tag === 'string' ? { label: tag } : tag)} />}
            {trailing === 'chevron' && <Chevron />}
            {trailing === 'toggle' && (
              <Toggle
                label={null}
                checked={toggleChecked}
                onChange={onToggleChange}
                dir={dir}
                className="cell__toggle"
              />
            )}
            {trailing === 'stepper' && (
              <Stepper
                value={stepperValue}
                min={stepperMin}
                max={stepperMax}
                onChange={onStepperChange}
                dir={dir}
                className="cell__stepper"
              />
            )}
          </div>
        )}
      </div>
      {showSeparator && <Separator />}
    </div>
  )
}
