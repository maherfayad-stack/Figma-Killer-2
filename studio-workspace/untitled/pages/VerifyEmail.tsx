import '@alm-design/design-system/dist/index.css'
import styles from './Verify.module.css'
import { SheetHandle } from './components/SheetHandle'
import { OtpInput } from './components/OtpInput'
import { ChevronLeft, IconEnvelope } from './components/icons'

export default function VerifyEmail() {
  return (
    <div className={styles.screen}>
      <SheetHandle />
      <div className={styles.sheet}>
        <button className={styles.backBtn} aria-label="Back" type="button">
          <ChevronLeft />
        </button>
        <h1 className={styles.title}>Enter Verification Code</h1>
        <p className={styles.intro}>Enter the 6-digit code sent via:</p>
        <div className={styles.channel}>
          <span className={styles.channelIcon}><IconEnvelope /></span>
          <span className={styles.channelBold}>Email</span>
          <span className={styles.channelPrefix}> at </span>
          <span className={styles.channelBold}>emal@domain.com</span>
        </div>
        <div className={styles.otp}>
          <OtpInput />
        </div>
        <p className={styles.resend}>
          <span className={styles.resendPrefix}>Resend in </span>
          <span className={styles.resendBold}>29 seconds</span>
        </p>
      </div>
    </div>
  )
}
