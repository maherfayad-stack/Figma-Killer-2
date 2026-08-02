import styles from './SignIn.module.css'

export default function SignIn() {
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <div className={styles.statusBar}>
          <span className={styles.statusTime}>9:41</span>
          <span className={styles.statusIsland} />
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

        <div className={styles.toolbar}>
          <button type="button" className={styles.backBtn} aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.hero}>
            <div className={styles.heroMockA}>
              <div className={styles.heroMockNotch} />
              <div className={styles.heroMockClose}>Close</div>
              <div className={styles.heroMockTitle}>Sign in or create account</div>
              <div className={styles.heroMockFields}>
                <div className={styles.heroMockCode}>
                  <div className={styles.heroMockCodeLabel}>Code</div>
                  <div className={styles.heroMockCodeValue}>+966</div>
                </div>
                <div className={styles.heroMockMobile}>Mobile number *</div>
              </div>
              <div className={styles.heroMockCta}>Continue</div>
            </div>
            <div className={styles.heroMockB}>
              <div className={styles.heroMockNotch} />
              <div className={styles.heroMockTitleB}>Verification Code</div>
              <div className={styles.heroMockBodyB}>digit code sent via:</div>
              <div className={styles.heroMockPhoneB}>+966 55 333 4444</div>
            </div>
          </div>

          <h1 className={styles.heading}>Add your mobile number</h1>
          <p className={styles.subheading}>
            Sign in faster next time, and get Notified the moment something changes
          </p>

          <ul className={styles.benefits}>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 15L7 13L13 15L21 8L20 6L13 11L7 9L3 11.5V15Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
                <path d="M3 18H21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Live flight updates</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <path d="M3.5 9H20.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 3V6M16 3V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Boarding pass &amp; activity reminders</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 3L14 5L16.8 4.4L17.6 7.2L20.4 8L19.8 10.8L21.8 12.8L19.8 14.8L20.4 17.6L17.6 18.4L16.8 21.2L14 20.6L12 22.6L10 20.6L7.2 21.2L6.4 18.4L3.6 17.6L4.2 14.8L2.2 12.8L4.2 10.8L3.6 8L6.4 7.2L7.2 4.4L10 5L12 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
                <circle cx="9.5" cy="10.5" r="1" fill="currentColor" />
                <circle cx="14.5" cy="15" r="1" fill="currentColor" />
                <path d="M9 15L15 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>Flash sales</span>
            </li>
            <li className={styles.benefitRow}>
              <svg className={styles.benefitIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M13 3L4 14H11L10 21L20 10H13L13 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
              </svg>
              <span>One-tap sign-in next time</span>
            </li>
          </ul>

          <div className={styles.phoneRow}>
            <div className={styles.codeField}>
              <span className={styles.codeLabel}>Code</span>
              <div className={styles.codeValueRow}>
                <span className={styles.codeValue}>+966</span>
                <svg className={styles.codeChevron} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
            <div className={styles.mobileField}>
              <span className={styles.mobilePlaceholder}>
                Mobile number <span className={styles.required}>*</span>
              </span>
            </div>
          </div>

          <button type="button" className={styles.primaryBtn}>Verify Number</button>

          <p className={styles.footNote}>
            Updates by SMS or WhatsApp. No marketing spam.
          </p>
        </div>
      </div>
    </main>
  )
}
