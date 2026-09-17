import './Expander.css'

const ChevronIcon = ({ expanded }) => (
  <svg
    className={['expander__icon', expanded ? 'expander__icon--expanded' : ''].filter(Boolean).join(' ')}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4.5 9L12 16.5L19.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const DEFAULT_LABELS = {
  ltr: { collapsed: 'Show more', expanded: 'Show less' },
  rtl: { collapsed: 'عرض المزيد', expanded: 'عرض أقل' },
}

export function Expander({
  expanded = false,
  onChange,
  dir = 'ltr',
  collapsedLabel,
  expandedLabel,
  className = '',
  ...rest
}) {
  const defaults = DEFAULT_LABELS[dir] ?? DEFAULT_LABELS.ltr
  const label = expanded
    ? (expandedLabel || defaults.expanded)
    : (collapsedLabel || defaults.collapsed)

  function handleClick() {
    onChange?.(!expanded)
  }

  return (
    <button
      type="button"
      className={['expander', className].filter(Boolean).join(' ')}
      onClick={handleClick}
      dir={dir}
      aria-expanded={expanded}
      {...rest}
    >
      <span className="expander__label">{label}</span>
      <ChevronIcon expanded={expanded} />
    </button>
  )
}
