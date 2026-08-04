import { Button, TextInput, Separator, ChevronDownIcon } from '@alm-design/design-system'
import { Screen } from '../components/Screen'
import styles from './SignUp.module.css'

export default function SignUp() {
  return (
    <Screen>
      <h1 className={styles.title}>Sign in or create account</h1>

      <div className={styles.phoneRow}>
        <button type="button" className={styles.codeField}>
          <span className={styles.codeLabel}>Code</span>
          <span className={styles.codeValue}>+966</span>
          <ChevronDownIcon className={styles.chev} />
        </button>
        <div className={styles.numberField}>
          <TextInput label="Mobile number" required value="" onChange={() => {}} />
        </div>
      </div>

      <div className={styles.continueBtn}>
        <Button variant="primary" label="Continue" />
      </div>

      <a href="#" className={styles.link}>Register as a Business</a>

      <div className={styles.spacer} />

      <Separator variant="or" />

      <div className={styles.socialStack}>
        <Button variant="secondary" label="Continue with email" />

        <button type="button" className={`${styles.socialBtn} ${styles.apple}`}>
          <svg className={styles.socialIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17.05 20.28c-1.16 1.13-2.44.95-3.66.42-1.29-.55-2.47-.58-3.83 0-1.7.73-2.6.52-3.63-.42C.62 14.13 1.51 4.83 8.35 4.44c1.55.08 2.63.85 3.54.9 1.36-.28 2.66-1.08 4.12-.97 1.75.14 3.07.83 3.95 2.08-3.62 2.17-2.77 6.94.55 8.27-.66 1.72-1.51 3.42-3.46 5.56ZM12.03 4.38C11.87 2.15 13.71.24 15.87 0c.3 2.45-2.19 4.5-3.85 4.38Z" />
          </svg>
          <span>Continue with Apple</span>
        </button>

        <button type="button" className={`${styles.socialBtn} ${styles.google}`}>
          <svg className={styles.socialIcon} viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.3 0 10.1-2 13.7-5.3l-6.3-5.2C29.3 34.9 26.8 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.3 5.2C41 34.8 44 29.9 44 24c0-1.3-.1-2.7-.4-3.5z" />
          </svg>
          <span>Continue with Google</span>
        </button>
      </div>
    </Screen>
  )
}
