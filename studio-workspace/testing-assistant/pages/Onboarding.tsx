import { Button } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import smsIconSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import chartIconSvg from '@alm-design/design-system/src/icons/line-icons/chartLineDown.svg?raw'
import lightningIconSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import discountIconSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import almosaferLogoSvg from '@alm-design/design-system/src/icons/logo/Type=AppLogo, Variant=Colour, LA=EN.svg?raw'
import styles from './Onboarding.module.css'

export default function Onboarding() {
  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <div className={styles.hero}>
          <div className={styles.heroPhone}>
            <div className={styles.heroPhoneNotch} />
            <div className={styles.heroPhoneDay}>Sunday, March 10</div>
            <div className={styles.heroPhoneTime}>9:41</div>
          </div>
          <div className={styles.heroNotification}>
            <span
              className={styles.heroNotificationLogo}
              dangerouslySetInnerHTML={{ __html: almosaferLogoSvg }}
            />
            <div className={styles.heroNotificationBody}>
              <div className={styles.heroNotificationHeader}>
                <span className={styles.heroNotificationTitle}>Almosafer</span>
                <span className={styles.heroNotificationTime}>9:41 AM</span>
              </div>
              <div className={styles.heroNotificationText}>
                Good news! A few hotels you were interested in just had a 30% price drop
              </div>
            </div>
          </div>
        </div>

        <h1 className={styles.title}>
          Complete your setup.
          <br />
          Don&rsquo;t miss out on:
        </h1>

        <div className={styles.featureList}>
          <div className={styles.featureRow}>
            <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: smsIconSvg }} />
            <span className={styles.featureLabel}>Unique rates via WhatsApp, email, and SMS!</span>
          </div>
          <div className={styles.featureRow}>
            <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: chartIconSvg }} />
            <span className={styles.featureLabel}>Price drops before they are gone</span>
          </div>
          <div className={styles.featureRow}>
            <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: lightningIconSvg }} />
            <span className={styles.featureLabel}>Flash sales</span>
          </div>
          <div className={styles.featureRow}>
            <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: discountIconSvg }} />
            <span className={styles.featureLabel}>Offers picked for you</span>
          </div>
        </div>

        <div className={styles.actions}>
          <div className={styles.agreeButton}>
            <Button variant="primary" label="Agree" />
          </div>
          <button type="button" className={styles.maybeLater}>Maybe later</button>
        </div>

        <p className={styles.terms}>
          By clicking Agree, I consent to receiving communications and acknowledge the{' '}
          <a className={styles.termsLink} href="#">privacy policy</a>, and{' '}
          <a className={styles.termsLink} href="#">terms and conditions</a> You can opt-out anytime.
        </p>
      </div>
    </main>
  )
}
