import { Tag, TabBar } from '@alm-design/design-system'
import SectionTitle from '../components/SectionTitle'
import Icon from '../components/Icon'
import IllustrationIcon from '../components/IllustrationIcon'
import StatusBar from '../components/StatusBar'
import Price from '../components/Price'
import EsimStatusBanner from '../components/EsimStatusBanner'
import { useLanguage } from '../i18n/LanguageContext'

import avatarIconSvg from '../assets/illustrations/avatar-icon.svg?raw'
import walletIllustrationSvg from '../assets/illustrations/wallet.svg?raw'
import productFlightsSvg from '../assets/illustrations/product-flights.svg?raw'
import productStaysSvg from '../assets/illustrations/product-stays.svg?raw'
import productActivitiesSvg from '../assets/illustrations/product-activities.svg?raw'
import quicklink1Svg from '../assets/illustrations/quicklink-1.svg?raw'
import quicklink2Svg from '../assets/illustrations/quicklink-2.svg?raw'
import quicklink3Svg from '../assets/illustrations/quicklink-3.svg?raw'
import quicklink4Svg from '../assets/illustrations/quicklink-4.svg?raw'
import addonAirportTransferSvg from '@alm-design/design-system/src/icons/visual-icons/addonAirportTransfer.svg?raw'
import chevronRightSvg from '@alm-design/design-system/src/icons/line-icons/chevronRight.svg?raw'
import serviceCarRentalSvg from '@alm-design/design-system/src/icons/visual-icons/serviceCarRental.svg?raw'
import addonInsuranceSvg from '@alm-design/design-system/src/icons/visual-icons/addonInsurance.svg?raw'
import productChaletsSvg from '@alm-design/design-system/src/icons/product-icons/productChalets.svg?raw'
import serviceOverflowSvg from '@alm-design/design-system/src/icons/visual-icons/serviceOverflow.svg?raw'
import homeSvg from '../assets/icons/home.svg?raw'
import compassSvg from '@alm-design/design-system/src/icons/line-icons/compass.svg?raw'
import calendarStartSvg from '../assets/icons/calendarStart.svg?raw'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import userSvg from '@alm-design/design-system/src/icons/line-icons/user.svg?raw'

import esimChip from '../assets/esim-flow/figma/esim-chip.png'
import londonHero from '../assets/images/london-hero.jpg'
import activityThumb from '../assets/images/activity-thumb.jpg'
import dealCard1 from '../assets/images/deal-card-1.jpg'
import dealCard2 from '../assets/images/deal-card-2.jpg'
import dealCard3 from '../assets/images/deal-card-3.jpg'
import dealCard4 from '../assets/images/deal-card-4.jpg'

import './HomepageScreen.css'

const PRODUCT_CARDS = [
  { key: 'flights', icon: productFlightsSvg },
  { key: 'stays', icon: productStaysSvg },
  { key: 'activities', icon: productActivitiesSvg },
]

const QUICK_LINKS = [
  { key: 'transfers', icon: quicklink1Svg },
  { key: 'train', icon: quicklink2Svg },
  { key: 'sixflags', icon: quicklink3Svg },
  { key: 'more', icon: quicklink4Svg },
]

const DEALS = [
  { key: 'deal1', image: dealCard1, code: 'TRAVEL' },
  { key: 'deal2', image: dealCard2, code: 'STAYLONG' },
  { key: 'deal3', image: dealCard3, code: 'UMRAH' },
  { key: 'deal4', image: dealCard4, code: 'TRANSFER' },
]

const BANNER_VARIANTS = ['layered', 'tint', 'row']

export default function HomepageScreen({ onViewEsims, onTopup, esimTab = 0, bannerStyle = 0 }) {
  const { t } = useLanguage()
  const bannerVariant = BANNER_VARIANTS[bannerStyle] ?? 'layered'

  const productLabels = { flights: t.homepage.flights, stays: t.homepage.stays, activities: t.homepage.activities }
  const quickLinkLabels = {
    transfers: t.homepage.airportTransfers,
    train: t.homepage.haramainTrain,
    sixflags: t.homepage.sixFlagsQiddiya,
    more: t.homepage.seeMore,
  }
  const dealTitles = t.homepage.deals

  const tabItems = [
    { icon: <Icon svg={homeSvg} size={24} />, label: t.tabBar.home },
    { icon: <Icon svg={compassSvg} size={24} />, label: t.tabBar.explore },
    { icon: <Icon svg={calendarStartSvg} size={24} />, label: t.tabBar.myTrips },
    { icon: <Icon svg={discountSvg} size={24} />, label: t.tabBar.topOffers },
    { icon: <Icon svg={userSvg} size={24} />, label: t.tabBar.profile },
  ]

  return (
    <div className="homepage">
      <div className="homepage__scroll">
        <header className="hp-header">
          <StatusBar />
          <div className="hp-welcome">
            <div className="hp-welcome__row">
              <div className="hp-welcome__profile">
                <span className="hp-welcome__avatar">
                  <IllustrationIcon svg={avatarIconSvg} size={36} />
                </span>
                <div className="hp-welcome__copy">
                  <p className="hp-welcome__name">{t.homepage.greeting}</p>
                  <p className="hp-welcome__prompt">{t.homepage.prompt}</p>
                </div>
              </div>

              <div className="hp-welcome__points">
                <div className="hp-welcome__points-row">
                  <span className="hp-welcome__wallet">
                    <IllustrationIcon svg={walletIllustrationSvg} size={24} />
                  </span>
                  <span className="hp-welcome__points-value">1,200</span>
                </div>
                <span className="hp-welcome__points-label">{t.homepage.almosaferPoints}</span>
              </div>
            </div>
          </div>

          <div className="hp-products">
            {PRODUCT_CARDS.map((card) => (
              <div className="hp-product-card" key={card.key}>
                <IllustrationIcon svg={card.icon} size={48} className="hp-product-card__icon" />
                <span className="hp-product-card__label">{productLabels[card.key]}</span>
              </div>
            ))}
          </div>

          <div className="hp-quicklinks">
            {QUICK_LINKS.map((link) => (
              <div className="hp-quicklink" key={link.key}>
                <div className="hp-quicklink__icon-wrap">
                  <IllustrationIcon svg={link.icon} size={40} className="hp-quicklink__icon" />
                </div>
                <span className="hp-quicklink__label">{quickLinkLabels[link.key]}</span>
              </div>
            ))}
          </div>
        </header>

        <div className="homepage__body">
          {esimTab === 0 ? (
            <EsimStatusBanner
              variant={bannerVariant}
              tone="install"
              icon={esimChip}
              title={t.homepage.esimBannerTitle}
              desc={t.homepage.esimBannerDesc}
              installedCount={0}
              installedTotal={2}
              statLabel={t.common.installedCount(0, 2)}
              buttonLabel={t.common.install}
              onAction={onViewEsims}
            />
          ) : (
            <EsimStatusBanner
              variant={bannerVariant}
              tone="lowdata"
              icon={esimChip}
              title={t.homepage.esimLowBannerTitle}
              desc={t.common.gbLeftOf(0.4, 4)}
              percent={12}
              statLabel={t.common.percentRemaining(12, 2)}
              buttonLabel={t.common.topup}
              onAction={onTopup}
            />
          )}

          <section className="hp-section">
            <SectionTitle title={t.homepage.upcomingTrip} actionLabel={t.common.viewAll} size="compact" />

            <div className="hp-trip-thread">
              <div className="hp-trip-card">
                <div className="hp-trip-card__media">
                  <img src={londonHero} alt={t.homepage.london} className="hp-trip-card__image" />
                  <div className="hp-trip-card__scrim" />
                  <div className="hp-trip-card__hero-text">
                    <p className="hp-trip-card__city">{t.homepage.london}</p>
                    <p className="hp-trip-card__dates">{t.homepage.londonDates}</p>
                  </div>
                </div>
                <div className="hp-trip-card__info">
                  <p className="hp-trip-card__hotel">{t.homepage.hotelName}</p>
                  <Tag label={t.common.confirmed} variant="success" style="tinted" />
                </div>
              </div>

              <div className="hp-thread-connector" />

              <div className="hp-thread-card">
                <p className="hp-enhance__label">{t.homepage.enhanceYourTrip}</p>
                <div className="hp-enhance__row">
                  <Icon svg={addonAirportTransferSvg} size={40} />
                  <div className="hp-enhance__text">
                    <p className="hp-enhance__title">{t.homepage.addonTransferTitle}</p>
                    <p className="hp-enhance__subtitle">{t.homepage.addonTransferSubtitle}</p>
                    <div className="hp-enhance__price-row">
                      <Price value="66" strikethrough color="var(--text-warning-default)" />
                      <Price value="45" color="var(--text-link-default)" />
                    </div>
                  </div>
                  <Icon svg={chevronRightSvg} size={16} className="hp-enhance__chevron" />
                </div>
                <div className="hp-enhance__row">
                  <Icon svg={addonInsuranceSvg} size={40} />
                  <div className="hp-enhance__text">
                    <p className="hp-enhance__title">{t.homepage.addonInsuranceTitle}</p>
                    <p className="hp-enhance__subtitle">{t.homepage.addonInsuranceSubtitle}</p>
                    <div className="hp-enhance__price-row">
                      <Price value="66" strikethrough color="var(--text-warning-default)" />
                      <Price value="45" color="var(--text-link-default)" />
                    </div>
                  </div>
                  <Icon svg={chevronRightSvg} size={16} className="hp-enhance__chevron" />
                </div>
              </div>
              <div className="hp-thread-connector" />
              <div className="hp-thread-card hp-thread-card--row">
                <img src={activityThumb} alt="" className="hp-thread-card__thumb" />
                <div className="hp-thread-card__text">
                  <p className="hp-thread-card__title">{t.homepage.findActivities}</p>
                  <p className="hp-thread-card__subtitle">{t.homepage.bookTours}</p>
                </div>
                <Icon svg={chevronRightSvg} size={24} className="hp-thread-card__chevron" />
              </div>
            </div>
          </section>

          <section className="hp-section">
            <SectionTitle title={t.homepage.specialDeals} actionLabel={t.common.viewAll} size="compact" />
            <div className="hp-deals-grid">
              {DEALS.map((deal) => (
                <div className="hp-deal-card" key={deal.key}>
                  <img src={deal.image} alt="" className="hp-deal-card__image" />
                  <div className="hp-deal-card__content">
                    <p className="hp-deal-card__title">{dealTitles[deal.key]}</p>
                    <div className="hp-deal-card__code">
                      <span>
                        {t.homepage.code}: <strong>{deal.code}</strong>
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <TabBar items={tabItems} value={0} onChange={() => {}} className="homepage__tabbar" />
    </div>
  )
}
