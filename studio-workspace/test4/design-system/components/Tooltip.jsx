import './Tooltip.css'

export function Tooltip({
  content,
  position = 'top',
  arrowAlign = 'center',
  dir = 'ltr',
  children,
  className,
  ...props
}) {
  const bubbleCls = [
    'tooltip__bubble',
    `tooltip__bubble--${position}`,
    `tooltip__bubble--align-${arrowAlign}`,
  ].join(' ')

  return (
    <div className={['tooltip', className].filter(Boolean).join(' ')} dir={dir} {...props}>
      {children}
      <div className={bubbleCls} role="tooltip">
        {position === 'bottom' && <div className="tooltip__arrow" />}
        <div className="tooltip__content">{content}</div>
        {position === 'top' && <div className="tooltip__arrow" />}
      </div>
    </div>
  )
}
