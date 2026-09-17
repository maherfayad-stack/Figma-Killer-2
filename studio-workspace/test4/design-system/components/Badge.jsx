import './Badge.css'

export function Badge({ variant = 'alert', count, max = 99, dir, className, children, ...props }) {
  let label
  if (variant === 'new') {
    label = 'NEW'
  } else if (count !== undefined) {
    label = count > max ? `${max}+` : String(count)
  }

  const pip = (
    <span className={`badge badge--${variant}`}>
      {label}
    </span>
  )

  if (children) {
    return (
      <span
        className={['badge-anchor', className].filter(Boolean).join(' ')}
        dir={dir}
        {...props}
      >
        {children}
        {pip}
      </span>
    )
  }

  return (
    <span
      className={['badge', `badge--${variant}`, className].filter(Boolean).join(' ')}
      {...props}
    >
      {label}
    </span>
  )
}
