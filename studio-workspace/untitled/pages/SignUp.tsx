import styles from './SignUp.module.css'

export default function SignUp() {
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
          <h1 className={styles.heading}>Sign in or create account</h1>

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

          <button type="button" className={styles.primaryBtn}>Continue</button>

          <button type="button" className={styles.textLink}>Register as a Business</button>

          <div className={styles.spacer} />

          <div className={styles.orDivider}>
            <span className={styles.orLine} />
            <span className={styles.orLabel}>OR</span>
            <span className={styles.orLine} />
          </div>

          <div className={styles.socialGroup}>
            <button type="button" className={styles.outlineBtn}>
              <svg className={styles.outlineIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
                <path d="M4 6.5L12 13L20 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
              </svg>
              Continue with email
            </button>

            <button type="button" className={styles.outlineBtnDark}>
              <svg className={styles.outlineIconDark} width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.05 12.72c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.63-1.71-3.2-1.73-1.36-.14-2.66.8-3.35.8-.7 0-1.76-.79-2.9-.76-1.49.02-2.87.87-3.64 2.2-1.56 2.7-.4 6.68 1.12 8.87.74 1.07 1.62 2.28 2.77 2.23 1.11-.04 1.53-.72 2.88-.72 1.34 0 1.72.72 2.9.7 1.2-.02 1.96-1.09 2.69-2.17.85-1.24 1.2-2.45 1.22-2.51-.03-.01-2.34-.9-2.37-3.56zM14.87 6.2c.62-.75 1.03-1.79.92-2.83-.89.04-1.97.59-2.6 1.34-.57.66-1.06 1.72-.93 2.73.99.08 2-.5 2.61-1.24z" />
              </svg>
              Continue with Apple
            </button>

            <button type="button" className={styles.outlineBtn}>
              <svg className={styles.googleIcon} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.12c-.22-.66-.35-1.36-.35-2.12s.13-1.46.35-2.12V7.04H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.96l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.04l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
              </svg>
              Continue with Google
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
