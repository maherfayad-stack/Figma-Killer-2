import './Banner.css'

const CopyIcon = () => (
  <svg className="banner__copy-icon" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" width="14" height="14">
    <path fillRule="evenodd" clipRule="evenodd" d="M5 1a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2H5zm0 1h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
    <path fillRule="evenodd" clipRule="evenodd" d="M2 3H1a1 1 0 0 0-1 1v7a2 2 0 0 0 2 2h7a1 1 0 0 0 1-1v-1H2V3z"/>
  </svg>
)

const CloseIcon = () => (
  <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" width="12" height="12">
    <path d="M10.854 1.146a.5.5 0 0 0-.708 0L6 5.293 1.854 1.146a.5.5 0 0 0-.708.708L5.293 6 1.146 10.146a.5.5 0 0 0 .708.708L6 6.707l4.146 4.147a.5.5 0 0 0 .708-.708L6.707 6l4.147-4.146a.5.5 0 0 0 0-.708z"/>
  </svg>
)

export function Banner({
  color = 'neutral',
  dir = 'ltr',
  title,
  subtitle,
  codeLabel,
  codeText = 'CODE',
  showAction = true,
  showVisual = true,
  showDismiss = true,
  iconSrc,
  onClose,
  className = '',
}) {
  const isRtl = dir === 'rtl'

  const cls = ['banner', 'banner--small', `banner--color-${color}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} dir={dir}>
      <div className="banner__content">
        <div className="banner__text">
          {title && <p className="banner__title">{title}</p>}
          {subtitle && <p className="banner__body">{subtitle}</p>}
        </div>
        {showAction && (
          <div className="banner__action">
            {codeLabel && <span className="banner__action-label">{codeLabel}</span>}
            <div className="banner__action-pill">
              {!isRtl && <span className="banner__code-text">{codeText}</span>}
              <CopyIcon />
              {isRtl && <span className="banner__code-text">{codeText}</span>}
            </div>
          </div>
        )}
      </div>

      {showVisual && (
        <div className="banner__icon-slot">
          {iconSrc && <img src={iconSrc} alt="" className="banner__icon-img" />}
        </div>
      )}

      {showDismiss && (
        <button
          className="banner__dismiss"
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
