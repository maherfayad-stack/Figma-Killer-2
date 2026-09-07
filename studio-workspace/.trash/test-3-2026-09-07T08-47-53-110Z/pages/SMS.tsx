import { BottomSheet } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import chatIcon from '@alm-design/design-system/src/icons/line-icons/chat.svg?raw'
import chevronLeftRaw from '@alm-design/design-system/src/icons/line-icons/chevronLeft.svg?raw'
import styles from './SMS.module.css'
import { useLanguage } from '../src/i18n/LanguageContext'

export default function SMS() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <BottomSheet open size="fullscreen" platform="ios">
        <div className={styles.wrapper}>
          <div className={styles.body}>
            <div className={styles.header}>
              <button type="button" className={styles.backBtn} aria-label={t.sMS.back}>
                <span className={styles.iconSm} dangerouslySetInnerHTML={{ __html: chevronLeftRaw }} />
              </button>
              <h1 className={styles.title}>{t.sMS.enterVerificationCode}</h1>
            </div>
            <div className={styles.hint}>
              <p className={styles.hintLine}>{t.sMS.enterThe6DigitCode}</p>
              <div className={styles.hintChannel}>
                <span className={styles.channelIcon} dangerouslySetInnerHTML={{ __html: chatIcon }} />
                <span>{t.sMS.smsAt96655333}</span>
              </div>
            </div>
            <div className={styles.codeRow}>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
              <div className={styles.codeBox}>{t.sMS.nbsp}</div>
            </div>
            <p className={styles.resend}>
              <span className={styles.resendPrefix}>{t.sMS.resendIn}</span>
              <span className={styles.resendCount}>{t.sMS._29Seconds}</span>
            </p>
          </div>

          <div className={styles.keypad}>
            <div className={styles.key}>1</div>
            <div className={styles.key}>2</div>
            <div className={styles.key}>3</div>
            <div className={styles.key}>4</div>
            <div className={styles.key}>5</div>
            <div className={styles.key}>6</div>
            <div className={styles.key}>7</div>
            <div className={styles.key}>8</div>
            <div className={styles.key}>9</div>
            <div className={styles.keyGhost} />
            <div className={styles.key}>0</div>
            <div className={styles.keyBackspace}>{t.sMS.backspace}</div>
          </div>
        </div>
      </BottomSheet>
    </main>
  )
}
