import { ChevronLeftIcon } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import smsIcon from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import styles from './Sms.module.css'

export default function Sms() {
  return (
    <main className={styles.page}>
      <button type="button" className={styles.back} aria-label="Back">
        <ChevronLeftIcon className={styles.backIcon} />
      </button>
      <div className={styles.body}>
        <h1 className={styles.title}>Enter Verification Code</h1>
        <div className={styles.instructions}>
          <p className={styles.line1}>Enter the 6-digit code sent via:</p>
          <div className={styles.channel}>
            <span className={styles.channelIcon} dangerouslySetInnerHTML={{ __html: smsIcon }} />
            <p className={styles.channelText}>
              <span className={styles.channelStrong}>SMS</span>
              <span className={styles.channelDim}> at </span>
              <span className={styles.channelStrong}>+966 55 333 4444</span>
            </p>
          </div>
        </div>
        <div className={styles.codeInputs}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={styles.codeBox} />
          ))}
        </div>
        <p className={styles.resend}>
          <span>Resend in </span>
          <span className={styles.resendStrong}>29 seconds</span>
        </p>
      </div>
    </main>
  )
}
