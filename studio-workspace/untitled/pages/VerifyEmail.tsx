import envelopeSvg from '@alm-design/design-system/src/icons/line-icons/envelope.svg?raw'
import { Screen } from '../components/Screen'
import styles from './VerifyCode.module.css'

export default function VerifyEmail() {
  return (
    <Screen>
      <h1 className={styles.title}>Enter Verification Code</h1>

      <div className={styles.destination}>
        <p className={styles.destinationLabel}>Enter the 6-digit code sent via:</p>
        <div className={styles.destinationRow}>
          <span className={styles.destinationIcon} dangerouslySetInnerHTML={{ __html: envelopeSvg }} />
          <span className={styles.destinationValue}>Email at email@domain.com</span>
        </div>
      </div>

      <div className={styles.codeInputs}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <input
            key={i}
            className={styles.codeCell}
            inputMode="numeric"
            maxLength={1}
            aria-label={`Digit ${i + 1}`}
          />
        ))}
      </div>

      <p className={styles.resend}>Resend in 29 seconds</p>
    </Screen>
  )
}
