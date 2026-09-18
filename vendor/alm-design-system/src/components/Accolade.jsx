import { useId } from 'react'
import './Accolade.css'

// placeholder.svg from src/icons/line-icons/placeholder.svg
// Gradient fill is applied inline because currentColor is transparent in the Accolade gradient-text context
function PlaceholderIcon() {
  const baseId = useId()
  const id = 'ag-' + baseId.replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg className="accolade__icon" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#875BF7" />
          <stop offset="100%" stopColor="#2E90FA" />
        </linearGradient>
      </defs>
      <path d="M19.5 3.25C20.1904 3.25 20.75 3.80964 20.75 4.5V19.5C20.75 20.1904 20.1904 20.75 19.5 20.75H4.5C3.80964 20.75 3.25 20.1904 3.25 19.5V4.5C3.25 3.80964 3.80964 3.25 4.5 3.25H19.5ZM4.25 19.5C4.25 19.6381 4.36193 19.75 4.5 19.75H19.043L4.25 4.95703V19.5ZM19.75 19.043V4.5C19.75 4.36193 19.6381 4.25 19.5 4.25H4.95703L19.75 19.043Z" fill={`url(#${id})`} />
    </svg>
  )
}

export function Accolade({ label, size = 'regular', background = false, dir = 'ltr', icon = true, className = '', ...props }) {
  const cls = [
    'accolade',
    size === 'small' && 'accolade--small',
    background && 'accolade--background',
    className,
  ].filter(Boolean).join(' ')

  return (
    <span className={cls} dir={dir} {...props}>
      {icon && <PlaceholderIcon />}
      <span className="accolade__label">{label}</span>
    </span>
  )
}
