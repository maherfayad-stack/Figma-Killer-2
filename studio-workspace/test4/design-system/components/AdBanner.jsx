import './AdBanner.css'
import { Tag } from './Tag'
import { Button } from './Button'
import { ChevronRightIcon, ChevronLeftIcon } from '../icons/LineIcons'

const SPONSORED = { ltr: 'Sponsored', rtl: 'ممول' }

export function AdBanner({
  layout = 'mobile',        // mobile | desktop
  size = 'small',           // mobile only: small (row) | medium | large (hero card)
  title,
  subtitle,
  logo = null,
  logoSrc,
  imageSrc,
  sponsoredLabel,
  showSponsored = true,
  showAction = false,
  actionLabel,
  onAction,
  showImageAction = false,
  imageActionLabel,
  onImageAction,
  chevron = true,
  skeleton = false,
  onClick,
  dir = 'ltr',
  className = '',
  ...rest
}) {
  const isRtl = dir === 'rtl'
  const isDesktop = layout === 'desktop'
  // mobile medium/large render as a vertical card with a hero image on top
  const isCard = !isDesktop && (size === 'medium' || size === 'large')
  const Chevron = isRtl ? ChevronLeftIcon : ChevronRightIcon

  const cls = [
    'ad-banner',
    `ad-banner--${layout}`,
    !isDesktop && `ad-banner--${size}`,
    isCard && 'ad-banner--card',
    skeleton && 'ad-banner--skeleton',
    className,
  ].filter(Boolean).join(' ')

  const chevronEl = (
    <span className="ad-banner__chevron" aria-hidden="true">
      <Chevron />
    </span>
  )

  if (skeleton) {
    const bars = (
      <div className="ad-banner__skel-text">
        <span className="ad-banner__skel ad-banner__skel-bar" />
        <span className="ad-banner__skel ad-banner__skel-bar" />
      </div>
    )
    return (
      <div className={cls} dir={dir} role="status" aria-label="Loading" {...rest}>
        {isCard && (
          <div className="ad-banner__image ad-banner__image--skel">
            <span className="ad-banner__skel ad-banner__skel-tag" />
          </div>
        )}
        <div className="ad-banner__body">
          <div className="ad-banner__logo ad-banner__skel" />
          <div className="ad-banner__content">
            {bars}
            {!isCard && <span className="ad-banner__skel ad-banner__skel-tag" />}
            {showAction && <span className="ad-banner__skel ad-banner__skel-btn" />}
          </div>
          {!isDesktop && chevron && chevronEl}
        </div>
        {isDesktop && (
          <div className="ad-banner__media ad-banner__media--skel">
            <div className="ad-banner__media-fade" aria-hidden="true" />
            {showImageAction && (
              <span className="ad-banner__skel ad-banner__skel-btn ad-banner__skel-btn--image" />
            )}
          </div>
        )}
      </div>
    )
  }

  const sponsored = sponsoredLabel || (isRtl ? SPONSORED.rtl : SPONSORED.ltr)

  const resolvedLogo = logoSrc
    ? <img src={logoSrc} alt="" className="ad-banner__logo-img" />
    : typeof logo === 'string'
      ? <img src={logo} alt="" className="ad-banner__logo-img" />
      : logo

  const logoEl = <div className="ad-banner__logo">{resolvedLogo}</div>

  const textEl = (
    <div className="ad-banner__text">
      {title && <p className="ad-banner__title">{title}</p>}
      {subtitle && <p className="ad-banner__subtitle">{subtitle}</p>}
    </div>
  )

  const tagEl = showSponsored && (
    <Tag label={sponsored} className="ad-banner__tag" />
  )

  const ctaEl = showAction && (
    <Button
      variant="primary-inverted"
      size="medium"
      label={actionLabel || 'Label'}
      className="ad-banner__cta"
      onClick={(e) => { e.stopPropagation(); onAction?.(e) }}
    />
  )

  // mobile medium/large — vertical card with hero image + Sponsored tag overlaid on top
  if (isCard) {
    return (
      <div className={cls} dir={dir} onClick={onClick} {...rest}>
        <div className="ad-banner__image">
          {imageSrc && <img src={imageSrc} alt="" className="ad-banner__image-img" />}
          {tagEl}
        </div>
        <div className="ad-banner__body">
          {logoEl}
          <div className="ad-banner__content">
            {textEl}
            {ctaEl}
          </div>
          {chevron && chevronEl}
        </div>
      </div>
    )
  }

  // desktop — wide row with a side image bleeding off the trailing edge
  if (isDesktop) {
    return (
      <div className={cls} dir={dir} onClick={onClick} {...rest}>
        <div className="ad-banner__body">
          {logoEl}
          <div className="ad-banner__content">
            {textEl}
            {tagEl}
            {ctaEl}
          </div>
        </div>
        <div className="ad-banner__media">
          {imageSrc && <img src={imageSrc} alt="" className="ad-banner__media-img" />}
          <div className="ad-banner__media-fade" aria-hidden="true" />
          {showImageAction && (
            <button
              type="button"
              className="ad-banner__image-cta"
              onClick={(e) => { e.stopPropagation(); onImageAction?.(e) }}
            >
              {imageActionLabel || 'Label'}
              <span className="ad-banner__image-cta-icon" aria-hidden="true">
                <Chevron />
              </span>
            </button>
          )}
        </div>
      </div>
    )
  }

  // mobile small — compact horizontal row with an optional trailing image strip
  return (
    <div className={cls} dir={dir} onClick={onClick} {...rest}>
      <div className="ad-banner__body">
        {logoEl}
        <div className="ad-banner__content">
          {textEl}
          {tagEl}
          {ctaEl}
        </div>
        {chevron && chevronEl}
      </div>
      {imageSrc && (
        <div className="ad-banner__strip">
          <img src={imageSrc} alt="" className="ad-banner__strip-img" />
        </div>
      )}
    </div>
  )
}
