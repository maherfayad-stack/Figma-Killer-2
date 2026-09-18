import './Callout.css'

// placeholder.svg from src/icons/line-icons/placeholder.svg
const PlaceholderIcon = () => (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.5 3.25C20.1904 3.25 20.75 3.80964 20.75 4.5V19.5C20.75 20.1904 20.1904 20.75 19.5 20.75H4.5C3.80964 20.75 3.25 20.1904 3.25 19.5V4.5C3.25 3.80964 3.80964 3.25 4.5 3.25H19.5ZM4.25 19.5C4.25 19.6381 4.36193 19.75 4.5 19.75H19.043L4.25 4.95703V19.5ZM19.75 19.043V4.5C19.75 4.36193 19.6381 4.25 19.5 4.25H4.95703L19.75 19.043Z" />
  </svg>
)

export function Callout({ label, size = 'regular', dir = 'ltr', icon = true, className = '', ...props }) {
  const cls = ['callout', size === 'small' && 'callout--small', className].filter(Boolean).join(' ')
  return (
    <span className={cls} dir={dir} {...props}>
      {label}
      {icon && <PlaceholderIcon />}
    </span>
  )
}
