import { usePlatform, useDir } from '../context/DesignSystemContext'
import { SegmentedControl } from './SegmentedControl'
import { GlassButton } from './GlassButton'
import { Chip } from './Chip'
import { Search } from './Search'
import chevronDownRaw from '../icons/line-icons/chevronDown.svg?raw'
import arrowLeftRaw from '../icons/line-icons/arrowLeft.svg?raw'
import arrowRightRaw from '../icons/line-icons/arrowRight.svg?raw'
import arrowsLeftRightRaw from '../icons/line-icons/arrowsLeftRight.svg?raw'
import currencyRaw from '../icons/line-icons/currency.svg?raw'
import userRaw from '../icons/line-icons/user.svg?raw'
import magnifyingGlassRaw from '../icons/line-icons/maginfyingGlass.svg?raw'
import './Navbar.css'

// design-system line icons — currentColor tints them via the icon-* tokens
const RawIcon = ({ svg }) => (
  <span className="navbar__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
)

// ── status bar — device chrome rendered inside the navbar ──────────────────
const SignalIcon = () => (
  <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
    <rect x="0" y="8" width="3" height="4" rx="1" />
    <rect x="5" y="5" width="3" height="7" rx="1" />
    <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
    <rect x="15" y="0" width="3" height="12" rx="1" />
  </svg>
)
const WifiIcon = () => (
  <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor" aria-hidden="true">
    <path d="M8.5 2.2c2.8 0 5.4 1.1 7.3 2.9l-1.5 1.6A8.3 8.3 0 0 0 8.5 4.3 8.3 8.3 0 0 0 2.7 6.7L1.2 5.1A10.5 10.5 0 0 1 8.5 2.2Zm0 3.7c1.8 0 3.5.7 4.8 1.9l-1.6 1.7a4.6 4.6 0 0 0-3.2-1.3 4.6 4.6 0 0 0-3.2 1.3L3.7 7.8A6.8 6.8 0 0 1 8.5 5.9Zm0 3.6c.9 0 1.7.4 2.3 1L8.5 12 6.2 10.5c.6-.6 1.4-1 2.3-1Z" />
  </svg>
)
const BatteryIcon = () => (
  <svg width="25" height="12" viewBox="0 0 25 12" fill="none" aria-hidden="true">
    <rect x="0.5" y="0.8" width="21" height="10.4" rx="2.6" stroke="currentColor" strokeOpacity="0.4" />
    <rect x="2" y="2.3" width="18" height="7.4" rx="1.3" fill="currentColor" />
    <path d="M23 4v4a1.8 1.8 0 0 0 0-4Z" fill="currentColor" fillOpacity="0.4" />
  </svg>
)

const StatusBar = ({ platform, surface }) => {
  const inverted = surface === 'gradient' || surface === 'overlay'
  const cls = ['navbar__status', `navbar__status--${platform}`, inverted && 'navbar__status--inverted']
    .filter(Boolean).join(' ')

  if (platform === 'ios') {
    return (
      <div className={cls}>
        <span className="navbar__status-time">9:41</span>
        <span className="navbar__status-island" aria-hidden="true" />
        <span className="navbar__status-levels">
          <SignalIcon /><WifiIcon /><BatteryIcon />
        </span>
      </div>
    )
  }
  return (
    <div className={cls}>
      <span className="navbar__status-levels">
        <WifiIcon /><SignalIcon /><BatteryIcon />
      </span>
      <span className="navbar__status-time">12:30</span>
    </div>
  )
}

// ── itinerary glass pill — the centred route/location summary (iOS flights/stays) ──
const ItineraryPill = ({ surface, onClick, children }) => {
  const inverted = surface === 'gradient' || surface === 'overlay'
  const cls = [
    'navbar__itinerary',
    inverted ? 'navbar__itinerary--dim' : 'navbar__itinerary--default',
  ].join(' ')
  return (
    <button className={cls} type="button" onClick={onClick}>
      {children}
    </button>
  )
}

// ── iOS toolbar — six layout variants ──
const ToolbarIos = ({ surface, dir, t }) => {
  const variant = t.variant || 'default'
  const inverted = surface === 'gradient' || surface === 'overlay'
  const glassBg = inverted ? 'dim' : 'default'
  const titleCls = ['navbar__title', inverted && 'navbar__title--inverted'].filter(Boolean).join(' ')

  const Back = t.onBack && (
    <GlassButton bg={glassBg} type="back" onClick={t.onBack} dir={dir} aria-label="Back" />
  )
  const trailing = (icon, onClick, label) => (
    <GlassButton bg={glassBg} type="1-icon" icon1={<RawIcon svg={icon} />} onClick={onClick} dir={dir} aria-label={label} />
  )

  // Large — compact bar + an expanded headline below
  if (variant === 'large') {
    return (
      <div className="navbar__toolbar navbar__toolbar--ios navbar__toolbar--large">
        <div className="navbar__toolbar-row">
          <div className="navbar__toolbar-lhs">{Back}</div>
          <div className="navbar__toolbar-rhs">
            {(t.rightActions || []).map((a, i) => (
              <GlassButton key={i} bg={glassBg} type="1-icon" icon1={a.icon} onClick={a.onClick} dir={dir} aria-label={a['aria-label'] || a.label} />
            ))}
          </div>
        </div>
        {t.title && <p className={['navbar__large-title', inverted && 'navbar__large-title--inverted'].filter(Boolean).join(' ')}>{t.title}</p>}
      </div>
    )
  }

  // Flights / Stays — centred itinerary glass pill between back and trailing actions
  if (variant === 'flights' || variant === 'stays') {
    return (
      <div className="navbar__toolbar navbar__toolbar--ios navbar__toolbar--itinerary">
        {Back}
        <ItineraryPill surface={surface} onClick={t.onItinerary}>
          {variant === 'flights' ? (
            <>
              <span className="navbar__itin-route">
                <span className="navbar__itin-code">{t.origin}</span>
                <RawIcon svg={arrowsLeftRightRaw} />
                <span className="navbar__itin-code">{t.destination}</span>
                {t.tripType && <span className="navbar__itin-code">{t.tripType}</span>}
              </span>
              <span className="navbar__itin-sub">
                {t.travelers != null && (
                  <span className="navbar__itin-pax">{t.travelers}<RawIcon svg={userRaw} /></span>
                )}
                {t.cabin && <span>{t.cabin}</span>}
                {t.cabin && t.dates && <span className="navbar__itin-dot">•</span>}
                {t.dates && <span>{t.dates}</span>}
              </span>
            </>
          ) : (
            <>
              <span className="navbar__itin-title">{t.location}</span>
              <span className="navbar__itin-sub">
                {t.guests != null && (
                  <span className="navbar__itin-pax">{t.guests}<RawIcon svg={userRaw} /></span>
                )}
                {t.guests != null && t.dates && <span className="navbar__itin-dot">•</span>}
                {t.dates && <span>{t.dates}</span>}
              </span>
            </>
          )}
        </ItineraryPill>
        <div className="navbar__toolbar-rhs">
          {t.onCurrency && trailing(currencyRaw, t.onCurrency, 'Change currency')}
        </div>
      </div>
    )
  }

  // Segmented control — back · segmented control · close
  if (variant === 'segmented-control') {
    const sc = t.segmentedControl || {}
    return (
      <div className="navbar__toolbar navbar__toolbar--ios navbar__toolbar--segmented">
        <div className="navbar__toolbar-lhs">{Back}</div>
        <div className="navbar__toolbar-center">
          <SegmentedControl items={sc.items} value={sc.value} onChange={sc.onChange} platform="ios" dir={dir} />
        </div>
        <div className="navbar__toolbar-rhs">
          {t.onClose && <GlassButton bg={glassBg} type="x" onClick={t.onClose} dir={dir} aria-label="Close" />}
        </div>
      </div>
    )
  }

  // Search — search field + close
  if (variant === 'search') {
    const s = t.search || {}
    return (
      <div className="navbar__toolbar navbar__toolbar--ios navbar__toolbar--search">
        <Search
          platform="ios"
          value={s.value}
          onChange={s.onChange}
          onClear={s.onClear}
          onClose={t.onClose}
          showClose={!!t.onClose}
          placeholder={s.placeholder}
          dir={dir}
        />
      </div>
    )
  }

  // Default — back · centred title/subtitle · trailing actions
  return (
    <div className="navbar__toolbar navbar__toolbar--ios">
      <div className="navbar__toolbar-lhs">{Back}</div>
      <div className={titleCls}>
        {t.title && <span className="navbar__title-text">{t.title}</span>}
        {t.subtitle && <span className="navbar__subtitle-text">{t.subtitle}</span>}
      </div>
      <div className="navbar__toolbar-rhs">
        {(t.rightActions || []).map((a, i) => (
          <GlassButton key={i} bg={glassBg} type="1-icon" icon1={a.icon} onClick={a.onClick} dir={dir} aria-label={a['aria-label'] || a.label} />
        ))}
      </div>
    </div>
  )
}

// android itinerary content — centred route/location text (no glass pill)
const AndroidItinerary = ({ variant, t }) => (
  <div className="navbar__android-itin">
    {variant === 'flights' ? (
      <span className="navbar__itin-route">
        <span className="navbar__itin-code">{t.origin}</span>
        <RawIcon svg={arrowsLeftRightRaw} />
        <span className="navbar__itin-code">{t.destination}</span>
        {t.tripType && <span className="navbar__itin-code">{t.tripType}</span>}
      </span>
    ) : (
      <span className="navbar__itin-title">{t.location}</span>
    )}
    <span className="navbar__itin-sub">
      {(variant === 'flights' ? t.travelers : t.guests) != null && (
        <span className="navbar__itin-pax">{variant === 'flights' ? t.travelers : t.guests}<RawIcon svg={userRaw} /></span>
      )}
      {variant === 'flights' && t.cabin && <span>{t.cabin}</span>}
      {t.dates && <span className="navbar__itin-dot">•</span>}
      {t.dates && <span>{t.dates}</span>}
      <span className="navbar__itin-caret"><RawIcon svg={chevronDownRaw} /></span>
    </span>
  </div>
)

// ── android toolbar — material layout; `variant` applies only on the default surface ──
const ToolbarAndroid = ({ surface, dir, t }) => {
  const inverted = surface === 'gradient' || surface === 'overlay'
  // the rich variants only exist on the default surface; gradient/overlay always use default
  const variant = surface === 'default' ? (t.variant || 'default') : 'default'
  const BackArrow = () => <RawIcon svg={dir === 'rtl' ? arrowRightRaw : arrowLeftRaw} />
  const Back = t.onBack && (
    <button className="navbar__icon-btn" type="button" onClick={t.onBack} aria-label="Back">
      <BackArrow />
    </button>
  )
  const action = (a, i) => (
    <button key={i} className="navbar__icon-btn" type="button" onClick={a.onClick} aria-label={a['aria-label'] || a.label}>
      <span className="navbar__icon" aria-hidden="true">{a.icon}</span>
    </button>
  )
  const trailing = (icon, onClick, label) => (
    <button className="navbar__icon-btn" type="button" onClick={onClick} aria-label={label}>
      <RawIcon svg={icon} />
    </button>
  )

  // Large — back · headline title (fills) · trailing actions, single row
  if (variant === 'large') {
    return (
      <div className="navbar__toolbar navbar__toolbar--android navbar__toolbar--android-large">
        <div className="navbar__toolbar-lhs">{Back}</div>
        {t.title && <p className="navbar__android-large-title">{t.title}</p>}
        <div className="navbar__toolbar-rhs">{(t.rightActions || []).map(action)}</div>
      </div>
    )
  }

  // Flights / Stays — back · centred itinerary · trailing action(s)
  if (variant === 'flights' || variant === 'stays') {
    return (
      <div className="navbar__toolbar navbar__toolbar--android navbar__toolbar--itinerary">
        <div className="navbar__toolbar-lhs">{Back}</div>
        <button className="navbar__android-itin-btn" type="button" onClick={t.onItinerary}>
          <AndroidItinerary variant={variant} t={t} />
        </button>
        <div className="navbar__toolbar-rhs">
          {variant === 'stays' && t.onSearch && trailing(magnifyingGlassRaw, t.onSearch, 'Search')}
          {t.onCurrency && trailing(currencyRaw, t.onCurrency, 'Change currency')}
        </div>
      </div>
    )
  }

  // Segmented control — back · segmented control (fills) · trailing actions
  if (variant === 'segmented-control') {
    const sc = t.segmentedControl || {}
    return (
      <div className="navbar__toolbar navbar__toolbar--android navbar__toolbar--segmented">
        <div className="navbar__toolbar-lhs">{Back}</div>
        <div className="navbar__toolbar-center">
          <SegmentedControl items={sc.items} value={sc.value} onChange={sc.onChange} platform="android" dir={dir} />
        </div>
        <div className="navbar__toolbar-rhs">{(t.rightActions || []).map(action)}</div>
      </div>
    )
  }

  // Search — the Android docked search bar
  if (variant === 'search') {
    const s = t.search || {}
    return (
      <div className="navbar__toolbar navbar__toolbar--android navbar__toolbar--search">
        <Search
          platform="android"
          value={s.value}
          onChange={s.onChange}
          onClear={s.onClear}
          onClose={t.onClose}
          placeholder={s.placeholder}
          dir={dir}
        />
      </div>
    )
  }

  // Default — back · centred title/subtitle · trailing actions
  return (
    <div className="navbar__toolbar navbar__toolbar--android">
      <div className="navbar__toolbar-lhs">{Back}</div>
      <div className={['navbar__title', inverted && 'navbar__title--inverted'].filter(Boolean).join(' ')}>
        {t.title && <span className="navbar__title-text">{t.title}</span>}
        {t.subtitle && <span className="navbar__subtitle-text">{t.subtitle}</span>}
      </div>
      <div className="navbar__toolbar-rhs">{(t.rightActions || []).map(action)}</div>
    </div>
  )
}

const Toolbar = ({ platform, surface, dir, t }) =>
  platform === 'ios'
    ? <ToolbarIos surface={surface} dir={dir} t={t} />
    : <ToolbarAndroid surface={surface} dir={dir} t={t} />

// ── iOS glass chip — a small liquid-glass pill, built into the navbar ──────
const GlassChip = ({ icon, label, dropdown, selected, surface, onClick, dir }) => {
  const inverted = surface === 'gradient' || surface === 'overlay'
  const cls = [
    'navbar__glass-chip',
    inverted ? 'navbar__glass-chip--dim' : 'navbar__glass-chip--default',
    !label && 'navbar__glass-chip--icon-only',
    selected && 'navbar__glass-chip--selected',
  ].filter(Boolean).join(' ')
  return (
    <button className={cls} type="button" onClick={onClick} dir={dir}>
      {icon && <span className="navbar__glass-chip-icon" aria-hidden="true">{icon}</span>}
      {label && <span className="navbar__glass-chip-label">{label}</span>}
      {dropdown && <span className="navbar__glass-chip-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: chevronDownRaw }} />}
    </button>
  )
}

const ChipRow = ({ platform, surface, dir, chips }) => (
  <div className="navbar__chips" dir={dir}>
    {chips.map((c, i) =>
      platform === 'ios' ? (
        <GlassChip key={i} {...c} surface={surface} dir={dir} />
      ) : (
        <Chip
          key={i}
          label={c.label}
          icon={c.icon}
          dropdown={c.dropdown}
          selected={c.selected}
          onClick={c.onClick}
          dir={dir}
        />
      )
    )}
  </div>
)

/**
 * Navbar — top navigation bar, composed from a status bar, a Default toolbar
 * (back · title/subtitle · trailing actions), an optional chip row, and an
 * optional segmented control. Platform-aware (iOS glass / Android material) and
 * surface-aware (default | gradient | overlay).
 *
 * Each section renders only when its data prop is supplied:
 *   toolbar={{ title, subtitle, onBack, rightActions }}
 *   chips={[{ icon, label, dropdown, selected, onClick }]}
 *   segmentedControl={{ items, value, onChange }}
 */
export function Navbar({
  platform,
  surface = 'default',
  toolbar,
  chips,
  segmentedControl,
  dir,
  className = '',
  ...rest
}) {
  const p = usePlatform(platform)
  const d = useDir(dir)

  // Surface constraint: the gradient / overlay surfaces are Android-only.
  // iOS always uses the default (glass) surface — gradient/overlay are Android-only.
  const s = p === 'ios' ? 'default' : surface

  // The toolbar `variant` only applies on the default surface (always so on iOS);
  // on Android gradient/overlay it falls back to the default layout.
  const variantActive = p === 'ios' || s === 'default'
  const effectiveVariant = variantActive ? toolbar?.variant : undefined

  const cls = [
    'navbar',
    `navbar--${p}`,
    `navbar--${s}`,
    className,
  ].filter(Boolean).join(' ')

  // over imagery (Android gradient/overlay) the toolbar stands alone —
  // no chip row or segmented section
  const overImagery = p === 'android' && (s === 'gradient' || s === 'overlay')

  // the segmented-control toolbar variant already carries a SegmentedControl —
  // suppress the standalone section so there aren't two of them
  const showChips = !overImagery && chips && chips.length > 0
  const showSegmented = !overImagery && segmentedControl && effectiveVariant !== 'segmented-control'

  return (
    <nav className={cls} dir={d} {...rest}>
      <StatusBar platform={p} surface={s} />

      {toolbar && <Toolbar platform={p} surface={s} dir={d} t={toolbar} />}

      {showChips && (
        <ChipRow platform={p} surface={s} dir={d} chips={chips} />
      )}

      {showSegmented && (
        <div className="navbar__segmented">
          <SegmentedControl
            items={segmentedControl.items}
            value={segmentedControl.value}
            onChange={segmentedControl.onChange}
            platform={p}
            dir={d}
          />
        </div>
      )}
    </nav>
  )
}
