import styles from './ESimActivation.module.css'
import { Button } from '@alm-design/design-system'

type Lang = 'en' | 'ar'

const COPY = {
  en: {
    close: 'Close',
    headerTitle: 'Booking confirmed',
    heroTitle: 'Your booking is confirmed',
    heroSubtitle: 'Round-trip | RUH to CAI | Feb – 10 Feb',
    bookingDetails: 'Booking details',
    completeYourTrip: 'Complete your trip',
    exclusiveRates: 'Exclusive rates on hotels',
    hotelTitle: 'Enjoy 12% discount on hotels',
    hotelSubtitle: 'Special hotel deals with your flight booking.',
    useCode: 'Use code:',
    hotelCode: 'CSSTAY12',
    viewHotels: 'View hotels',
    taxiTitle: 'Skip the Taxi Queue',
    taxiSubtitle: 'Your professional driver will be waiting at arrivals to take you straight to your door.',
    taxiPrice: 'SAR 69 · For all travellers',
    reserveNow: 'Reserve now',
    addOns: 'Purchased Add-ons',
    esimTitle: 'eSIM',
    esimSubtitle: "Activate it now so it's ready before you travel.",
    activate: 'Activate',
  },
  ar: {
    close: 'إغلاق',
    headerTitle: 'تم تأكيد الحجز',
    heroTitle: 'تم تأكيد حجزك',
    heroSubtitle: 'ذهاب وعودة | الرياض إلى القاهرة | ٢ – ١٠ فبراير',
    bookingDetails: 'تفاصيل الحجز',
    completeYourTrip: 'أكمل رحلتك',
    exclusiveRates: 'أسعار حصرية على الفنادق',
    hotelTitle: 'استمتع بخصم ١٢٪ على الفنادق',
    hotelSubtitle: 'عروض فندقية خاصة مع حجز طيرانك.',
    useCode: 'استخدم الرمز:',
    hotelCode: 'CSSTAY12',
    viewHotels: 'عرض الفنادق',
    taxiTitle: 'تخطَّ طابور سيارات الأجرة',
    taxiSubtitle: 'سيكون سائقك المحترف في انتظارك عند الوصول ليأخذك مباشرةً إلى وجهتك.',
    taxiPrice: '٦٩ ر.س · لجميع المسافرين',
    reserveNow: 'احجز الآن',
    addOns: 'الإضافات المشتراة',
    esimTitle: 'شريحة eSIM',
    esimSubtitle: 'فعّلها الآن لتكون جاهزة قبل سفرك.',
    activate: 'تفعيل',
  },
} as const

export default function ESimActivation({ lang = 'en' }: { lang?: Lang } = {}) {
  const t = COPY[lang]
  const isRtl = lang === 'ar'
  return (
    <div className={styles.frame} dir={isRtl ? 'rtl' : 'ltr'} lang={lang}>
      <div className={styles.statusBar}>
        <span className={styles.statusTime}>22:53</span>
        <div className={styles.statusIcons}>
          <svg width="18" height="11" viewBox="0 0 18 11" fill="none">
            <rect x="0" y="7" width="3" height="4" rx="0.5" fill="#fff" />
            <rect x="5" y="5" width="3" height="6" rx="0.5" fill="#fff" />
            <rect x="10" y="2.5" width="3" height="8.5" rx="0.5" fill="#fff" />
            <rect x="15" y="0" width="3" height="11" rx="0.5" fill="#fff" />
          </svg>
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
            <path d="M8 3c2.5 0 4.8 1 6.5 2.6l-1.4 1.4A6.9 6.9 0 0 0 8 5a6.9 6.9 0 0 0-5.1 2L1.5 5.6A9 9 0 0 1 8 3Z" fill="#fff" />
            <path d="M8 6.5c1.7 0 3.2.6 4.3 1.6l-1.4 1.4A3.5 3.5 0 0 0 8 8.5a3.5 3.5 0 0 0-2.9 1L3.7 8.1A6 6 0 0 1 8 6.5Z" fill="#fff" />
            <circle cx="8" cy="10.5" r="1.2" fill="#fff" />
          </svg>
          <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
            <rect x="0.5" y="0.5" width="23" height="12" rx="3" stroke="#fff" opacity="0.6" />
            <rect x="2" y="2" width="20" height="9" rx="1.5" fill="#fff" />
            <rect x="24" y="4" width="2" height="5" rx="0.5" fill="#fff" opacity="0.6" />
          </svg>
        </div>
      </div>

      <div className={styles.screen}>
        <header className={styles.header}>
          <span className={styles.closeLink}>{t.close}</span>
          <h2 className={styles.headerTitle}>{t.headerTitle}</h2>
          <span className={styles.headerSpacer} />
        </header>

        <div className={styles.hero}>
          <div className={styles.brandIcons}>
            <div className={styles.airlineBadge}>
              <svg viewBox="0 0 40 40" width="40" height="40">
                <circle cx="20" cy="20" r="20" fill="#E8002D" />
                <path
                  d="M27 12c-2 1-4 3-6 5.5-1.5-.3-3-.1-4 .6 1 0 1.8.3 2.5.8-1.5 2.2-2.6 4.8-3.2 7.4.8-.3 1.7-.7 2.5-1.3 1 .5 2 .8 3.2.8-.8-.4-1.3-1-1.6-1.7 1.2-1 2.5-2.1 3.6-3.4 1 .3 1.9.3 2.7 0-.7-.2-1.3-.6-1.7-1.1 1.2-1.7 2-3.4 2.5-5.1-1 .3-2 .8-2.8 1.3-.2-.9-.7-1.7-1.2-2.3-.3-.3-.8-.4-1.2-.2.7.3 1.2.9 1.5 1.6.1.3.2.6.2.9-.9.7-1.8 1.5-2.6 2.4-.3-.5-.7-1-1.1-1.2.7.3 1.3.7 1.7 1.3Z"
                  fill="#fff"
                />
              </svg>
            </div>
            <div className={styles.checkBadge}>
              <svg viewBox="0 0 36 36" width="36" height="36">
                <circle cx="18" cy="18" r="18" fill="#319E37" />
                <path d="M10 18l6 6 10-10" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
          <h1 className={styles.heroTitle}>{t.heroTitle}</h1>
          <p className={styles.heroSubtitle}>{t.heroSubtitle}</p>
          <button type="button" className={`${styles.outlinePill} ${styles.outlinePillLarge}`}>
            {t.bookingDetails}
          </button>
        </div>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t.completeYourTrip}</h3>

          <div className={styles.card}>
            <div className={styles.cardBadge}>
              <span className={styles.aquaTag}>{t.exclusiveRates}</span>
            </div>
            <div className={styles.cardRow}>
              <div className={styles.illoWrap}>
                <svg viewBox="0 0 44 44" width="44" height="44">
                  <rect x="8" y="14" width="28" height="26" fill="#7BB8CC" />
                  <rect x="8" y="10" width="28" height="6" fill="#5AA0B8" />
                  <rect x="11" y="16" width="22" height="4" fill="#fff" />
                  <text x="22" y="19.2" textAnchor="middle" fontSize="3.2" fill="#3B7A8E" fontWeight="700" fontFamily="Arial">HOTEL</text>
                  <rect x="11" y="22" width="4" height="4" fill="#B7DCE8" />
                  <rect x="16" y="22" width="4" height="4" fill="#B7DCE8" />
                  <rect x="24" y="22" width="4" height="4" fill="#B7DCE8" />
                  <rect x="29" y="22" width="4" height="4" fill="#B7DCE8" />
                  <rect x="11" y="28" width="4" height="4" fill="#B7DCE8" />
                  <rect x="16" y="28" width="4" height="4" fill="#B7DCE8" />
                  <rect x="24" y="28" width="4" height="4" fill="#B7DCE8" />
                  <rect x="29" y="28" width="4" height="4" fill="#B7DCE8" />
                  <rect x="19" y="34" width="6" height="6" fill="#3B7A8E" />
                  <circle cx="23.5" cy="37" r="0.4" fill="#F5C842" />
                </svg>
              </div>
              <div className={styles.cardText}>
                <strong className={styles.cardTitle}>{t.hotelTitle}</strong>
                <p className={styles.cardSubtext}>{t.hotelSubtitle}</p>
              </div>
            </div>
            <div className={styles.cardFooter}>
              <span className={styles.cardCode}>{t.useCode} <strong>{t.hotelCode}</strong></span>
              <button type="button" className={styles.outlinePill}>{t.viewHotels}</button>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardRow}>
              <div className={styles.illoWrap}>
                <svg viewBox="0 0 54 32" width="54" height="32">
                  <path
                    d="M2 22 L6 14 C7 11.5 9.5 10 12 10 L20 8 C24 7 30 7 34 8 L42 10 C44.5 10 47 11.5 48 14 L52 22 L52 26 C52 27 51 28 50 28 L46 28 L46 25 L8 25 L8 28 L4 28 C3 28 2 27 2 26 Z"
                    fill="#8DB9DE"
                  />
                  <path
                    d="M10 14 C11 12 13 11 15 11 L20 10 C24 9 30 9 34 10 L39 11 C41 11 43 12 44 14 L47 21 L7 21 Z"
                    fill="#B8D5EA"
                  />
                  <path d="M10 14 L14 21 L26 21 L26 10 L20 10 C17 10 12 11 10 14 Z" fill="#DCE9F2" opacity="0.85" />
                  <path d="M44 14 L40 21 L28 21 L28 10 L34 10 C37 10 42 11 44 14 Z" fill="#DCE9F2" opacity="0.85" />
                  <line x1="27" y1="10" x2="27" y2="21" stroke="#8DB9DE" strokeWidth="0.5" />
                  <circle cx="13" cy="26" r="4" fill="#1A1A1A" />
                  <circle cx="13" cy="26" r="1.5" fill="#555" />
                  <circle cx="41" cy="26" r="4" fill="#1A1A1A" />
                  <circle cx="41" cy="26" r="1.5" fill="#555" />
                </svg>
              </div>
              <div className={styles.cardText}>
                <strong className={styles.cardTitle}>{t.taxiTitle}</strong>
                <p className={styles.cardSubtext}>{t.taxiSubtitle}</p>
              </div>
            </div>
            <div className={styles.cardFooter}>
              <span className={styles.cardCode}>{t.taxiPrice}</span>
              <button type="button" className={styles.outlinePill}>{t.reserveNow}</button>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t.addOns}</h3>
          <div className={styles.card}>
            <div className={styles.addonRow}>
              <div className={styles.simWrap}>
                <svg viewBox="0 0 36 44" width="36" height="44">
                  <path
                    d="M2 6 C2 4 3 3 5 3 L22 3 L34 15 L34 38 C34 40 33 41 31 41 L5 41 C3 41 2 40 2 38 Z"
                    fill="#F5C842"
                  />
                  <path d="M22 3 L34 15 L24 15 C23 15 22 14 22 13 Z" fill="#D9A82F" />
                  <rect x="7" y="19" width="22" height="16" rx="2" fill="#7DBE7E" />
                  <path
                    d="M7 23 L29 23 M7 27 L29 27 M7 31 L29 31 M13 19 L13 35 M19 19 L19 35 M25 19 L25 35"
                    stroke="#5FA361"
                    strokeWidth="0.8"
                  />
                </svg>
              </div>
              <div className={styles.addonText}>
                <strong className={styles.addonTitle}>{t.esimTitle}</strong>
                <p className={styles.addonSubtext}>{t.esimSubtitle}</p>
              </div>
              <Button variant="primary" size="small" label={t.activate} />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
