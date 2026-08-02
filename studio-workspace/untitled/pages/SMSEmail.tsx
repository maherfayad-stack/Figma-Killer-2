import styles from './SMSEmail.module.css'

export default function SMSEmail() {
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
          <h1 className={styles.heading}>Enter Verification Code</h1>

          <div className={styles.instruction}>
            <div className={styles.instructionLead}>Enter the 6-digit code sent via:</div>
            <div className={styles.channelRow}>
              <svg className={styles.channelIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="5.5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
                <path d="M4 7L12 13L20 7" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
              </svg>
              <span className={styles.channelStrong}>Email</span>
              <span className={styles.channelJoiner}>at</span>
              <span className={styles.channelStrong}>emal@domain.com</span>
            </div>
          </div>

          <div className={styles.otpRow} role="group" aria-label="Verification code">
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 1" />
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 2" />
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 3" />
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 4" />
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 5" />
            <input className={styles.otpBox} inputMode="numeric" maxLength={1} aria-label="Digit 6" />
          </div>

          <div className={styles.resend}>
            Resend in <span className={styles.resendStrong}>29 seconds</span>
          </div>
        </div>
      </div>
    </main>
  )
}
