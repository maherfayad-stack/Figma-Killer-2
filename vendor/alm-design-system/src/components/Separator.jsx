import './Separator.css'

export function Separator({ type = 'cell separator', variant = 'simple', label, dir = 'ltr', className = '', ...rest }) {
  if (type === 'section separator') {
    const cls = ['separator', 'separator--section', className].filter(Boolean).join(' ')
    return <div className={cls} role="separator" {...rest} />
  }

  if (variant === 'or') {
    const orLabel = label ?? (dir === 'rtl' ? 'أو' : 'OR')
    const cls = ['separator', 'separator--or', className].filter(Boolean).join(' ')
    return (
      <div className={cls} role="separator" dir={dir} {...rest}>
        <span className="separator__line" />
        <span className="separator__or-label">{orLabel}</span>
        <span className="separator__line" />
      </div>
    )
  }

  if (variant === 'dashed') {
    const cls = ['separator', 'separator--dashed', className].filter(Boolean).join(' ')
    return <hr className={cls} {...rest} />
  }

  const cls = ['separator', className].filter(Boolean).join(' ')
  return <hr className={cls} {...rest} />
}
