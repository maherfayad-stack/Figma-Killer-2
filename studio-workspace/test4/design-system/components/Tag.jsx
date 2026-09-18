import './Tag.css'

export function Tag({ label, variant = 'default', style = 'tinted', leadingIcon, trailingIcon, skeleton = false, className = '', ...props }) {
  if (skeleton) {
    return <span className={['tag', 'tag--skeleton', className].filter(Boolean).join(' ')} {...props} />
  }

  const modifier = (variant !== 'default' || style === 'filled') ? `tag--${variant}-${style}` : null
  const cls = ['tag', modifier, className].filter(Boolean).join(' ')
  return (
    <span className={cls} {...props}>
      {leadingIcon && <span className="tag__icon">{leadingIcon}</span>}
      {label}
      {trailingIcon && <span className="tag__icon">{trailingIcon}</span>}
    </span>
  )
}
