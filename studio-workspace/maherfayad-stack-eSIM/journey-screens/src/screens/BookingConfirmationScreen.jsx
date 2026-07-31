import { Button, Cell, Separator, Tag } from '@alm-design/design-system'
import SheetShell from '../components/SheetShell'
import SectionTitle from '../components/SectionTitle'
import Icon from '../components/Icon'
import Price from '../components/Price'
import checkSvg from '../assets/misc/check-line.svg?raw'
import airlineLogoSvg from '../assets/misc/airline-logo.svg?raw'
import productHotelSvg from '@alm-design/design-system/src/icons/product-icons/productHotel.svg?raw'
import addonAirportTransferSvg from '@alm-design/design-system/src/icons/visual-icons/addonAirportTransfer.svg?raw'
import addonSmartCheckInSvg from '@alm-design/design-system/src/icons/visual-icons/addonSmartCheckIn.svg?raw'
import addonBaggageProtectionSvg from '@alm-design/design-system/src/icons/visual-icons/addonBaggageProtection.svg?raw'
import rewardCardSvg from '@alm-design/design-system/src/icons/line-icons/rewardCard.svg?raw'
import creditCardSvg from '@alm-design/design-system/src/icons/line-icons/creditCard.svg?raw'
import questionCircleSvg from '../assets/icons/questionCircle.svg?raw'
import headsetSvg from '@alm-design/design-system/src/icons/line-icons/headset.svg?raw'
import esimChip from '../assets/esim-flow/figma/esim-chip.png'
import { useLanguage } from '../i18n/LanguageContext'
import './BookingConfirmationScreen.css'

const ADD_ONS = [
  { key: 'esim', image: esimChip },
  { key: 'checkin', icon: addonSmartCheckInSvg },
  { key: 'baggage', icon: addonBaggageProtectionSvg },
]

export default function BookingConfirmationScreen({ onClose }) {
  const { t } = useLanguage()
  const c = t.bookingConfirmation
  const addonCopy = {
    esim: { title: t.common.esimLabel, subtext: c.esimSubtext },
    checkin: { title: c.autoCheckIn },
    baggage: { title: c.baggageProtection },
  }

  return (
    <SheetShell title={c.title} onClose={onClose} className="booking-confirmation">
      <div className="booking-confirmation__scroll">
      <div className="booking-confirmation__body">
        <section className="bc-success">
          <div className="bc-success__logos">
            <div className="bc-success__logo-badge">
              <Icon svg={airlineLogoSvg} size={44} className="bc-success__logo-icon" />
            </div>
            <div className="bc-success__check-badge">
              <Icon
                svg={checkSvg}
                size={24}
                className="bc-success__check-icon"
                style={{ '--stroke-0': 'var(--color-white-static, #fff)' }}
              />
            </div>
          </div>
          <div className="bc-success__text">
            <p className="bc-success__title">{c.heading}</p>
            <p className="bc-success__subtitle">{c.subtitle}</p>
          </div>
          <Button variant="primary-inverted" size="small" label={c.bookingDetails} />
        </section>

        <section className="bc-section">
          <SectionTitle title={c.completeYourTrip} />

          <div className="bc-cards">
            <div className="bc-card">
              <span className="bc-card__tag">{c.hotelsTag}</span>
              <div className="bc-card__row">
                <div className="bc-card__icon">
                  <Icon svg={productHotelSvg} size={40} />
                </div>
                <div className="bc-card__text">
                  <p className="bc-card__title">{c.hotelsTitle}</p>
                  <p className="bc-card__subtitle">{c.hotelsSubtitle}</p>
                </div>
              </div>
              <Separator />
              <div className="bc-card__footer">
                <p className="bc-card__code">
                  {c.useCode}: <strong>CSSTAY12</strong>
                </p>
                <Button variant="primary-inverted" size="small" label={c.viewHotels} />
              </div>
            </div>

            <div className="bc-card">
              <div className="bc-card__row">
                <div className="bc-card__icon">
                  <Icon svg={addonAirportTransferSvg} size={56} />
                </div>
                <div className="bc-card__text">
                  <p className="bc-card__title">{c.taxiTitle}</p>
                  <p className="bc-card__subtitle">
                    {c.taxiSubtitle}
                  </p>
                </div>
              </div>
              <Separator />
              <div className="bc-card__footer">
                <div className="bc-card__price">
                  <Price value="69" color="var(--text-base-default)" />
                  <span className="bc-card__price-label">{c.forAllTravellers}</span>
                </div>
                <Button variant="primary-inverted" size="small" label={c.reserveNow} />
              </div>
            </div>
          </div>
        </section>

        <section className="bc-section">
          <SectionTitle title={c.purchasedAddons} />
          <div className="bc-addons">
            {ADD_ONS.map((addOn, i) => (
              <div key={addOn.key}>
                <div className="bc-addons__row">
                  <div className="bc-addons__icon">
                    {addOn.image ? (
                      <img src={addOn.image} alt="" className="bc-addons__icon-img" />
                    ) : (
                      <Icon svg={addOn.icon} size={40} />
                    )}
                  </div>
                  <div className="bc-addons__text">
                    <p className="bc-addons__title">{addonCopy[addOn.key].title}</p>
                    {addonCopy[addOn.key].subtext && (
                      <p className="bc-addons__subtext">{addonCopy[addOn.key].subtext}</p>
                    )}
                  </div>
                  <Icon svg={checkSvg} size={24} className="bc-addons__check" />
                </div>
                {i < ADD_ONS.length - 1 && <Separator />}
              </div>
            ))}
          </div>
        </section>

        <section className="bc-section">
          <SectionTitle title={c.rewards} />
          <div className="bc-rewards">
            <Cell
              visual="icon"
              icon={<Icon svg={rewardCardSvg} size={24} />}
              label={c.mokafaaPoints}
              subtext={c.mobileNumber}
              trailing="chevron"
              showSeparator={false}
            />
            <Separator />
            <p className="bc-rewards__note">
              {c.rewardsNote}
            </p>
          </div>
        </section>

        <section className="bc-section">
          <SectionTitle title={t.common.moreInformation} />
          <div className="bc-more">
            <Cell
              visual="icon"
              icon={<Icon svg={creditCardSvg} size={24} />}
              label={c.paymentDetails}
              subtext={c.paymentTotal}
              trailing="chevron"
            />
            <Cell
              visual="icon"
              icon={<Icon svg={questionCircleSvg} size={24} />}
              label={t.common.faqTitle}
              subtext={t.common.faqSubtext}
              trailing="chevron"
            />
            <Cell
              visual="icon"
              icon={<Icon svg={headsetSvg} size={24} />}
              label={t.common.needHelp}
              trailing="chevron"
              showSeparator={false}
            />
          </div>
        </section>
      </div>
      </div>
    </SheetShell>
  )
}
