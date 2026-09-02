import { ChevronLeftIcon } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import smsIconSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import styles from './SMS.module.css'

export default function SMS() {
  return (
    <main className={styles.page}>
      <div className={styles.backRow}>
        <button className={styles.backButton} aria-label="Back" type="button">
          <ChevronLeftIcon className={styles.backIcon} />
        </button>
      </div>

      <div className={styles.body}>
        <h1 className={styles.title}>Enter Verification Code</h1>

        <p className={styles.helper}>Enter the 6-digit code sent via:</p>

        <div className={styles.channelRow}>
          <span
            className={styles.channelIcon}
            dangerouslySetInnerHTML={{ __html: smsIconSvg }}
          />
          <span className={styles.channelText}>
            <strong>SMS</strong> at <strong>+966 55 333 4444</strong>
          </span>
        </div>

        <div className={styles.codeGrid}>
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 1" />
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 2" />
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 3" />
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 4" />
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 5" />
          <input className={styles.codeCell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 6" />
        </div>

        <p className={styles.resend}>
          Resend in <strong className="resent-in test">{"Resend in "}</strong>
        </p>
      </div>

      <div className={styles.keyboard}>
        <span className={styles.key}>1</span>
        <span className={styles.key}>2</span>
        <span className={styles.key}>3</span>
        <span className={styles.key}>4</span>
        <span className={styles.key}>5</span>
        <span className={styles.key}>6</span>
        <span className={styles.key}>7</span>
        <span className={styles.key}>8</span>
        <span className={styles.key}>9</span>
        <span className={styles.keyBlank}>&nbsp;</span>
        <span className={styles.key}>0</span>
        <span className={styles.keyBackspace} aria-hidden="true">⌫</span>
      </div>
    </main>
  )
}
