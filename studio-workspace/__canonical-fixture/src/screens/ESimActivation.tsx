import styles from './ESimActivation.module.css'
import { Button, Tag } from '@alm-design/design-system'

export default function ESimActivation() {
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <span className={styles.closeLink}>Close</span>
        <h2 className={styles.headerTitle}>Booking confirmed</h2>
        <span className={styles.headerSpacer} />
      </header>

      <div className={styles.hero}>
        <div className={styles.brandIcons}>
          <div className={styles.airlineBadge}>
            <svg viewBox="0 0 44 44" width="44" height="44">
              <circle cx="22" cy="22" r="22" fill="#E8002D" />
              <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" fontSize="22" fill="#fff">✈</text>
            </svg>
          </div>
          <div className={styles.checkBadge}>
            <svg viewBox="0 0 36 36" width="36" height="36">
              <circle cx="18" cy="18" r="18" fill="#319E37" />
              <path d="M10 18l6 6 10-10" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
        <h1 className={styles.heroTitle}>Your booking is confirmed</h1>
        <p className={styles.heroSubtitle}>Round-trip | RUH to CAI | Feb – 10 Feb</p>
        <div className={styles.heroAction}>
          <Button variant="secondary" size="medium" label="Booking details" />
        </div>
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Complete your trip</h3>

        <div className={styles.card}>
          <div className={styles.cardBadge}>
            <Tag label="Exclusive rates on hotels" variant="default" style="tinted" />
          </div>
          <div className={styles.cardRow}>
            <svg className={styles.cardEmoji} viewBox="0 0 40 40" width="40" height="40">
              <rect width="40" height="40" rx="8" fill="#E9F6F8" />
              <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" fontSize="22">🏨</text>
            </svg>
            <div className={styles.cardText}>
              <strong className={styles.cardTitle}>Enjoy 12% discount on hotels</strong>
              <p className={styles.cardSubtext}>Special hotel deals with your flight booking.</p>
            </div>
          </div>
          <div className={styles.cardFooter}>
            <span className={styles.cardCode}>Use code: <strong>CSSTAY12</strong></span>
            <Button variant="secondary" size="small" label="View hotels" />
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardRow}>
            <svg className={styles.cardEmoji} viewBox="0 0 40 40" width="40" height="40">
              <rect width="40" height="40" rx="8" fill="#EDF1F3" />
              <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" fontSize="22">🚗</text>
            </svg>
            <div className={styles.cardText}>
              <strong className={styles.cardTitle}>Skip the Taxi Queue</strong>
              <p className={styles.cardSubtext}>Your professional driver will be waiting at arrivals to take you straight to your door.</p>
            </div>
          </div>
          <div className={styles.cardFooter}>
            <span className={styles.cardCode}>SAR 69 · For all travellers</span>
            <Button variant="secondary" size="small" label="Reserve now" />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Purchased Add-ons</h3>
        <div className={styles.card}>
          <div className={styles.addonRow}>
            <svg className={styles.simIcon} viewBox="0 0 40 40" width="40" height="40">
              <rect width="40" height="40" rx="8" fill="#EDF1F3" />
              <rect x="10" y="8" width="20" height="26" rx="2" fill="#8B9EA5" />
              <path d="M10 14 L16 8 H24" stroke="#8B9EA5" strokeWidth="0" fill="#8B9EA5" />
              <polygon points="10,14 16,8 24,8 24,8 10,14" fill="#6B7E84" />
              <rect x="13" y="18" width="14" height="10" rx="1.5" fill="#5B7078" />
              <rect x="15" y="20" width="3" height="2" rx="0.5" fill="#A8B9BF" />
              <rect x="19" y="20" width="3" height="2" rx="0.5" fill="#A8B9BF" />
              <rect x="23" y="20" width="2" height="2" rx="0.5" fill="#A8B9BF" />
              <rect x="15" y="23" width="3" height="2" rx="0.5" fill="#A8B9BF" />
              <rect x="19" y="23" width="3" height="2" rx="0.5" fill="#A8B9BF" />
              <rect x="23" y="23" width="2" height="2" rx="0.5" fill="#A8B9BF" />
            </svg>
            <div className={styles.addonText}>
              <strong className={styles.addonTitle}>eSIM</strong>
              <p className={styles.addonSubtext}>Activate it now so it's ready before you travel.</p>
            </div>
            <Button variant="primary" size="small" label="Activate" />
          </div>
        </div>
      </section>
    </div>
  )
}
