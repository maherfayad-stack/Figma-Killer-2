import './Button.css'
import { useDir } from '../context/DesignSystemContext'
import gpayLockup from '../icons/logotypes/payment/gpay-lockup.svg'
import applePayMarkRaw from '../icons/logotypes/payment/applepay-mark.svg?raw'
import cardSample from '../icons/logotypes/payment/card-sample.png'
import lockCheckRaw from '../icons/line-icons/lockCheck.svg?raw'

// Localized labels for the Google Pay "…with" lockups (Google-sanctioned copy).
const GPAY_TEXT = {
  'gpay-pay-with': { ltr: 'Pay with', rtl: 'الدفع باستخدام' },
  'gpay-checkout-with': { ltr: 'Checkout with', rtl: 'إتمام الدفع باستخدام' },
}

// Renders the selected-card thumbnail: a string is treated as an image src,
// any node is rendered as-is. Returns null when nothing is provided.
const renderCardArt = (cardArt) =>
  typeof cardArt === 'string'
    ? <img className="btn__card-art" src={cardArt} alt="" aria-hidden="true" />
    : cardArt ?? null

const GPayLockup = () => (
  <img className="btn__gpay-lockup" src={gpayLockup} alt="Google Pay" />
)

export function Button({
  variant = 'primary',
  size = 'default',
  label,
  leadingIcon,
  trailingIcon,
  cardArt = cardSample,   // selected-card thumbnail (apple-pay / gpay-card / gpay-personalized); pass false to hide
  cardLast4 = '1394',     // masked number shown by gpay-personalized
  dir,
  className = '',
  ...props
}) {
  const d = useDir(dir)
  // Brand-pay buttons are single-size (their own fixed height), so they don't take a size class.
  const fixedSize = variant === 'apple-pay' || variant.startsWith('gpay-')
  const cls = ['btn', `btn--${variant}`, fixedSize ? null : `btn--size-${size}`, className]
    .filter(Boolean)
    .join(' ')

  if (variant === 'skeleton') {
    return <span className={cls} role="status" aria-label="Loading" />
  }

  if (variant === 'apple-pay') {
    return (
      <button className={cls} type="button" dir={d} {...props}>
        <span
          className="btn__apple-mark"
          role="img"
          aria-label="Apple Pay"
          dangerouslySetInnerHTML={{ __html: applePayMarkRaw }}
        />
        {cardArt && <span className="btn__divider" aria-hidden="true" />}
        {renderCardArt(cardArt)}
      </button>
    )
  }

  if (variant.startsWith('gpay-')) {
    // "…with" lockups: fixed Google-sanctioned copy precedes the mark.
    // The text is brand-mandated, so `label` is ignored here (only `dir` localizes it).
    if (variant === 'gpay-pay-with' || variant === 'gpay-checkout-with') {
      const text = GPAY_TEXT[variant][d === 'rtl' ? 'rtl' : 'ltr']
      return (
        <button className={cls} type="button" dir={d} {...props}>
          <span className="btn__pay-text">{text}</span>
          <GPayLockup />
        </button>
      )
    }
    // Card / Personalized: lockup, then the selected card (divider + art [+ last4]).
    const showCard = variant === 'gpay-personalized' || cardArt
    return (
      <button className={cls} type="button" dir={d} {...props}>
        <GPayLockup />
        {showCard && <span className="btn__divider" aria-hidden="true" />}
        {renderCardArt(cardArt)}
        {variant === 'gpay-personalized' && (
          <span className="btn__pay-text">•••• {cardLast4}</span>
        )}
      </button>
    )
  }

  if (variant === 'payment') {
    return (
      <button className={cls} type="button" dir={d} {...props}>
        <span className="btn__icon" dangerouslySetInnerHTML={{ __html: lockCheckRaw }} />
        {label && <span className="btn__label">{label}</span>}
      </button>
    )
  }

  return (
    <button className={cls} type="button" dir={d} {...props}>
      {leadingIcon && <span className="btn__icon">{leadingIcon}</span>}
      {label != null && <span className="btn__label">{label}</span>}
      {trailingIcon && <span className="btn__icon">{trailingIcon}</span>}
    </button>
  )
}
