import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import SheetHeader from '../components/SheetHeader'
import styles from './SMS.module.css'
import { useLanguage } from '../i18n/LanguageContext'

export default function SMS() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <SheetHeader />
      </div>

      <div className={styles.banner}>
        <h1 className={styles.title}>{t.sMS.enterVerificationCode}</h1>

        <div className={styles.form}>
          <div className={styles.channel}>
            <p className={styles.channelLabel}>{t.sMS.enterThe6DigitCode}</p>
            <p className={styles.channelValue}>
              <span className={styles.icon} dangerouslySetInnerHTML={{ __html: smsSvg }} />
              <span>
                <span className={styles.strong}>{t.sMS.sms}</span>
                <span className={styles.at}>{t.sMS.at}</span>
                <span className={styles.strong}>+966 55 333 4444</span>
              </span>
            </p>
          </div>

          <div className={styles.codeInputs}>
            <span className={styles.codeInput} />
            <span className={styles.codeInput} />
            <span className={styles.codeInput} />
            <span className={styles.codeInput} />
            <span className={styles.codeInput} />
            <span className={styles.codeInput} />
          </div>

          <p className={styles.resend}>
            <span className={styles.resendRun}>{t.sMS.resendIn}</span>
            <span className={styles.strongCaption}>{t.sMS._29Seconds}</span>
          </p>
        </div>
      </div>
    </main>
  )
}
