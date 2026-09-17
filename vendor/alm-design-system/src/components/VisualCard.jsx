import './VisualCard.css'
import { Button } from './Button'

const CloseIcon = () => (
  <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" width="12" height="12">
    <path d="M10.854 1.146a.5.5 0 0 0-.708 0L6 5.293 1.854 1.146a.5.5 0 0 0-.708.708L5.293 6 1.146 10.146a.5.5 0 0 0 .708.708L6 6.707l4.146 4.147a.5.5 0 0 0 .708-.708L6.707 6l4.147-4.146a.5.5 0 0 0 0-.708z"/>
  </svg>
)

export function VisualCard({
  size = 'medium',
  accentColor,
  dir = 'ltr',
  title,
  subtitle,
  imageSrc,
  priceLabel,
  priceValue,
  actionLabel,
  showBottomBar = true,
  showDismiss = true,
  onAction,
  onClose,
  className = '',
}) {
  const cls = [
    'visual-card',
    `visual-card--${size}`,
    !showBottomBar ? 'visual-card--no-bar' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={dir}>
      <div className="visual-card__image-wrap" aria-hidden="true">
        {imageSrc && <img src={imageSrc} alt="" className="visual-card__image" />}
      </div>
      <div
        className="visual-card__gradient"
        aria-hidden="true"
        style={accentColor ? { '--visual-card-accent-color': accentColor } : undefined}
      />
      <div className="visual-card__media-body">
        <div className="visual-card__media-text">
          {title && <p className="visual-card__headline">{title}</p>}
          {subtitle && <p className="visual-card__body">{subtitle}</p>}
        </div>
        {showBottomBar && (
          <div className="visual-card__bar">
            <div className="visual-card__price-info">
              {priceLabel && <span className="visual-card__eyebrow">{priceLabel}</span>}
              {priceValue && <span className="visual-card__price-value">{priceValue}</span>}
            </div>
            {actionLabel && (
              <Button
                className="visual-card__cta"
                variant="secondary-inverted"
                size="medium"
                label={actionLabel}
                onClick={onAction}
              />
            )}
          </div>
        )}
      </div>

      {showDismiss && (
        <button
          className="visual-card__dismiss"
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
