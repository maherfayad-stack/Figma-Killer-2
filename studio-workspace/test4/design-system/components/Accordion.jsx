import { useState } from 'react'
import './Accordion.css'

const ChevronIcon = ({ expanded }) => (
  <svg
    className={['accordion__icon', expanded ? 'accordion__icon--expanded' : ''].filter(Boolean).join(' ')}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4.5 9L12 16.5L19.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function Accordion({
  title,
  expanded = false,   // initial open state — the component manages its own state after mount
  skeleton = false,
  dir = 'ltr',
  className = '',
  children,
  id,
  ...rest
}) {
  const [isOpen, setIsOpen] = useState(expanded)

  function toggle() {
    setIsOpen((open) => !open)
  }

  const cls = ['accordion', className].filter(Boolean).join(' ')
  const baseId = id || 'accordion'
  const panelId = `${baseId}-panel`
  const headerId = `${baseId}-header`

  if (skeleton) {
    return (
      <div className={cls} dir={dir} {...rest}>
        <div className="accordion__header accordion__header--skeleton">
          <span className="accordion__skeleton" aria-hidden="true" />
          <span className="accordion__icon-box">
            <ChevronIcon expanded={false} />
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={cls} dir={dir} {...rest}>
      <button
        type="button"
        id={headerId}
        className="accordion__header"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span className="accordion__title">{title}</span>
        <span className="accordion__icon-box">
          <ChevronIcon expanded={isOpen} />
        </span>
      </button>
      <div
        className={['accordion__panel-wrap', isOpen ? 'accordion__panel-wrap--open' : ''].filter(Boolean).join(' ')}
      >
        <div className="accordion__panel-inner">
          <div
            id={panelId}
            role="region"
            aria-labelledby={headerId}
            inert={!isOpen}
            className="accordion__panel"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
