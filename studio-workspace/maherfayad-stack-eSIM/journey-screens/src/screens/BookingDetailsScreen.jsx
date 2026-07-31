import { useEffect, useRef } from 'react'
import { Button, Tag } from '@alm-design/design-system'
import SheetShell from '../components/SheetShell'
import SectionTitle from '../components/SectionTitle'
import Icon from '../components/Icon'
import EsimStatusBanner from '../components/EsimStatusBanner'

import calendarSvg from '@alm-design/design-system/src/icons/line-icons/calendar.svg?raw'
import usersThreeSvg from '@alm-design/design-system/src/icons/line-icons/usersThree.svg?raw'
import infoCircleSvg from '@alm-design/design-system/src/icons/line-icons/infoCircle.svg?raw'
import chevronRightSvg from '@alm-design/design-system/src/icons/line-icons/chevronRight.svg?raw'
import airlineLogoSvg from '../assets/misc/airline-logo.svg?raw'
import esimChip from '../assets/esim-flow/figma/esim-chip.png'
import { useLanguage } from '../i18n/LanguageContext'

import './BookingDetailsScreen.css'

function BookingReferenceRow({ label, value, onCopy, separator = true }) {
  const { t } = useLanguage()
  return (
    <div className="bd-ref-row">
      <div className="bd-ref-row__main">
        <div className="bd-ref-row__meta">
          <span className="bd-ref-row__label">{label}</span>
          <button type="button" className="bd-ref-row__info" aria-label={t.bookingDetails.moreAbout(label)}>
            <Icon svg={infoCircleSvg} size={16} />
          </button>
          <span className="bd-ref-row__value">{value}</span>
        </div>
        <button type="button" className="bd-ref-row__copy" onClick={onCopy}>
          {t.common.copy}
        </button>
      </div>
      {separator && <hr className="bd-ref-row__separator" />}
    </div>
  )
}

const RING_RADIUS = 17
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const RING_LOW_THRESHOLD = 25

function EsimAddonIcon({ type, ringPercent }) {
  if (type === 'ring') {
    const pct = Math.max(0, Math.min(100, ringPercent))
    const isLow = pct <= RING_LOW_THRESHOLD
    return (
      <div
        className={`ec-ring${isLow ? ' ec-ring--low' : ''}`}
        role="img"
        aria-label={`${pct}%`}
      >
        <svg className="ec-ring__svg" viewBox="0 0 40 40">
          <circle className="ec-ring__track" cx="20" cy="20" r={RING_RADIUS} />
          <circle
            className="ec-ring__fill"
            cx="20"
            cy="20"
            r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
          />
        </svg>
        <span className="ec-ring__label" aria-hidden="true">{pct}%</span>
      </div>
    )
  }

  return <img src={esimChip} alt="" className="ec-icon-img" />
}

function topupButtonProps(variant) {
  if (variant === 'ghost') return { variant: 'secondary-inverted', className: 'ec-card__topup-btn--ghost' }
  return { variant }
}

function EsimAddonCard({ subtitle, subtitleParts, buttonLabel, buttonVariant, onAction, icon, ringPercent }) {
  const { t } = useLanguage()
  return (
    <div className="ec-card">
      <div className="ec-card__row">
        <div className="ec-card__content">
          <EsimAddonIcon type={icon} ringPercent={ringPercent} />
          <div className="ec-card__text">
            <div className="ec-card__title-row">
              <p className="ec-card__title">{t.common.esimLabel}</p>
              <Tag label={t.bookingDetails.gbTag} variant="neutral" style="tinted" />
            </div>
            {subtitleParts ? (
              <div className="ec-card__subtitle-parts">
                {subtitleParts.map((part) => (
                  <p key={part} className="ec-card__subtitle">{part}</p>
                ))}
              </div>
            ) : (
              <p className="ec-card__subtitle">{subtitle}</p>
            )}
          </div>
        </div>
        <Button {...topupButtonProps(buttonVariant)} size="small" label={buttonLabel} onClick={onAction} />
      </div>
    </div>
  )
}

// Variant: same compact skeleton and title row as the ring/install cards
// (icon + "eSIM" + GB tag on top) so mixed lists of installed/not-yet-installed
// eSIMs stay level — the second line promotes "GB left" to a bold headline
// instead of muted subtitle text, with a thin bar underneath.
function EsimAddonCardStat({ percent, gbLeft, daysLeft, buttonLabel, buttonVariant, onAction }) {
  const { t } = useLanguage()
  const pct = Math.max(0, Math.min(100, percent))
  const isLow = pct <= RING_LOW_THRESHOLD
  return (
    <div className="ec-card">
      <div className="ec-card__row">
        <div className="ec-card__content">
          <img src={esimChip} alt="" className="ec-icon-img" />
          <div className="ec-card__text">
            <div className="ec-card__title-row">
              <p className="ec-card__title">{t.common.esimLabel}</p>
              <Tag label={t.bookingDetails.gbTag} variant="neutral" style="tinted" />
            </div>
            <p className="ec-card-stat__headline-row">
              <span className={`ec-card-stat__headline${isLow ? ' ec-card-stat__headline--low' : ''}`}>
                {t.common.gbLeft(gbLeft)}
              </span>
              <span className="ec-card-stat__days">· {t.common.daysLeft(daysLeft)}</span>
            </p>
            <div className="ec-card-stat__track">
              <div
                className={`ec-card-stat__fill${isLow ? ' ec-card-stat__fill--low' : ''}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
        <Button {...topupButtonProps(buttonVariant)} size="small" label={buttonLabel} onClick={onAction} />
      </div>
    </div>
  )
}

// Variant: a compact fraction badge ("4/5 GB") with a slim bar underneath —
// states the exact amount remaining outright, in a tighter, cleaner footprint.
function EsimAddonCardGauge({ percent, gbLeft, gbTotal, daysLeft, buttonLabel, buttonVariant, onAction }) {
  const { t } = useLanguage()
  const pct = Math.max(0, Math.min(100, percent))
  const isLow = pct <= RING_LOW_THRESHOLD
  return (
    <div className="ec-card ec-card--gauge">
      <div className="ec-card-gauge__row">
        <div className="ec-card-gauge__badge-col">
          <span className={`ec-card-gauge__badge${isLow ? ' ec-card-gauge__badge--low' : ''}`}>
            {t.common.gbFraction(gbLeft, gbTotal)}
          </span>
          <div className="ec-card-gauge__badge-track">
            <div className={`ec-card-gauge__badge-fill${isLow ? ' ec-card-gauge__badge-fill--low' : ''}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="ec-card-gauge__text">
          <p className="ec-card-gauge__title">{t.common.esimLabel}</p>
          <p className="ec-card-gauge__subtitle">{t.common.daysLeft(daysLeft)}</p>
        </div>
        <Button {...topupButtonProps(buttonVariant)} size="small" label={buttonLabel} onClick={onAction} />
      </div>
    </div>
  )
}

const TOPUP_CARDS = [
  { percent: 99, gbLeft: 4, daysLeft: 3, buttonVariant: 'ghost' },
  { percent: 20, gbLeft: 1, daysLeft: 3, buttonVariant: 'primary' },
  { percent: 65, gbLeft: 4, daysLeft: 18, buttonVariant: 'ghost' },
]

const BANNER_VARIANTS = ['layered', 'tint', 'row']

export default function BookingDetailsScreen({
  onClose,
  onInstall,
  onTopup,
  onDataHelp,
  scrollToEsimSignal,
  onScrolled,
  esimTab = 0,
  esimCardStyle = 0,
  bannerStyle = 0,
}) {
  const { t } = useLanguage()
  const bannerVariant = BANNER_VARIANTS[bannerStyle] ?? 'layered'
  const d = t.bookingDetails
  const scrollRef = useRef(null)
  const esimSectionRef = useRef(null)

  const scrollToEsims = () => {
    const container = scrollRef.current
    const target = esimSectionRef.current
    if (!container || !target) return
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTo({ top, behavior: 'smooth' })
  }

  useEffect(() => {
    if (!scrollToEsimSignal) return
    scrollToEsims()
    onScrolled?.()
  }, [scrollToEsimSignal])

  return (
    <SheetShell title={d.title} onClose={onClose} className="booking-details">
      <div className="booking-details__scroll" ref={scrollRef}>
      <div className="booking-details__body">
        {esimTab === 0 ? (
          <EsimStatusBanner
            variant={bannerVariant}
            tone="install"
            icon={esimChip}
            title={d.bannerTitle}
            desc={d.bannerDesc}
            installedCount={0}
            installedTotal={2}
            statLabel={t.common.installedCount(0, 2)}
            buttonLabel={t.common.install}
            onAction={scrollToEsims}
          />
        ) : esimTab === 1 ? (
          <EsimStatusBanner
            variant={bannerVariant}
            tone="lowdata"
            icon={esimChip}
            title={d.lowBannerTitle}
            desc={t.common.gbLeftOf(0.4, 4)}
            percent={12}
            statLabel={t.common.percentRemaining(12, 2)}
            buttonLabel={t.common.topup}
            onAction={onTopup}
          />
        ) : (
          <EsimStatusBanner
            variant={bannerVariant}
            tone="lowdata"
            icon={esimChip}
            title={d.dataOffBannerTitle}
            desc={d.dataOffBannerDesc}
            percent={0}
            statLabel={d.dataOffStatLabel}
            buttonLabel={t.common.turnOnData}
            onAction={onDataHelp}
          />
        )}

        <article className="bd-card">
          <div className="bd-card__status-row">
            <Tag label={t.common.confirmed} variant="success" style="filled" />
          </div>

          <div className="bd-card__header">
            <div className="bd-card__airline">
              <Icon svg={airlineLogoSvg} size={40} />
            </div>
            <div className="bd-card__route">
              <span className="bd-card__trip-type">{t.common.roundTrip}</span>
              <span className="bd-card__route-title">{d.route}</span>
            </div>
            <Icon svg={chevronRightSvg} size={16} className="bd-card__chevron" />
          </div>

          <div className="bd-card__details">
            <div className="bd-card__detail-row">
              <Icon svg={calendarSvg} size={24} className="bd-card__detail-icon" />
              <span className="bd-card__detail-value">{d.dates}</span>
            </div>
            <div className="bd-card__detail-row">
              <Icon svg={usersThreeSvg} size={24} className="bd-card__detail-icon" />
              <span className="bd-card__detail-value">{d.adults}</span>
            </div>
          </div>

          <hr className="bd-card__separator" />

          <div className="bd-card__references">
            <BookingReferenceRow label={d.almosaferId} value="H0080403392" separator={false} />
          </div>

          <div className="bd-card__segment">
            <hr className="bd-card__separator" />
            <div className="bd-card__segment-header">
              <Icon svg={airlineLogoSvg} size={24} className="bd-card__segment-logo" />
              <span className="bd-card__segment-title">{d.segmentRoute}</span>
            </div>
            <BookingReferenceRow label={d.airlineReference} value="EK123442" separator={false} />
          </div>
        </article>

        <section className="bd-section" ref={esimSectionRef}>
          <SectionTitle title={d.purchasedAddons} size="compact" />

          <div className="bd-esim-list">
            {esimTab === 0 ? (
              <>
                <EsimAddonCard
                  icon="install"
                  subtitle={d.installNowLong}
                  buttonLabel={t.common.install}
                  buttonVariant="primary"
                  onAction={onInstall}
                />
                <EsimAddonCard
                  icon="install"
                  subtitle={d.installNowLong}
                  buttonLabel={t.common.install}
                  buttonVariant="primary"
                  onAction={onInstall}
                />
              </>
            ) : esimTab === 2 ? (
              <EsimAddonCard
                icon="ring"
                ringPercent={0}
                subtitle={d.dataOffCardSubtitle}
                buttonLabel={t.common.turnOnData}
                buttonVariant="primary"
                onAction={onDataHelp}
              />
            ) : (
              <>
                {TOPUP_CARDS.map((card, i) => {
                  if (esimCardStyle === 1) {
                    return (
                      <EsimAddonCardStat
                        key={i}
                        percent={card.percent}
                        gbLeft={card.gbLeft}
                        daysLeft={card.daysLeft}
                        buttonLabel={t.common.topup}
                        buttonVariant={card.buttonVariant}
                        onAction={onTopup}
                      />
                    )
                  }
                  if (esimCardStyle === 2) {
                    return (
                      <EsimAddonCardGauge
                        key={i}
                        percent={card.percent}
                        gbLeft={card.gbLeft}
                        gbTotal={5}
                        daysLeft={card.daysLeft}
                        buttonLabel={t.common.topup}
                        buttonVariant={card.buttonVariant}
                        onAction={onTopup}
                      />
                    )
                  }
                  return (
                    <EsimAddonCard
                      key={i}
                      icon="ring"
                      ringPercent={card.percent}
                      subtitleParts={[t.common.gbLeft(card.gbLeft), t.common.daysLeft(card.daysLeft)]}
                      buttonLabel={t.common.topup}
                      buttonVariant={card.buttonVariant}
                      onAction={onTopup}
                    />
                  )
                })}
              </>
            )}
          </div>
        </section>
      </div>
      </div>
    </SheetShell>
  )
}
