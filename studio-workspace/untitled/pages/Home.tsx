import styles from './Home.module.css'

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <div className={styles.statusBar}>
          <span className={styles.statusTime}>9:41</span>
          <span className={styles.statusLevels}>
            <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden="true">
              <rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor" />
              <rect x="5" y="6" width="3" height="6" rx="1" fill="currentColor" />
              <rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor" />
              <rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor" />
            </svg>
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-hidden="true">
              <path d="M8 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" fill="currentColor" />
              <path d="M2 5.5a8.5 8.5 0 0112 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
              <path d="M4.5 8a5 5 0 017 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
            <svg width="26" height="12" viewBox="0 0 26 12" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" fill="none" />
              <rect x="2" y="2" width="19" height="8" rx="1.5" fill="currentColor" />
              <rect x="23" y="4" width="2" height="4" rx="1" fill="currentColor" />
            </svg>
          </span>
        </div>

        <div className={styles.body}>
          <div className={styles.lockPreview} aria-hidden="true">
            <div className={styles.lockDate}>Sunday, March 10</div>
            <div className={styles.lockTime}>9:41</div>
            <div className={styles.notificationCard}>
              <div className={styles.notificationAppIcon}>A</div>
              <div className={styles.notificationBody}>
                <div className={styles.notificationHeader}>
                  <span className={styles.notificationAppName}>Almosafer</span>
                  <span className={styles.notificationTime}>9:41 AM</span>
                </div>
                <p className={styles.notificationText}>
                  Good news! A few hotels you were interested in just had a 30% price drop
                </p>
              </div>
            </div>
          </div>

          <h1 className={styles.heading}>
            Complete your setup. Don&rsquo;t miss out on:
          </h1>

          <ul className={styles.benefits}>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Unique rates via WhatsApp, email, and SMS!</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 17L9 11L13 15L21 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M15 7H21V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Price drops before they are gone</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M13 3L4 14H11L10 21L20 10H13L13 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Flash sales</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              <span>Offers picked for you</span>
            </li>
          </ul>

          <div className={styles.actionGroup}>
            <button type="button" className={styles.primaryBtn}>Agree</button>
            <button type="button" className={styles.secondaryBtn}>Maybe later</button>
          </div>

          <p className={styles.legal}>
            By clicking Agree, I consent to receiving communications and acknowledge the{' '}
            <a href="#" className={styles.legalLink}>privacy policy</a> and{' '}
            <a href="#" className={styles.legalLink}>terms and conditions</a>. You can opt-out anytime.
          </p>
        </div>
      </div>
    </main>
  )
}
