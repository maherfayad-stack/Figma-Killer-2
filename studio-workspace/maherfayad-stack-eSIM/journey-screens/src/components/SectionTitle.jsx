import './SectionTitle.css'

export default function SectionTitle({ title, actionLabel, onAction, size = 'default' }) {
  return (
    <div className={`section-title section-title--${size}`}>
      <p className="section-title__text">{title}</p>
      {actionLabel && (
        <button type="button" className="section-title__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
