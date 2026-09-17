import './IconButton.css'

export function IconButton({
  variant = 'primary',
  size = 'default',
  icon,
  className = '',
  ...props
}) {
  const cls = ['icon-btn', `icon-btn--${variant}`, `icon-btn--size-${size}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={cls} type="button" {...props}>
      {icon && <span className="icon-btn__icon" aria-hidden="true">{icon}</span>}
    </button>
  )
}
