import { useDir } from '../context/DesignSystemContext'
import chevronLeftRaw from '../icons/line-icons/chevronLeft.svg?raw'
import chevronRightRaw from '../icons/line-icons/chevronRight.svg?raw'
import xRaw from '../icons/line-icons/x.svg?raw'
import './GlassButton.css'

// design-system line icons — these svgs use currentColor, so CSS tints them via the icon-* tokens
const RawIcon = ({ svg }) => (
  <span
    className="glass-btn__icon"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: svg }}
  />
)

// iOS back chevron — physically mirrored for RTL (points the way out)
const BackIcon = ({ dir }) => <RawIcon svg={dir === 'rtl' ? chevronRightRaw : chevronLeftRaw} />
const CloseIcon = () => <RawIcon svg={xRaw} />

// wrap a consumer-supplied icon node so it gets the 24px icon sizing
const IconSlot = ({ children }) => (
  <span className="glass-btn__icon" aria-hidden="true">{children}</span>
)

/**
 * GlassButton — translucent "liquid glass" action button used over imagery and in
 * navigation bars. Composed into Navbar (and reusable elsewhere). One button, the
 * content layout is chosen by `type`, the surface treatment by `bg`.
 */
export function GlassButton({
  bg = 'default',          // default (light glass) | primary (aqua) | dim (dark glass)
  type = 'back',           // back | label | back-label | 1-icon | 2-icons | x
  label,
  icon1,
  icon2,
  dir,
  className = '',
  ...props
}) {
  const d = useDir(dir)

  const cls = [
    'glass-btn',
    `glass-btn--bg-${bg}`,
    `glass-btn--type-${type}`,
    className,
  ].filter(Boolean).join(' ')

  return (
    <button className={cls} type="button" dir={d} {...props}>
      {(type === 'back' || type === 'back-label') && <BackIcon dir={d} />}
      {type === 'x' && <CloseIcon />}
      {(type === '1-icon' || type === '2-icons') && icon1 && <IconSlot>{icon1}</IconSlot>}
      {type === '2-icons' && icon2 && <IconSlot>{icon2}</IconSlot>}
      {(type === 'label' || type === 'back-label') && label && (
        <span className="glass-btn__label">{label}</span>
      )}
    </button>
  )
}
