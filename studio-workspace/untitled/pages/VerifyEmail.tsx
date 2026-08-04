import '@alm-design/design-system/dist/index.css'
import '../components/screen.css'
import envelopeSvg from '@alm-design/design-system/src/icons/line-icons/envelope.svg?raw'
import { StatusBar, BackRow, Icon, OtpRow } from '../components/screen'
import styles from './VerifyEmail.module.css'

export default function VerifyEmail() {
  return (
    <div className={styles.screen} dir="ltr">
      <StatusBar />
      <div className={styles.body}>
        <BackRow />
        <h1 className={styles.title}>Enter Verification Code</h1>
        <p className={styles.subtitle}>Enter the 6-digit code sent via:</p>
        <div className={styles.channel}>
          <Icon svg={envelopeSvg} />
          <span className={styles.channelText}>Email at emal@domain.com</span>
        </div>
        <OtpRow />
        <p className={styles.resend}>Resend in 29 seconds</p>
      </div>
    </div>
  )
}
