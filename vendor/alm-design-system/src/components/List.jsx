import { useId } from 'react'
import './List.css'
import { Checkbox } from './Checkbox'
import { Radio } from './Radio'
import { Tag } from './Tag'
import { PlaceholderIcon } from '../icons/LineIcons'

export function ListItem({
  type = 'icon',
  selected = false,
  disabled = false,
  error = false,
  skeleton = false,
  label = 'Label',
  keyValue = null,
  tag = null,
  icon = null,
  dir = 'ltr',
  id,
  name,
  onChange,
  className = '',
  ...props
}) {
  const uid = useId()
  const inputId = id ?? uid
  const isControl = type === 'checkbox' || type === 'radio'

  const cls = [
    'list-item',
    `list-item--${type}`,
    disabled && 'list-item--disabled',
    error && 'list-item--error',
    skeleton && 'list-item--skeleton',
    selected && type === 'icon' && 'list-item--selected',
    className,
  ].filter(Boolean).join(' ')

  if (skeleton) {
    const marker =
      type === 'checkbox' ? <Checkbox skeleton />
      : type === 'radio' ? <Radio skeleton />
      : <div className="list-item__skeleton-marker" />
    return (
      <div className={cls} dir={dir} {...props}>
        {marker}
        <div className="list-item__skeleton-bar" />
      </div>
    )
  }

  let leading = null
  if (type === 'icon') {
    leading = (
      <div className="list-item__icon">
        {icon || <PlaceholderIcon className="list-item__default-icon" />}
      </div>
    )
  } else if (type === 'checkbox') {
    leading = (
      <Checkbox
        checked={selected}
        disabled={disabled}
        error={error}
        id={inputId}
        onChange={onChange}
        dir={dir}
      />
    )
  } else if (type === 'radio') {
    leading = (
      <Radio
        checked={selected}
        disabled={disabled}
        error={error}
        name={name}
        id={inputId}
        onChange={onChange}
        dir={dir}
      />
    )
  }

  const content = (
    <>
      {leading}

      <span className="list-item__label">{label}</span>

      {(tag != null || keyValue != null) && (
        <div className="list-item__trailing">
          {tag != null && (
            <Tag {...(typeof tag === 'string' ? { label: tag } : tag)} />
          )}
          {keyValue != null && (
            <span className="list-item__key-value">{keyValue}</span>
          )}
        </div>
      )}
    </>
  )

  if (isControl) {
    return (
      <label className={cls} dir={dir} htmlFor={inputId} {...props}>
        {content}
      </label>
    )
  }

  return (
    <div className={cls} dir={dir} {...props}>
      {content}
    </div>
  )
}
