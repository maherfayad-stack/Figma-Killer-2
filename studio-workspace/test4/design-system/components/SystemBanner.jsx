import './SystemBanner.css'
import { Button } from './Button'
import { Tag } from './Tag'

const InfoIcon = () => (
  <svg className="system-banner__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M12.0001 3.5C7.30564 3.5 3.50006 7.30558 3.50006 12C3.50006 16.6944 7.30564 20.5 12.0001 20.5C16.6945 20.5 20.5001 16.6944 20.5001 12C20.5001 7.30558 16.6945 3.5 12.0001 3.5ZM2.50006 12C2.50006 6.75329 6.75336 2.5 12.0001 2.5C17.2468 2.5 21.5001 6.75329 21.5001 12C21.5001 17.2467 17.2468 21.5 12.0001 21.5C6.75336 21.5 2.50006 17.2467 2.50006 12ZM10.75 11.25C10.75 10.9739 10.9739 10.75 11.25 10.75C11.9404 10.75 12.5 11.3096 12.5 12V15.75C12.5 15.8881 12.6119 16 12.75 16C13.0261 16 13.25 16.2239 13.25 16.5C13.25 16.7761 13.0261 17 12.75 17C12.0596 17 11.5 16.4404 11.5 15.75V12C11.5 11.8619 11.3881 11.75 11.25 11.75C10.9739 11.75 10.75 11.5261 10.75 11.25ZM12.5 7.875C12.5 8.35825 12.1082 8.75 11.625 8.75C11.1418 8.75 10.75 8.35825 10.75 7.875C10.75 7.39175 11.1418 7 11.625 7C12.1082 7 12.5 7.39175 12.5 7.875Z" fill="currentColor" />
  </svg>
)

const CheckCircleIcon = () => (
  <svg className="system-banner__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5ZM12 3.5C7.30558 3.5 3.5 7.30558 3.5 12C3.5 16.6944 7.30558 20.5 12 20.5C16.6944 20.5 20.5 16.6944 20.5 12C20.5 7.30558 16.6944 3.5 12 3.5ZM15.7793 9.38867C15.9789 9.19814 16.2956 9.20496 16.4863 9.4043C16.6769 9.60391 16.67 9.92062 16.4707 10.1113L10.9697 15.3613C10.7765 15.5457 10.4725 15.5457 10.2793 15.3613L7.5293 12.7363C7.32995 12.5456 7.32313 12.2289 7.51367 12.0293C7.70438 11.83 8.02109 11.8231 8.2207 12.0137L10.624 14.3086L15.7793 9.38867Z" fill="currentColor" />
  </svg>
)

const WarningIcon = () => (
  <svg className="system-banner__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 3.5C7.30558 3.5 3.5 7.30558 3.5 12C3.5 16.6944 7.30558 20.5 12 20.5C16.6944 20.5 20.5 16.6944 20.5 12C20.5 7.30558 16.6944 3.5 12 3.5ZM2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12ZM12 7C12.2761 7 12.5 7.22386 12.5 7.5V12.75C12.5 13.0261 12.2761 13.25 12 13.25C11.7239 13.25 11.5 13.0261 11.5 12.75V7.5C11.5 7.22386 11.7239 7 12 7ZM12.75 16.125C12.75 16.5392 12.4142 16.875 12 16.875C11.5858 16.875 11.25 16.5392 11.25 16.125C11.25 15.7108 11.5858 15.375 12 15.375C12.4142 15.375 12.75 15.7108 12.75 16.125Z" fill="currentColor" />
  </svg>
)

const TYPE_ICON = {
  visual: InfoIcon,
  neutral: InfoIcon,
  success: CheckCircleIcon,
  caution: WarningIcon,
  error: WarningIcon,
}

/* Leading icon: the type's status icon (24px). */
function SystemBannerIcons({ type, icon }) {
  const Icon = TYPE_ICON[type] || InfoIcon
  if (!icon) return null
  return (
    <div className="system-banner__icons">
      <span className="system-banner__icon-slot">
        <Icon />
      </span>
    </div>
  )
}

function SystemBannerTag({ tag }) {
  if (!tag) return null
  const tagProps = typeof tag === 'string' ? { label: tag } : tag
  return <Tag variant="neutral" {...tagProps} />
}

function SystemBannerText({ title, description }) {
  if (!title && !description) return null
  return (
    <div className="system-banner__text">
      {title && <p className="system-banner__title">{title}</p>}
      {description && <p className="system-banner__description">{description}</p>}
    </div>
  )
}

/* ── Mobile (default) — everything the SystemBanner has always been ── */
function SystemBannerMobile({ type, title, description, icon, actionLabel, onAction }) {
  const Icon = TYPE_ICON[type] || InfoIcon

  return (
    <>
      {icon && (
        <span className="system-banner__icon-slot">
          <Icon />
        </span>
      )}

      <div className="system-banner__content">
        <SystemBannerText title={title} description={description} />

        {actionLabel && (
          <button type="button" className="system-banner__action" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </>
  )
}

/* ── Desktop — horizontal row: icons · body (text + tag) · trailing Button ── */
function SystemBannerDesktop({ type, title, description, icon, tag, actionLabel, onAction }) {
  return (
    <>
      <div className="system-banner__content">
        <SystemBannerIcons type={type} icon={icon} />
        <div className="system-banner__body">
          <SystemBannerText title={title} description={description} />
          <SystemBannerTag tag={tag} />
        </div>
      </div>

      {actionLabel && (
        <Button variant="primary" size="medium" label={actionLabel} onClick={onAction} />
      )}
    </>
  )
}

export function SystemBanner({
  platform = 'mobile',
  type = 'visual',
  title,
  description,
  icon = true,
  tag = null,
  actionLabel,
  onAction,
  skeleton = false,
  dir = 'ltr',
  className = '',
  ...props
}) {
  if (skeleton) {
    return (
      <div
        className={['system-banner', 'system-banner--skeleton', className].filter(Boolean).join(' ')}
        dir={dir}
        role="status"
        aria-label="Loading"
        {...props}
      >
        <span className="system-banner__skeleton-icon" />
        <div className="system-banner__skeleton-text">
          <span className="system-banner__skeleton-bar system-banner__skeleton-bar--title" />
          <span className="system-banner__skeleton-bar" />
          <span className="system-banner__skeleton-bar system-banner__skeleton-bar--short" />
        </div>
      </div>
    )
  }

  const cls = ['system-banner', `system-banner--${platform}`, `system-banner--${type}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} dir={dir} role="status" {...props}>
      {platform === 'desktop' ? (
        <SystemBannerDesktop
          type={type}
          title={title}
          description={description}
          icon={icon}
          tag={tag}
          actionLabel={actionLabel}
          onAction={onAction}
        />
      ) : (
        <SystemBannerMobile
          type={type}
          title={title}
          description={description}
          icon={icon}
          actionLabel={actionLabel}
          onAction={onAction}
        />
      )}
    </div>
  )
}
