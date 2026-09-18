import './BottomActionBar.css'
import { Button } from './Button'

const ChevronUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 8.5L6 4.5L10 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ApplePayMark = () => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="32" height="32" rx="2" fill="black" />
    <path
      d="M13.84 11.28c.4-.49.68-1.15.6-1.83-.6.03-1.33.4-1.75.89-.39.44-.72 1.16-.63 1.83.67.05 1.36-.34 1.78-.89z"
      fill="white"
    />
    <path
      d="M14.43 12.19c-.98-.06-1.82.56-2.28.56-.47 0-1.19-.53-1.97-.52-.1.0-1.93 1.45-.95 3.57.54 1.08 1.1 2.3 1.85 2.3.77.03 1.08-.52 2.02-.52.95 0 1.22.52 2.05.5.77-.01 1.27-.76 1.8-1.84.77-1.02.99-2.38.34-3.05-.48-.53-1.23-.95-1.86-1z"
      fill="white"
    />
    <text
      x="18"
      y="19"
      fill="white"
      fontFamily="system-ui, sans-serif"
      fontSize="8"
      fontWeight="600"
      letterSpacing="-0.2"
    >
      Pay
    </text>
  </svg>
)

export function BottomActionBar({
  type = 'starting-price',
  price = '$1,215',
  originalPrice,
  fromLabel = 'Starting from',
  bookingDetailsLabel = 'Booking details',
  paymentMethod = 'Apple Pay',
  paymentLogo,
  actionLabel = 'Label',
  onBack,
  onAction,
  dir = 'ltr',
  className = '',
}) {
  const isFunnel = type === 'funnel'
  const isPayment = type === 'payment'
  const hasBack = isFunnel || isPayment

  const cls = ['bottom-action-bar', `bottom-action-bar--${type}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} dir={dir}>
      {hasBack && (
        <button className="bottom-action-bar__back" type="button" onClick={onBack} aria-label="Go back">
          <ChevronUpIcon />
        </button>
      )}

      {!isPayment && (
        <div className="bottom-action-bar__content">
          {type === 'starting-price' && (
            <p className="bottom-action-bar__from-label">{fromLabel}</p>
          )}
          <div className="bottom-action-bar__price">
            <span className="bottom-action-bar__price-current">{price}</span>
            {type === 'starting-price' && originalPrice && (
              <span className="bottom-action-bar__price-original">{originalPrice}</span>
            )}
          </div>
          {isFunnel && (
            <a className="bottom-action-bar__booking-link">{bookingDetailsLabel}</a>
          )}
        </div>
      )}

      {isPayment && (
        <>
          <div className="bottom-action-bar__payment-logo">
            {paymentLogo ?? <ApplePayMark />}
          </div>
          <p className="bottom-action-bar__payment-method">{paymentMethod}</p>
        </>
      )}

      <Button
        className="bottom-action-bar__btn"
        variant={isPayment ? 'payment' : 'primary'}
        size="default"
        label={actionLabel}
        onClick={onAction}
      />
    </div>
  )
}
