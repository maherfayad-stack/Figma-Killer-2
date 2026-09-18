import './MarketingCard.css'
import { Tag } from './Tag'
import { Button } from './Button'

export function MarketingCard({
  type = 'solid',
  skeleton = false,
  title,
  subtitle,
  centerTitle,
  imageSrc,
  imageSize = 'small',
  tagCount = 0,
  tag1Label = 'Tag', tag1Variant, tag1Style,
  tag2Label = 'Tag', tag2Variant, tag2Style,
  tag3Label = 'Tag', tag3Variant, tag3Style,
  tag4Label = 'Tag', tag4Variant, tag4Style,

  actionLabel = 'Action',
  buttonVariant = 'primary',
  buttonSize = 'small',
  buttonDisabled = false,
  buttonProps,
  partnerLogoSrc,
  dir = 'ltr',
  className = '',
  ...props
}) {
  const isSkeleton = skeleton
  const isSolid = type === 'solid'
  const isGradientSmall = type === 'gradient-small'
  const isGradientLarge = type === 'gradient-large'
  const hasOverlay = isGradientSmall || isGradientLarge
  const tagItems = [
    { label: tag1Label, variant: tag1Variant, style: tag1Style },
    { label: tag2Label, variant: tag2Variant, style: tag2Style },
    { label: tag3Label, variant: tag3Variant, style: tag3Style },
    { label: tag4Label, variant: tag4Variant, style: tag4Style },
  ].slice(0, tagCount)
  const hasTags = tagItems.length > 0

  const cls = [
    'marketing-card',
    `marketing-card--${type}`,
    `marketing-card--img-${imageSize}`,
    skeleton && 'marketing-card--skeleton',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={dir} {...props}>
      <div className="marketing-card__image-section">
        {!isSkeleton && imageSrc
          ? <img src={imageSrc} alt="" className="marketing-card__img" />
          : <div className="marketing-card__img-placeholder" />
        }

        {hasTags && !isSkeleton && (
          <div className="marketing-card__tags">
            {tagItems.map((t, i) => <Tag key={i} {...t} />)}
          </div>
        )}

        {isSolid && partnerLogoSrc && !isSkeleton && (
          <div className="marketing-card__partner-logo">
            <img src={partnerLogoSrc} alt="" />
          </div>
        )}

        {hasOverlay && (
          <div className="marketing-card__overlay">
            {isGradientLarge && !isSkeleton && centerTitle && (
              <p className="marketing-card__center-title marketing-card__center-title--large">{centerTitle}</p>
            )}
            {isSkeleton
              ? <div className="marketing-card__skel-bar" />
              : (
                <div className="marketing-card__overlay-content">
                  {title && <p className="marketing-card__overlay-title">{title}</p>}
                  {subtitle && <p className="marketing-card__overlay-subtitle">{subtitle}</p>}
                </div>
              )
            }
          </div>
        )}
      </div>

      {isSolid && (
        <div className="marketing-card__content">
          {!isSkeleton
            ? (
              <>
                <div className="marketing-card__header">
                  {title && <p className="marketing-card__title">{title}</p>}
                  {subtitle && <p className="marketing-card__subtitle">{subtitle}</p>}
                </div>
                {actionLabel && (
                  <Button
                    variant={buttonVariant}
                    size={buttonSize}
                    label={actionLabel}
                    disabled={buttonDisabled}
                    {...buttonProps}
                  />
                )}
              </>
            )
            : (
              <>
                <div className="marketing-card__header">
                  <div className="marketing-card__skel-line marketing-card__skel-line--title" />
                  <div className="marketing-card__skel-line marketing-card__skel-line--subtitle" />
                </div>
                <div className="marketing-card__skel-cta" />
              </>
            )
          }
        </div>
      )}
    </div>
  )
}
